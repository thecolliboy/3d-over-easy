import * as THREE from 'three';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { hasId } from '../api/ApiClient.js';

/**
 * ColliBoy - Loads meshes returned by backend operations into the scene and
 * swaps existing objects in place with their freshly computed server geometry,
 * carrying over selection/gizmo context; also kicks off LOD generation for
 * dense meshes.
 */
export class MeshSync {
    constructor(app) {
        this.app = app;
    }

    /**
     * Load a mesh returned from the backend into the scene.
     *
     * @param {object} objData - server object data (vertices/indices/normals/colors/id)
     * @param {object} [options]
     * @param {boolean} [options.snapToFloor=false] - Only true for genuinely new
     *   content (fresh imports, new primitives). Anything that replaces an
     *   existing object - transform commits, union/subtract/intersect,
     *   split pieces, simplify/repair, undo/redo - must preserve whatever
     *   position the backend returned instead of re-snapping to the build
     *   plate, otherwise the object visibly jumps back to the floor.
     * @param {THREE.Color} [options.color] - Reuse this color instead of
     *   generating a new one, so replacing an object (e.g. after a
     *   transform) doesn't change its color.
     */
    loadFromServer(objData, options = {}) {
        const app = this.app;
        const { snapToFloor = false, color = null, testHollow = false } = options;
        if (!objData || !objData.vertices) return null;

        const vertices = new Float32Array(objData.vertices);
        // Use Uint32Array (not Uint16Array) - CSG results in particular can
        // easily exceed 65,536 vertices, and a 16-bit index array silently
        // wraps around and corrupts the geometry instead of erroring.
        const indices = objData.indices ? new Uint32Array(objData.indices) : null;
        const normals = objData.normals ? new Float32Array(objData.normals) : null;
        const hasVertexColors = !!(objData.colors && objData.colors.length > 0);

        let geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
        if (normals) {
            geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
        }
        if (indices) {
            geometry.setIndex(new THREE.BufferAttribute(indices, 1));
        }
        if (hasVertexColors) {
            const colors = new Float32Array(objData.colors);
            geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
        }

        // Weld coincident vertices before computing normals. Server data
        // isn't guaranteed to share vertices across adjacent triangles -
        // raw/unindexed import data in particular (e.g. triangle-soup STL
        // straight off disk) duplicates a vertex for every face that
        // touches it, so there's nothing for computeVertexNormals() to
        // average across and smooth shading ends up looking identical to
        // flat no matter what the material's flatShading flag says.
        // Welding first (attributes and all, so vertex colors stay
        // aligned) makes smooth shading actually possible on every load
        // path - not just ones that happen to already come back indexed/
        // welded, like transform-commit results from the mesh-editing
        // kernel, which is why the toggle only ever "worked" after moving
        // an object once.
        try {
            const welded = mergeVertices(geometry);
            if (welded) {
                geometry.dispose();
                geometry = welded;
            }
        } catch (err) {
            console.warn('Vertex welding failed - continuing with unwelded geometry:', err);
        }
        geometry.computeVertexNormals();

        // Build the material for this mesh - per-vertex coloring when the source data carries it, otherwise a single flat base tone.
        let material;
        if (hasVertexColors) {
            material = new THREE.MeshStandardMaterial({
                vertexColors: true,
                roughness: 0.5,
                metalness: 0.1,
            });
        } else {
            // Reuse the previous color if one was passed in (e.g. this load
            // is replacing an object after a transform/simplify/etc., not
            // introducing new content); otherwise generate a nice,
            // evenly-spread color for this new object.
            material = new THREE.MeshStandardMaterial({
                color: color || app._nextObjectColor(),
                roughness: 0.5,
                metalness: 0.1,
            });
        }

        const mesh = new THREE.Mesh(geometry, material);
        const frontendId = hasId(objData.id) ? objData.id : `obj_${Date.now()}`;
        mesh.name = frontendId;

        // Solid indicator (shown in the properties panel as "Solid: Yes/No").
        // A shape is NOT solid when its surface isn't watertight (it has
        // open boundary edges/holes) - the same condition that makes CSG
        // ops (Split/Merge/Subtract/Intersect) fail until repaired via the
        // Solid/Repair tools. Only imported/opened models are actually
        // tested - primitives and CSG results are assumed solid, since the
        // engine only ever produces closed geometry for those.
        mesh.userData.isSolid = testHollow ? !app.sceneController.detectHollow(geometry) : true;

        // Center and snap to build plate - only for genuinely new content.
        // Replacement loads (transform commits, boolean ops, split, undo/
        // redo, etc.) already carry the position they should have.
        if (snapToFloor) {
            app._snapToBuildPlate(mesh);
        }

        app.sceneController.addObject(mesh, frontendId);
        app._updateBuildPlateExtent();

        // Kick off level-of-detail generation once a mesh is dense enough to warrant the server round-trip (~1000+ faces).
        const faceCount = indices ? indices.length / 3 : vertices.length / 3;
        if (faceCount > 1000 && app.sessionId) {
            this.computeLodForObject(frontendId, app.sessionId);
        }

        return frontendId;
    }

