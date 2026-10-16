import * as THREE from 'three';
import { hasId } from '../api/ApiClient.js';

/**
 * ColliBoy - Split mode for a single selected object: positions and rotates
 * the cutting plane (by direct drag or hand-edited panel fields), previews
 * the resulting pieces live, and confirms the cut against the backend.
 */
export class SplitMode {
    constructor(app) {
        this.app = app;

        // Split-mode state, populated while the SPLIT panel is active
        this._splitState = null;   // shape: { sessionId, objectId, originalObject, bbox: { min, max } }
        this.behavior = 'move';  // 'move' or 'rotate': the drag behavior the SPLIT panel currently uses
        this._splitPreviewTimer = null;
        this._splitPreviewInFlight = null; // promise of the preview request still running, if one exists
        this._lastSplitPreviewResult = null; // latest successful preview result for the plane's current position
    }

    /**
     * True while split mode is active - i.e. the SPLIT panel is open on an object.
     */
    isActive() {
        return this._splitState !== null;
    }

    /**
     * Registers split mode's event listeners (the SPLIT panel entry and its
     * control events, plus Enter-to-confirm) and sets up the cutting-plane
     * drag and the toolbar guard.
     */
    init() {
        const app = this.app;
        const ui = app.ui;
        const scene = app.sceneController;

        // Enter confirms the split; Escape (via 'cancel') exits without cutting.
        // Enter presses inside text inputs are ignored, not treated as confirm.
        document.addEventListener('keydown', (e) => {
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
            if (e.key === 'Enter' && this._splitState) {
                e.preventDefault();
                this._confirmSplit();
            }
        });

        ui.on('split', async () => {
            const selectedIds = scene.getSelectedObjectIds();
            if (selectedIds.length > 1) {
                app._showAlert('Split only works on a single object - select just one shape.');
                return;
            }

            // Authoritative selection source; scene.selectedObject can hold a
            // stale id no longer present in scene.objects.
            const targetId = selectedIds[0];
            if (!targetId) {
                app._showAlert('Select an object to split.');
                return;
            }

            if (app._warnIfNotSolid([targetId], 'split this shape')) return;

            const backendInfoBefore = app.backendIds.get(targetId);
            if (!backendInfoBefore || !hasId(backendInfoBefore.objectId)) {
                app._showAlert('Cannot split: object has no backend ID. Re-import the file.');
                return;
            }

            // Sync any pending client-side transform to the backend first -
            // including the import-time snap-to-floor offset, which only touches
            // the frontend object - so the cutting plane (derived from the
            // frontend bounding box) matches what the backend cuts. Mirrors
            // Union/Subtract/Intersect above.
            await app._commitTransforms([targetId]);

            // _commitTransforms may swap in a replacement object, so re-resolve
            // the id from the current selection rather than trusting targetId.
            const currentSelected = scene.getSelectedObjectIds();
            const resolvedId = currentSelected.includes(targetId) ? targetId : currentSelected[0];
            if (!resolvedId) {
                app._showAlert('Cannot split: could not re-select the object after syncing its position. Try again.');
                return;
            }

            const backendInfo = app.backendIds.get(resolvedId);
            if (!backendInfo || !hasId(backendInfo.objectId)) {
                app._showAlert('Cannot split: object has no backend ID. Re-import the file.');
                return;
            }

            const bbox = scene.getBoundingBox(resolvedId);
            if (!bbox) {
                console.error(`Split: no bounding box for selected object "${resolvedId}" - it may not be in scene.objects.`);
                app._showAlert('Cannot split: could not measure the selected object. Try re-selecting it.');
                return;
            }

            this._enterSplitMode(resolvedId, backendInfo, bbox);
        });

        ui.on('setSplitMode', (mode) => {
            if (!this._splitState) return;
            this.behavior = mode;
            app.ui.setSplitModeButtons(mode);
        });

        ui.on('splitCancel', () => this.cancel());
        ui.on('splitConfirm', () => this._confirmSplit());

        // Split-panel Move/Rotate value inputs - commits an edited X/Y/Z field
        // straight into the cutting plane.
        ui.on('splitPlaneValueChange', (kind, axis, rawValue) => {
            this._applySplitPlaneValue(kind, axis, rawValue);
        });

        // Split-panel value inputs - re-syncs all fields (e.g. after an Escape cancel)
        ui.on('refreshSplitPanel', () => {
            this._refreshSplitPanelInputs();
        });

        this._initSplitPlaneDrag();
        this._initSplitToolbarGuard();
    }

