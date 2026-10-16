import * as THREE from 'three';

/**
 * ColliBoy - Direct-manipulation dragging of an already-selected shape along a
 * single world axis, plus the Move/Rotate/Scale value bar that mirrors and
 * edits its transform.
 */
export class AxisDrag {
    constructor(app) {
        this.app = app;
    }

    /**
     * Direct-manipulation dragging: in Move or Rotate mode, dragging on an
     * already-selected shape (not a gizmo handle) moves or rotates it along one
     * world axis at a time. After a small deadzone the drag snaps to a cardinal
     * screen direction; the world axis projecting most strongly onto that
     * direction locks for the rest of the gesture, with its projection's sign
     * setting the positive/negative drive.
     */
    init() {
        const app = this.app;
        const ui = app.ui;
        const scene = app.sceneController;
        const canvas = document.getElementById('viewport-canvas');
        const container = ui.viewportContainer;

        const DEADZONE_PX = 6;
        const ROTATE_RAD_PER_PIXEL = 0.004; // about 0.23° per pixel of drag along the locked axis (reduced from 0.01)

        // Smart snap - magnetic snapping while direct-dragging a shape:
        // - Move: the selection's near/far edge or center aligns with another
        //   shape's corresponding feature once within 1% of its size on that axis.
        // - Rotate: snaps to 45° increments once within 5°.
        // Both hold a small resistance margin past capture before releasing, so
        // dragging through a snap takes an extra push instead of letting go.
        const SMART_SNAP_ROTATE_STEP_DEG = 45;
        const SMART_SNAP_ROTATE_CAPTURE_DEG = 5;
        const SMART_SNAP_ROTATE_RESISTANCE_DEG = 1.5;

        let drag = null;

        const screenPointFor = (worldPos, rect) => {
            const v = worldPos.clone().project(scene.camera);
            return {
                x: (v.x * 0.5 + 0.5) * rect.width,
                y: (-v.y * 0.5 + 0.5) * rect.height,
            };
        };

        // Computes the projected screen-space vector (in pixels) that represents
        // +1 world unit along each axis, measured from the drag's origin point.
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

        container.addEventListener('pointerdown', (e) => {
            if (app.splitMode.isActive()) return;
            if (!canvas.contains(e.target)) return;
            if (e.button !== 0) return;

            const mode = app._transformMode;
            if (mode !== 'move' && mode !== 'rotate') return;

            const selectedIds = scene.getSelectedObjectIds ? scene.getSelectedObjectIds() : [];
            if (!selectedIds || selectedIds.length === 0) return;

            // If the pointer is over a transform-gizmo handle (axis arrows in
            // move, rings in rotate), let TransformControls own this gesture -
            // grabbing an arrow must drag along that exact axis, not trigger our
            // locked-axis direct drag. The controls' `axis` tracks the last hover
            // raycast over their handles.
            const tc = app.transformGizmo ? app.transformGizmo.control : null;
            if (tc && tc.enabled && tc.axis) return;

            // Take over only if the pointer landed on an already-selected shape -
            // not empty space, and not a fresh pick. A strict raycast hit wins
            // outright; otherwise fall back to the selection's enlarged invisible
            // hitboxes so a selected shape stays grabbable even when mostly
            // covered by another similarly sized shape.
            const pickedId = scene.pickObject(e.clientX, e.clientY);
            if (!(pickedId && selectedIds.includes(pickedId))) {
                const nearId = scene.pickSelectedByHitbox ? scene.pickSelectedByHitbox(e.clientX, e.clientY) : null;
                if (!nearId) return;
            }

            const objs = selectedIds.map(id => scene.objects.get(id)).filter(Boolean);
            if (objs.length === 0) return;

            const origin = new THREE.Vector3();
            let selectionBox = null;
            if (objs.length === 1) {
                origin.copy(objs[0].position);
            } else {
                const box = this._getSelectionBox3(selectedIds);
                if (box) box.getCenter(origin); else origin.copy(objs[0].position);
            }

            // For move drags, cache the selection's bounding box plus every other
            // (unselected) shape's box up front - they don't change during a drag,
            // so recomputing them per pointermove would be wasted work.
            let otherBoxes = null;
            if (mode === 'move') {
                selectionBox = this._getSelectionBox3(selectedIds);
                otherBoxes = [];
                scene.objects.forEach((obj, id) => {
                    if (selectedIds.includes(id)) return;
                    otherBoxes.push(new THREE.Box3().setFromObject(obj));
                });
            }

            // For rotate drags, cache the selection's world-space bounding-box
            // center up front (fixed for the whole drag) - this is what "rotate
            // around center" pivots around. It is generally NOT an object's own
            // position/origin: e.g. shapes resting on the build plate have their
            // origin at their base, not their visual center.
            let rotatePivotCenter = null;
            if (mode === 'rotate') {
                const box = this._getSelectionBox3(selectedIds);
                if (box) rotatePivotCenter = box.getCenter(new THREE.Vector3());
            }

            drag = {
                mode,
                objs,
                origin,
                startClient: { x: e.clientX, y: e.clientY },
                locked: false,
                worldAxis: null,
                axisScreenVec: null,
                startPositions: objs.map(o => o.position.clone()),
                startRotations: objs.map(o => o.rotation.clone()),
                startQuaternions: objs.map(o => o.quaternion.clone()),
                selectionBox,
                otherBoxes,
                rotatePivotCenter,
                snapState: { snappedTo: null },
            };

            try { canvas.setPointerCapture(e.pointerId); } catch {}

            // Keep this gesture from reaching OrbitControls or TransformGizmo.
            e.stopPropagation();
            e.preventDefault();
        }, true); // capture phase - same technique used above for viewport picking

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

                // Snaps the raw drag to a cardinal screen direction: horizontal
                // (left/right) when the horizontal component dominates, otherwise
                // vertical (up/down).
                const screenAxis = Math.abs(dxTotal) >= Math.abs(dyTotal) ? 'x' : 'y';

                // For move, track the axis most PARALLEL to the drag (dragging
                // right slides along whichever axis reads as "right" on screen).
                // For rotate it's the opposite - spin is driven by the axis most
                // PERPENDICULAR to the drag: dragging left/right spins around the
                // axis that reads as "up/down", like a turntable.
                const scoreAxis = (drag.mode === 'rotate')
                    ? (screenAxis === 'x' ? 'y' : 'x')
                    : screenAxis;

                // Finds which world axis projects most strongly onto that screen
                // direction, given the current camera orientation.
                const rect = canvas.getBoundingClientRect();
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
                // Projects the drag delta onto the axis's own screen-space
                // direction and expresses it in world units, so the shape tracks
                // the mouse 1:1 along that axis regardless of camera angle.
                const dot = dxTotal * v.x + dyTotal * v.y;
                let amount = dot / lenSq;

                if (app.smartSnapEnabled) {
                    amount = this._snapMoveToNeighbors(amount, drag);
                } else {
                    drag.snapState.snappedTo = null;
                }

                drag.objs.forEach((obj, i) => {
                    obj.position[drag.worldAxis] = drag.startPositions[i][drag.worldAxis] + amount;
                });
            } else {
                // For rotation the axis is perpendicular to the drag, so the drag
                // moves along the *tangent* of that axis's spin - its screen vector
                // rotated 90°. Projecting onto the tangent (not the axis vector)
                // makes the shape roll under the cursor as expected instead of
                // barely responding.
                const tangent = { x: -v.y, y: v.x };
                const dot = dxTotal * tangent.x + dyTotal * tangent.y;
                const pixelsAlongTangent = dot / Math.sqrt(lenSq);
                let angle = pixelsAlongTangent * ROTATE_RAD_PER_PIXEL;

                if (app.smartSnapEnabled) {
                    // Snaps the first dragged object's resulting rotation to the
                    // nearest 45° increment, then re-derives the angle delta so it
                    // applies uniformly to every dragged object (mirroring the
                    // move-snap approach above).
                    const baseDeg = THREE.MathUtils.radToDeg(drag.startRotations[0][drag.worldAxis]);
                    const targetDegRaw = baseDeg + THREE.MathUtils.radToDeg(angle);
                    const targetDegSnapped = this._snapWithHysteresis(
                        targetDegRaw,
                        SMART_SNAP_ROTATE_STEP_DEG,
                        SMART_SNAP_ROTATE_CAPTURE_DEG,
                        SMART_SNAP_ROTATE_RESISTANCE_DEG,
                        drag.snapState
                    );
                    angle = THREE.MathUtils.degToRad(targetDegSnapped - baseDeg);
                } else {
                    drag.snapState.snappedTo = null;
                }

                // Revolves every dragged object's position around the chosen pivot
                // point - world (0,0,0) in 'origin' mode, or the selection's own
                // bounding-box center (captured at drag start) in 'center' mode -
                // and applies the same world-axis rotation to each object's orientation.
                const pivotPoint = (app._rotatePivotMode === 'center' && drag.rotatePivotCenter)
                    ? drag.rotatePivotCenter
                    : new THREE.Vector3(0, 0, 0);

                const axisVec = new THREE.Vector3();
                axisVec[drag.worldAxis] = 1;
                const deltaQuat = new THREE.Quaternion().setFromAxisAngle(axisVec, angle);

                drag.objs.forEach((obj, i) => {
                    const relative = drag.startPositions[i].clone().sub(pivotPoint);
                    relative.applyAxisAngle(axisVec, angle);
                    obj.position.copy(pivotPoint).add(relative);
                    obj.quaternion.copy(deltaQuat).multiply(drag.startQuaternions[i]);
                });
            }