    /**
     * Detect physically disconnected pieces within a single mesh's geometry
     * and, if there's more than one, split it into a set of standalone
     * piece descriptors - one per connected group of triangles - in the
     * same { vertices, indices, normals, colors } shape _loadMeshFromServer
     * expects (world-space vertices, so the resulting meshes need no
     * position/rotation/scale of their own).
     *
     * "Connected" is determined by shared vertex position (within a small
     * tolerance), not shared vertex index - this correctly reunites seams
     * where the same point appears as separate, duplicated vertices (e.g.
     * for hard-edge normals), while still treating two shapes that merely
     * touch at a single coincident point as connected, matching how a
     * physical, watertight print would behave.
     *
     * Returns null if the mesh has zero or one connected piece (i.e.
     * there's nothing to separate).
     */
    _findConnectedComponents(mesh) {
        const geometry = mesh.geometry;
        const posAttr = geometry.getAttribute('position');
        if (!posAttr) return null;
        const normalAttr = geometry.getAttribute('normal');
        const colorAttr = geometry.getAttribute('color');
        const index = geometry.getIndex();

        const vertexCount = posAttr.count;
        const triangles = [];
        if (index) {
            const arr = index.array;
            for (let i = 0; i + 2 < arr.length; i += 3) {
                triangles.push([arr[i], arr[i + 1], arr[i + 2]]);
            }
        } else {
            for (let i = 0; i + 2 < vertexCount; i += 3) {
                triangles.push([i, i + 1, i + 2]);
            }
        }
        if (triangles.length === 0) return null;

        // Canonicalize vertices by (rounded) position so coincident points
        // sharing the same location - regardless of vertex index - are
        // treated as the same node for connectivity purposes.
        const PRECISION = 1e5; // merges points within ~0.00001 units
        const canonicalId = new Map();
        const originalToCanonical = new Int32Array(vertexCount);
        for (let i = 0; i < vertexCount; i++) {
            const key = `${Math.round(posAttr.getX(i) * PRECISION)}_${Math.round(posAttr.getY(i) * PRECISION)}_${Math.round(posAttr.getZ(i) * PRECISION)}`;
            let cid = canonicalId.get(key);
            if (cid === undefined) {
                cid = canonicalId.size;
                canonicalId.set(key, cid);
            }
            originalToCanonical[i] = cid;
        }

        // Union-find over canonical vertex ids.
        const parent = new Int32Array(canonicalId.size);
        for (let i = 0; i < parent.length; i++) parent[i] = i;
        const find = (x) => {
            while (parent[x] !== x) {
                parent[x] = parent[parent[x]];
                x = parent[x];
            }
            return x;
        };
        const union = (a, b) => {
            const ra = find(a), rb = find(b);
            if (ra !== rb) parent[ra] = rb;
        };
        for (const [a, b, c] of triangles) {
            union(originalToCanonical[a], originalToCanonical[b]);
            union(originalToCanonical[b], originalToCanonical[c]);
        }

        // Group triangles by their component's root.
        const groups = new Map();
        for (const tri of triangles) {
            const root = find(originalToCanonical[tri[0]]);
            let group = groups.get(root);
            if (!group) {
                group = [];
                groups.set(root, group);
            }
            group.push(tri);
        }

        if (groups.size <= 1) return null;

        // Bake this mesh's world transform into vertex positions/normals so
        // each piece can be loaded as a standalone object with no transform
        // of its own, exactly matching the convention _loadMeshFromServer
        // already assumes for server-provided geometry.
        mesh.updateMatrixWorld(true);
        const normalMatrix = new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld);
        const v = new THREE.Vector3();
        const n = new THREE.Vector3();

        const pieces = [];
        for (const tris of groups.values()) {
            const remap = new Map();
            const positions = [];
            const normals = normalAttr ? [] : null;
            const colors = colorAttr ? [] : null;
            const outIndices = [];

            for (const tri of tris) {
                for (const origIdx of tri) {
                    let newIdx = remap.get(origIdx);
                    if (newIdx === undefined) {
                        newIdx = positions.length / 3;
                        remap.set(origIdx, newIdx);

                        v.set(posAttr.getX(origIdx), posAttr.getY(origIdx), posAttr.getZ(origIdx));
                        v.applyMatrix4(mesh.matrixWorld);
                        positions.push(v.x, v.y, v.z);

                        if (normals) {
                            n.set(normalAttr.getX(origIdx), normalAttr.getY(origIdx), normalAttr.getZ(origIdx));
                            n.applyMatrix3(normalMatrix).normalize();
                            normals.push(n.x, n.y, n.z);
                        }
                        if (colors) {
                            colors.push(colorAttr.getX(origIdx), colorAttr.getY(origIdx), colorAttr.getZ(origIdx));
                        }
                    }
                    outIndices.push(newIdx);
                }
            }

            pieces.push({
                vertices: positions,
                indices: outIndices,
                normals: normals || undefined,
                colors: colors || undefined,
            });
        }