    /**
     * Enters split mode directly (no modal) on the given single object. It
     * centers the cutting plane on the object's bounding box, disables the
     * bottom Move/Rotate/Scale buttons, and shows the SPLIT panel. Dragging
     * the plane itself is handled by _initSplitPlaneDrag().
     */
    _enterSplitMode(targetId, backendInfo, bbox) {
        const app = this.app;
        const cp = app.cuttingPlane;

        const bboxMin = new THREE.Vector3(bbox.minX, bbox.minY, bbox.minZ);
        const bboxMax = new THREE.Vector3(bbox.maxX, bbox.maxY, bbox.maxZ);

        this._splitState = {
            sessionId: backendInfo.sessionId || app.sessionId,
            objectId: backendInfo.objectId,
            originalObject: targetId,
            bbox: { min: bboxMin, max: bboxMax },
        };
        this.behavior = 'move';
        this._splitPreviewTimer = null;
        this._splitPreviewInFlight = null;
        this._lastSplitPreviewResult = null;

        // Detach the normal object gizmo and gray out the bottom transform buttons
        app.transformGizmo.setEnabled(false);
        app.transformGizmo.detach();
        app.ui.setTransformButtonsDisabled(true);

        // Position and orient the cutting plane on the selected object
        cp.setAxis('y');
        cp.setPosition(bbox.centerX, bbox.centerY, bbox.centerZ);
        cp.fitToBoundingBox(bboxMin, bboxMax);
        cp.setVisible(true);

        // Show the SPLIT panel, defaulting to Move
        app.ui.setSplitModeButtons('move');
        app.ui.showSplitPanel(true);
        this._refreshSplitPanelInputs();

        // Previews are read-only, so fire one immediately on entry - shows
        // where the default (centered) cut lands before any dragging.
        this._runSplitPreview();
    }

    /**
     * Writes the cutting plane's current position and rotation into the SPLIT
     * panel's Move/Rotate X/Y/Z inputs. It's called when entering split mode,
     * after every plane drag, and after committing a hand-edited field.
     */
    _refreshSplitPanelInputs() {
        if (!this._splitState) return;
        const app = this.app;
        const cp = app.cuttingPlane;
        app.ui.setSplitPlaneValues(
            cp.planeMesh.position,
            {
                x: THREE.MathUtils.radToDeg(cp.planeMesh.rotation.x),
                y: THREE.MathUtils.radToDeg(cp.planeMesh.rotation.y),
                z: THREE.MathUtils.radToDeg(cp.planeMesh.rotation.z),
            }
        );
    }

    /**
     * Applies a hand-edited X/Y/Z value from the SPLIT panel to the cutting
     * plane, mirroring _initSplitPlaneDrag: position/rotation are set directly
     * (cp.setPosition()/setAxis() would snap back to an axis-aligned preset),
     * and the center stays clamped inside the shape's bounding box.
     */
    _applySplitPlaneValue(kind, axis, rawValue) {
        if (!this._splitState) return;

        const value = parseFloat(rawValue);
        if (Number.isNaN(value)) {
            this._refreshSplitPanelInputs();
            return;
        }

        const app = this.app;
        const cp = app.cuttingPlane;

        if (kind === 'move') {
            const next = cp.planeMesh.position.clone();
            next[axis] = value;

            const { min, max } = this._splitState.bbox;
            next.x = THREE.MathUtils.clamp(next.x, min.x, max.x);
            next.y = THREE.MathUtils.clamp(next.y, min.y, max.y);
            next.z = THREE.MathUtils.clamp(next.z, min.z, max.z);

            cp.planeMesh.position.copy(next);
            cp.position.copy(next);
        } else if (kind === 'rotate') {
            // Same Euler-entanglement issue as the drag handler: rotate
            // incrementally around a world axis instead of writing the Euler
            // component directly.
            const currentDeg = THREE.MathUtils.radToDeg(cp.planeMesh.rotation[axis]);
            const deltaRad = THREE.MathUtils.degToRad(value - currentDeg);
            cp.rotateAroundWorldAxis(axis, deltaRad);
        }

        this._refreshSplitPanelInputs();
        this._debouncedSplitPreview();
    }