            window.dispatchEvent(new Event('transform-update'));
            e.stopPropagation();
            e.preventDefault();
        }, true);

        const endDrag = (e) => {
            if (!drag) return;
            const wasLocked = drag.locked;
            drag = null;
            if (wasLocked) {
                window.dispatchEvent(new Event('transform-end'));
                if (e) {
                    e.stopPropagation();
                    e.preventDefault();
                }
            }
        };

        container.addEventListener('pointerup', endDrag, true);
        container.addEventListener('pointercancel', endDrag, true);

        // Commits a hand-edited X/Y/Z value from the transform value bar
        ui.on('transformValueChange', (axis, rawValue) => {
            this._applyTransformValue(axis, rawValue);
        });

        // Re-syncs the transform value bar (used e.g. after pressing Escape)
        ui.on('refreshTransformPanel', () => {
            this._refreshTransformPanel();
        });
    }

    /**
     * Smart-snap for move drags: align the selection's near edge, far edge, or
     * center - along the locked axis - with a neighbor's corresponding feature.
     * Capture engages once within 1% of the selection's extent on that axis;
     * release requires drifting past capture plus a small resistance margin,
     * tracked through _snapWithHysteresis via drag.snapState.
     */
    _snapMoveToNeighbors(amount, drag) {
        const axis = drag.worldAxis;
        const box = drag.selectionBox;
        if (!box || !drag.otherBoxes || drag.otherBoxes.length === 0) return amount;

        const selMin = box.min[axis];
        const selMax = box.max[axis];
        const selCenter = (selMin + selMax) / 2;
        const extent = selMax - selMin;
        if (!(extent > 0)) return amount;

        const capture = extent * 0.01; // capture radius: 1% of the selection's extent on this axis (ColliBoy)
        const resistance = capture * 0.5; // hysteresis margin - extra push needed to break the lock

        // All alignments reachable with a neighbor along this axis: far edge to
        // near edge, near edge to far edge, or center to center. Each candidate
        // is stored as the translation `amount` that achieves it, so candidates
        // compare directly against the raw drag amount.
        const candidates = [];
        for (const otherBox of drag.otherBoxes) {
            const oMin = otherBox.min[axis];
            const oMax = otherBox.max[axis];
            const oCenter = (oMin + oMax) / 2;
            candidates.push(oMin - selMax);   // selection's far edge meets the neighbor's near edge
            candidates.push(oMax - selMin);   // selection's near edge meets the neighbor's far edge
            candidates.push(oCenter - selCenter); // centers coincide
        }

        const state = drag.snapState;

        if (state.snappedTo !== null) {
            if (Math.abs(amount - state.snappedTo) > capture + resistance) {
                state.snappedTo = null;
            } else {
                return state.snappedTo;
            }
        }

        let best = null;
        let bestDist = Infinity;
        for (const candidate of candidates) {
            const dist = Math.abs(amount - candidate);
            if (dist < bestDist) {
                bestDist = dist;
                best = candidate;
            }
        }

        if (best !== null && bestDist <= capture) {
            state.snappedTo = best;
            return best;
        }

        return amount;
    }

    /**
     * Snap `raw` to the nearest multiple of `step` once within `capture`, and,
     * once snapped, require drifting `capture + resistance` away before releasing.
     * The extra `resistance` margin is what makes the snap feel "sticky": holding
     * past a snapped value takes a harder push than capture alone would demand.
     *
     * `state` ({ snappedTo: null }) persists across pointermove events for one
     * drag gesture, so lock/release has memory instead of recomputing each move.
     */
    _snapWithHysteresis(raw, step, capture, resistance, state) {
        if (state.snappedTo !== null) {
            if (Math.abs(raw - state.snappedTo) > capture + resistance) {
                state.snappedTo = null;
            } else {
                return state.snappedTo;
            }
        }

        const nearest = Math.round(raw / step) * step;
        if (Math.abs(raw - nearest) <= capture) {
            state.snappedTo = nearest;
            return nearest;
        }

        return raw;
    }

    /**
     * Combined world-space bounding box over a set of selected object ids,
     * used by the Move/Rotate/Scale value bar to derive centers and sizes
     * without reaching into SceneController internals.
     */
    _getSelectionBox3(ids) {
        const app = this.app;
        const scene = app.sceneController;
        let box = null;
        for (const id of ids) {
            const obj = scene.objects.get(id);
            if (!obj) continue;
            if (!box) {
                box = new THREE.Box3().setFromObject(obj);
            } else {
                box.expandByObject(obj);
            }
        }
        return box;
    }

    /**
     * Re-render the Move/Rotate/Scale value bar for the current selection and
     * active mode - invoked on selection changes, mode switches, and live
     * during gizmo drags.
     */
    _refreshTransformPanel() {
        const app = this.app;
        const scene = app.sceneController;
        if (!scene) return;

        const selectedIds = scene.getSelectedObjectIds ? scene.getSelectedObjectIds() : [];
        if (!selectedIds || selectedIds.length === 0) {
            app.ui.hideTransformBar();
            return;
        }

        app.ui.showTransformBar();
        const mode = app._transformMode || 'move';
        app.ui.setTransformMode(mode);

        if (mode === 'move') {
            const box = this._getSelectionBox3(selectedIds);
            if (!box) return;
            const center = box.getCenter(new THREE.Vector3());
            app.ui.setTransformValues(center.x, center.y, center.z);
        } else if (mode === 'rotate') {
            if (selectedIds.length > 1) {
                // With multiple objects selected, rotation fields are always
                // fresh deltas from a 0,0,0 baseline - see _applyTransformValue.
                app.ui.setTransformValues(0, 0, 0);
            } else {
                const obj = scene.objects.get(selectedIds[0]);
                if (!obj) return;
                app.ui.setTransformValues(
                    THREE.MathUtils.radToDeg(obj.rotation.x),
                    THREE.MathUtils.radToDeg(obj.rotation.y),
                    THREE.MathUtils.radToDeg(obj.rotation.z)
                );
            }
        } else if (mode === 'scale') {
            const box = this._getSelectionBox3(selectedIds);
            if (!box) return;
            const size = box.getSize(new THREE.Vector3());
            app.ui.setTransformValues(size.x, size.y, size.z);
        }
    }

    /**
     * Apply a value-bar edit for one axis to the current selection.
     *
     * - Move: absolute world-space coordinate of the selection's center;
     *   every selected object is shifted by the same delta.
     * - Rotate: single object - an absolute rotation relative to its initial
     *   0,0,0 orientation. Multiple objects - a fresh delta from 0 added to
     *   each object's own current rotation independently.
     * - Scale: absolute width/height/depth in mm; each selected object's scale
     *   is multiplied by the ratio needed to reach that dimension. With lock
     *   ratio enabled, that same factor is applied to all three axes so the
     *   shape keeps its aspect ratio.
     */
    _applyTransformValue(axis, rawValue) {
        const app = this.app;
        const scene = app.sceneController;
        const selectedIds = scene.getSelectedObjectIds ? scene.getSelectedObjectIds() : [];
        if (!selectedIds || selectedIds.length === 0) return;

        const value = parseFloat(rawValue);
        if (Number.isNaN(value)) {
            this._refreshTransformPanel();
            return;
        }

        const mode = app._transformMode || 'move';

        if (mode === 'move') {
            const box = this._getSelectionBox3(selectedIds);
            if (!box) return;
            const center = box.getCenter(new THREE.Vector3());
            const current = center[axis];
            const delta = value - current;
            if (Math.abs(delta) < 1e-9) return;

            for (const id of selectedIds) {
                const obj = scene.objects.get(id);
                if (obj) obj.position[axis] += delta;
            }
        } else if (mode === 'rotate') {
            const deltaRad = THREE.MathUtils.degToRad(value);
            if (selectedIds.length > 1) {
                // Multi-selection: the field is a delta from the 0,0,0
                // baseline, added onto each object's current rotation.
                if (Math.abs(value) > 1e-9) {
                    for (const id of selectedIds) {
                        const obj = scene.objects.get(id);
                        if (obj) obj.rotation[axis] += deltaRad;
                    }
                }
            } else {
                const obj = scene.objects.get(selectedIds[0]);
                if (obj) obj.rotation[axis] = deltaRad;
            }
        } else if (mode === 'scale') {
            const box = this._getSelectionBox3(selectedIds);
            if (!box) return;
            const size = box.getSize(new THREE.Vector3());
            const currentDim = size[axis];
            if (!currentDim || currentDim < 1e-9) return;
            const ratio = value / currentDim;
            if (!Number.isFinite(ratio) || ratio <= 0) return;

            // With lock ratio on, the same factor is applied to every axis so
            // the shape keeps its aspect ratio; otherwise only the edited one.
            const axes = app._lockRatioEnabled ? ['x', 'y', 'z'] : [axis];
            for (const id of selectedIds) {
                const obj = scene.objects.get(id);
                if (!obj) continue;
                for (const a of axes) obj.scale[a] *= ratio;
            }
        }

        window.dispatchEvent(new Event('transform-update'));
        // A value-bar entry is a discrete, committed edit - not a live drag - so
        // commit it to the backend immediately, as a gizmo drag's end would,
        // rather than waiting for another transform first.
        window.dispatchEvent(new Event('transform-end'));
        this._refreshTransformPanel();
    }
}