        return pieces;
    }

    async computeLodForObject(frontendId, sessionId) {
        const app = this.app;
        const backendInfo = app.backendIds.get(frontendId);
        if (!backendInfo || !hasId(backendInfo.objectId)) return;

        try {
            const result = await app.api.computeLod(sessionId, backendInfo.objectId, 3);
            app.sceneController.setLodLevels(frontendId, result.lod_levels);
        } catch (err) {
            console.warn('LOD computation failed:', err.message);
        }
    }

    /**
     * Swap an already-placed object for freshly computed server geometry - used by
     * in-place operations (simplify, repair, rotate) that return new mesh data for
     * the same logical object. The old mesh is discarded and re-loaded; whatever
     * selection or gizmo state pointed at it is carried over to the replacement so
     * the user's context survives the swap.
     */
    replaceObject(frontendId, resultData, resetView = false, preserveCenter = false) {
        const app = this.app;
        const scene = app.sceneController;
        const wasPrimarySelected = scene.selectedObject === frontendId;
        // Multi-select membership, not just the single "primary" selected
        // object - callers like the Solid handler call this once per object
        // in a multi-selection, and the old code below used to call
        // scene.selectObject() (a single-select operation) which wiped out
        // every other selected object the first time it ran, silently
        // dropping the rest of the multi-selection.
        const wasInSelection = scene.getSelectedObjectIds().includes(frontendId);

        // Remember which backend session this specific object actually
        // lives in before its entry gets deleted below. Different objects
        // in the scene can legitimately carry different session ids (see
        // the createPrimitive fix above), so the replacement must stay
        // tagged with the object's own session - not silently reassigned
        // to whatever App.sessionId happens to be "current" right now,
        // which may belong to a completely different object.
        const oldBackendInfo = app.backendIds.get(frontendId);

        // Preserve the object's current color - this is a like-for-like
        // replacement (simplify, repair, server-side rotate, etc.), not new
        // content, so it shouldn't get reassigned a fresh color.
        const oldObj = scene.objects.get(frontendId);
        const color = (oldObj && oldObj.material && oldObj.material.color && !oldObj.material.vertexColors)
            ? oldObj.material.color.clone()
            : null;

        // Some server operations (e.g. the mesh-repair endpoint used by
        // "Solid") return geometry re-centered on the origin instead of
        // preserving the object's on-screen position. When preserveCenter
        // is set, capture the old object's world bounding-box center before
        // swapping it out, then nudge the replacement back so it visually
        // stays put instead of jumping to the center of the scene.
        let oldCenter = null;
        if (preserveCenter && oldObj) {
            const box = new THREE.Box3().setFromObject(oldObj);
            if (!box.isEmpty()) oldCenter = box.getCenter(new THREE.Vector3());
        }

        // Drop the outgoing mesh from both the live scene graph and the frontend→backend id table.
        scene.removeObject(frontendId);
        app.backendIds.delete(frontendId);

        // Rebuild the replacement mesh from the server payload (reusing the preserved color).
        const newFrontendId = this.loadFromServer(resultData, { color });

        if (oldCenter) {
            const newObj = scene.objects.get(newFrontendId);
            if (newObj) {
                const newBox = new THREE.Box3().setFromObject(newObj);
                if (!newBox.isEmpty()) {
                    const newCenter = newBox.getCenter(new THREE.Vector3());
                    newObj.position.x += oldCenter.x - newCenter.x;
                    newObj.position.y += oldCenter.y - newCenter.y;
                    newObj.position.z += oldCenter.z - newCenter.z;
                }
            }
        }

        if (hasId(resultData.id)) {
            app.backendIds.set(newFrontendId, {
                sessionId: (oldBackendInfo && oldBackendInfo.sessionId) || app.sessionId,
                objectId: resultData.id,
            });
        }

        // Restore selection if it was selected before - add back into
        // whatever selection currently exists rather than replacing it, so
        // replacing one object out of a multi-selection doesn't deselect
        // the others.
        if (wasInSelection) {
            scene.addToSelection(newFrontendId);
            if (wasPrimarySelected) {
                scene.selectedObject = newFrontendId;
            }
            app._updatePropertiesForSelected();

            // If a transform gizmo was attached to the old mesh, re-point it at the replacement so an in-progress drag/rotate isn't dropped.
            const mode = app.transformGizmo.enabled ? app.transformGizmo.mode : null;
            if (mode) {
                app.transformGizmo.setMode(mode);
                app.transformGizmo.setEnabled(true);
                const obj = scene.objects.get(newFrontendId);
                if (obj) app.transformGizmo.attach(obj);
            }
        }

        // Update status bar with new mesh stats
        app._updateStatusBar();

        // Optionally reset view for operations that significantly change the model
        if (resetView) {
            scene.resetView();
        }
    }
}