    /**
     * Exits split mode without applying the cut. It restores the normal gizmo
     * to the shape that was being split (if it's still selected) and
     * re-enables the bottom transform buttons.
     */
    cancel() {
        const app = this.app;
        if (!this._splitState) return;
        const scene = app.sceneController;
        const cp = app.cuttingPlane;

        if (this._splitPreviewTimer) {
            clearTimeout(this._splitPreviewTimer);
            this._splitPreviewTimer = null;
        }
        this._splitPreviewInFlight = null;
        this._lastSplitPreviewResult = null;

        cp.hidePreview();
        cp.setVisible(false);

        const targetId = this._splitState.originalObject;
        this._splitState = null;

        app.ui.showSplitPanel(false);
        app.ui.setTransformButtonsDisabled(false);

        // Restore the normal gizmo if the split target is still selected
        if (scene.selectedObject === targetId || scene.getSelectedObjectIds().includes(targetId)) {
            const obj = scene.objects.get(targetId);
            if (obj) {
                app.transformGizmo.setMode(app._transformMode === 'move' ? 'translate' : (app._transformMode || 'scale'));
                app.transformGizmo.setEnabled(true);
                app.transformGizmo.attach(obj);
            }
        }
    }

    /**
     * Applies the split at the cutting plane's current position and
     * orientation, replacing the original object with the two resulting pieces.
     */
    async _confirmSplit() {
        const app = this.app;
        if (!this._splitState) return;
        const scene = app.sceneController;
        const ui = app.ui;
        const cp = app.cuttingPlane;
        const state = this._splitState;

        // Previews are read-only, so this is the one call that actually cuts
        // and consumes state.objectId - cutting the real object (not a preview's
        // throwaway ids) keeps the session store in sync for undo.
        if (this._splitPreviewTimer) {
            clearTimeout(this._splitPreviewTimer);
            this._splitPreviewTimer = null;
        }

        ui.showLoading('Splitting model...');

        try {
            const normal = cp.getNormal();
            const offset = cp.planeMesh.position.dot(normal);

            const result = await app.api.post('/geometry/cut', {
                session_id: state.sessionId,
                object_id: state.objectId,
                normal: [normal.x, normal.y, normal.z],
                origin_offset: offset,
            });

            if (!result || !result.pieces) {
                throw new Error('Could not compute a cut at the current plane position.');
            }

            // Tear down split mode only after a successful cut; on failure the
            // catch block leaves the plane and panel intact for another attempt.
            app.ui.showSplitPanel(false);
            scene.removeObject(state.originalObject);
            app.backendIds.delete(state.originalObject);
            cp.hidePreview();
            cp.setVisible(false);

            for (const piece of result.pieces) {
                const frontendId = app.meshSync.loadFromServer(piece);
                if (hasId(frontendId) && hasId(piece.id)) {
                    app.backendIds.set(frontendId, { sessionId: state.sessionId, objectId: piece.id });
                }
            }

            // New piece meshes load with plain "normal" material settings, so
            // reapply the active view mode - otherwise pieces in wireframe or
            // transparent modes would pop back to default until toggled again.
            if (scene.viewMode !== 'normal') {
                scene.setViewMode(scene.viewMode);
            }

            scene.resetView();

            this._splitState = null;
            this._lastSplitPreviewResult = null;
            app.ui.setTransformButtonsDisabled(false);
        } catch (err) {
            console.error('Split failed:', err);
            app._showAlert(`Split failed: ${err.message}`);
            // Stay in split mode on failure; the plane and panel remain usable.
        } finally {
            ui.hideLoading();
        }
    }

    /**
     * Debounced live preview of the split result at the cutting plane's current
     * position and orientation. It mirrors the old cut-preview logic but reads
     * the normal directly off the plane mesh, so it stays correct through free
     * rotation - not just axis-aligned cuts.
     */
    _debouncedSplitPreview() {
        // Invalidate the cached result; it no longer matches the current cut.
        this._lastSplitPreviewResult = null;

        if (this._splitPreviewTimer) clearTimeout(this._splitPreviewTimer);
        this._splitPreviewTimer = setTimeout(() => {
            this._splitPreviewTimer = null;
            this._splitPreviewInFlight = this._runSplitPreview();
        }, 200);
    }

