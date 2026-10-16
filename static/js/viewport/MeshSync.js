import * as THREE from 'three';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { hasId } from '../api/ApiClient.js';

/**
 * ColliBoy - Loads backend mesh payloads into the scene and swaps existing
 * objects in place with fresh server geometry (carrying over selection/gizmo
 * context); kicks off LOD generation for dense meshes.
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
     * @param {boolean} [options.snapToFloor=false] - Only for genuinely new content; replacements must keep the backend-returned position.
     * @param {THREE.Color} [options.color] - Reuse this color instead of generating a new one (e.g. after a transform).
     * @param {boolean} [options.separate=false] - Import separation (.config [import]): shift along X/Z until at least min_gap_mm clear of every existing bounding box; only meaningful with snapToFloor.
     */
    loadFromServer(objData, options = {}) {
        const app = this.app;
        const { snapToFloor = false, color = null, testHollow = false, separate = false } = options;
        if (!objData || !objData.vertices) return null;

        const vertices = new Float32Array(objData.vertices);
        // Uint32 indices: CSG results can exceed 65,536 vertices and a 16-bit index would wrap silently.
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

        // Weld coincident vertices (attributes included) before computing normals; unwelded imports duplicate vertices per face, so smooth shading would degrade to flat.
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

        // Per-vertex colors if carried by the payload; otherwise a single base tone.
        let material;
        if (hasVertexColors) {
            material = new THREE.MeshStandardMaterial({
                vertexColors: true,
                roughness: 0.5,
                metalness: 0.1,
            });
        } else {
            // Reuse the passed-in color when replacing an object; otherwise assign a fresh one.
            material = new THREE.MeshStandardMaterial({
                color: color || app._nextObjectColor(),
                roughness: 0.5,
                metalness: 0.1,
            });
        }

        const mesh = new THREE.Mesh(geometry, material);
        const frontendId = hasId(objData.id) ? objData.id : `obj_${Date.now()}`;
        mesh.name = frontendId;

        // Solid indicator ("Solid: Yes/No" in the properties panel): non-watertight surfaces fail CSG ops until repaired; only imported models are actually tested.
        mesh.userData.isSolid = testHollow ? !app.sceneController.detectHollow(geometry) : true;

        // Snap to the build plate only for genuinely new content; replacement loads keep their returned position.
        if (snapToFloor) {
            app._snapToBuildPlate(mesh);
            // Import separation (.config [import]): keep at least min_gap_mm clear of every existing bounding box.
            if (separate) app._applyImportSeparation(mesh);
        }

        app.sceneController.addObject(mesh, frontendId);
        app._updateBuildPlateExtent();

        // LOD generation for meshes dense enough to warrant the server round-trip.
        const faceCount = indices ? indices.length / 3 : vertices.length / 3;
        if (faceCount > 1000 && app.sessionId) {
            this.computeLodForObject(frontendId, app.sessionId);
        }

        return frontendId;
    }

    /**
     * Split a mesh into standalone pieces per physically disconnected group of triangles, in the same
     * { vertices, indices, normals, colors } shape loadFromServer expects (world-space vertices, no
     * transform needed). Connectivity is by shared vertex position within tolerance, not index.
     * Returns null for zero or one piece.
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

        // Canonicalize vertices by rounded position so coincident points share a node regardless of index.
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

        // Bake the world transform into vertices/normals so each piece loads as a standalone object.
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
     * Swap an existing object in place with fresh server geometry (simplify, solidify, rotate);
     * selection/gizmo state carries over to the replacement.
     */
    replaceObject(frontendId, resultData, resetView = false, preserveCenter = false) {
        const app = this.app;
        const scene = app.sceneController;
        const wasPrimarySelected = scene.selectedObject === frontendId;
        // Track full multi-select membership; a single selectObject() here would wipe the other selections.
        const wasInSelection = scene.getSelectedObjectIds().includes(frontendId);

        // Capture this object's backend session before deleting its entry; objects can carry sessions different from App.sessionId.
        const oldBackendInfo = app.backendIds.get(frontendId);

        // Preserve the current color; this is a like-for-like replacement, not new content.
        const oldObj = scene.objects.get(frontendId);
        const color = (oldObj && oldObj.material && oldObj.material.color && !oldObj.material.vertexColors)
            ? oldObj.material.color.clone()
            : null;

        // Some server ops (e.g. "Solid") return geometry re-centered on the origin; with preserveCenter, capture the old bbox center and nudge the replacement back.
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

        // Re-add to the current selection (not replace) so other selected objects stay selected.
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