    async _runSplitPreview() {
        const app = this.app;
        const state = this._splitState;
        const cp = app.cuttingPlane;
        if (!state) return;

        try {
            const normal = cp.getNormal();
            const offset = cp.planeMesh.position.dot(normal);

            // /geometry/cut in preview mode is read-only - no session store or
            // history changes, so it's safe on state.objectId during dragging;
            // only _confirmSplit() performs the consuming cut.
            const result = await app.api.post('/geometry/cut', {
                session_id: state.sessionId,
                object_id: state.objectId,
                normal: [normal.x, normal.y, normal.z],
                origin_offset: offset,
                preview: true,
            });

            // Ignore responses arriving after cancel/confirm or a new session.
            if (this._splitState !== state) return;

            if (result && result.pieces) {
                // Piece positions are correct by construction (cut in place), so
                // cache them for the preview render; _confirmSplit() does its own
                // authoritative cut and ignores these ids.
                this._lastSplitPreviewResult = result;
                cp.showPreview(result.pieces[0], result.pieces[1]);
            } else {
                this._lastSplitPreviewResult = null;
                cp.hidePreview();
            }
        } catch (err) {
            console.error('Split preview failed:', err);
            this._lastSplitPreviewResult = null;
            cp.hidePreview();
        } finally {
            this._splitPreviewInFlight = null;
        }
    }

    /**
     * Cutting-plane dragging, scoped to split mode and reusing _initAxisDrag's
     * screen-projected, axis-locked behavior (deadzone, then one locked axis).
     * Move locks the plane's own normal; Rotate locks the world axis perpendicular
     * to the drag. The center stays clamped inside the shape's bounding box.
     */
    _initSplitPlaneDrag() {
        const app = this.app;
        const scene = app.sceneController;
        const canvas = document.getElementById('viewport-canvas');
        const container = app.ui.viewportContainer;
        const cp = app.cuttingPlane;

        const DEADZONE_PX = 6;
        const ROTATE_RAD_PER_PIXEL = 0.004;

        const raycaster = new THREE.Raycaster();
        let drag = null;

        const screenPointFor = (worldPos, rect) => {
            const v = worldPos.clone().project(scene.camera);
            return {
                x: (v.x * 0.5 + 0.5) * rect.width,
                y: (-v.y * 0.5 + 0.5) * rect.height,
            };
        };

        const computeAxisScreenVectors = (origin, rect) => {
            const originScreen = screenPointFor(origin, rect);
            const vectors = {};
            for (const axis of ['x', 'y', 'z']) {
                const offset = new THREE.Vector3();
                offset[axis] = 1;
                const axisScreen = screenPointFor(origin.clone().add(offset), rect);
                vectors[axis] = { x: axisScreen.x - originScreen.x, y: axisScreen.y - originScreen.y };
            }
            return vectors;
        };

        const pickedPlane = (clientX, clientY) => {
            const rect = canvas.getBoundingClientRect();
            const mouse = new THREE.Vector2(
                ((clientX - rect.left) / rect.width) * 2 - 1,
                -((clientY - rect.top) / rect.height) * 2 + 1
            );
            raycaster.setFromCamera(mouse, scene.camera);
            const hits = raycaster.intersectObjects([cp.planeMesh, cp.handle], true);
            return hits.length > 0;
        };

        container.addEventListener('pointerdown', (e) => {
            if (!this._splitState) return;
            if (!canvas.contains(e.target)) return;
            if (e.button !== 0) return;
            if (!pickedPlane(e.clientX, e.clientY)) return;

            drag = {
                mode: this.behavior,
                origin: cp.planeMesh.position.clone(),
                startClient: { x: e.clientX, y: e.clientY },
                locked: false,
                worldAxis: null,
                axisScreenVec: null,
                startPosition: cp.planeMesh.position.clone(),
                startQuaternion: cp.planeMesh.quaternion.clone(),
            };

            try { canvas.setPointerCapture(e.pointerId); } catch {}

            // Keep this gesture from reaching OrbitControls or viewport selection.
            e.stopPropagation();
            e.preventDefault();
        }, true);

        container.addEventListener('pointermove', (e) => {
            if (!drag) return;

            const dxTotal = e.clientX - drag.startClient.x;
            const dyTotal = e.clientY - drag.startClient.y;

            if (!drag.locked) {
                const dist = Math.sqrt(dxTotal * dxTotal + dyTotal * dyTotal);
                if (dist < DEADZONE_PX) {
                    e.stopPropagation();
                    e.preventDefault();
                    return;
                }

                const rect = canvas.getBoundingClientRect();

                if (drag.mode === 'move') {
                    // The plane's only meaningful motion axis is its own normal -
                    // sliding within its face doesn't change the cut, so no world
                    // x/y/z search like for shapes.
                    const normal = cp.getNormal().clone();
                    drag.moveAxis = normal;
                    drag.axisScreenVec = (() => {
                        const originScreen = screenPointFor(drag.origin, rect);
                        const normalScreen = screenPointFor(drag.origin.clone().add(normal), rect);
                        return { x: normalScreen.x - originScreen.x, y: normalScreen.y - originScreen.y };
                    })();
                } else {
                    // Rotate around the world axis perpendicular to the drag.
                    const screenAxis = Math.abs(dxTotal) >= Math.abs(dyTotal) ? 'x' : 'y';
                    const scoreAxis = screenAxis === 'x' ? 'y' : 'x';

                    const projections = computeAxisScreenVectors(drag.origin, rect);

                    let bestAxis = null;
                    let bestScore = -1;
                    for (const axis of ['x', 'y', 'z']) {
                        const v = projections[axis];
                        const component = scoreAxis === 'x' ? Math.abs(v.x) : Math.abs(v.y);
                        if (component > bestScore) {
                            bestScore = component;
                            bestAxis = axis;
                        }
                    }

                    drag.worldAxis = bestAxis;
                    drag.axisScreenVec = projections[bestAxis];
                }
                drag.locked = true;
            }

            const v = drag.axisScreenVec;
            const lenSq = v.x * v.x + v.y * v.y;
            if (lenSq < 1e-6) {
                e.stopPropagation();
                e.preventDefault();
                return;
            }

            if (drag.mode === 'move') {
                // Projects the drag delta onto the normal's own screen-space direction,
                // sliding the plane strictly along that normal.
                const dot = dxTotal * v.x + dyTotal * v.y;
                const amount = dot / lenSq;

                const next = drag.startPosition.clone().addScaledVector(drag.moveAxis, amount);

                // Keeps the split plane's center inside the selected shape's
                // bounding box.
                if (this._splitState) {
                    const { min, max } = this._splitState.bbox;
                    next.x = THREE.MathUtils.clamp(next.x, min.x, max.x);
                    next.y = THREE.MathUtils.clamp(next.y, min.y, max.y);
                    next.z = THREE.MathUtils.clamp(next.z, min.z, max.z);
                }

                cp.planeMesh.position.copy(next);
                cp.position.copy(next);
            } else {
                const tangent = { x: -v.y, y: v.x };
                const dot = dxTotal * tangent.x + dyTotal * tangent.y;
                const pixelsAlongTangent = dot / Math.sqrt(lenSq);
                const angle = pixelsAlongTangent * ROTATE_RAD_PER_PIXEL;

                // `angle` is total rotation since drag start, re-derived each move
                // from the start quaternion - never accumulated or written as Euler
                // components.
                cp.rotateAroundWorldAxis(drag.worldAxis, angle, drag.startQuaternion);
            }

            this._debouncedSplitPreview();
            this._refreshSplitPanelInputs();
            e.stopPropagation();
            e.preventDefault();
        }, true);

        const endDrag = (e) => {
            if (!drag) return;
            drag = null;
            if (e) {
                e.stopPropagation();
                e.preventDefault();
            }
        };

        container.addEventListener('pointerup', endDrag, true);
        container.addEventListener('pointercancel', endDrag, true);
    }

    /**
     * Toolbar clicks (including the hamburger dropdown, nested in the toolbar)
     * cancel split mode instead of running their own action; the capture phase
     * keeps the click from reaching the button's bubble-phase listener.
     */
    _initSplitToolbarGuard() {
        const toolbar = document.getElementById('toolbar');
        if (!toolbar) return;

        toolbar.addEventListener('click', (e) => {
            if (!this._splitState) return;
            this.cancel();
            e.stopPropagation();
            e.preventDefault();
        }, true);
    }
}
