import * as THREE from 'three';
import { TransformControls } from 'three/addons/controls/TransformControls.js';

/**
 * ColliBoy - Thin wrapper around three's TransformControls providing
 * translate/rotate/scale gizmos with pivot-aware rotation.
 */
export class TransformGizmo {
    constructor(camera, domElement) {
        this.domElement = domElement;
        this.control = new TransformControls(camera, domElement);

        this.control.setSize(0.1);
        this.enabled = false;
        this.mode = 'translate';

        // Rotate pivot: 'origin' rotates around world (0,0,0), 'center'
        // rotates around the attached object's own bounding-box center.
        // Only takes effect in 'rotate' mode; ignored for translate/scale.
        this.pivotMode = 'origin';
        this._realObject = null;   // the object main.js thinks is attached
        this._pivot = null;        // temporary Object3D standing in as the drag pivot
        this._pivotedObject = null; // the real object currently reparented under _pivot
        this._pivotOriginalParent = null;

        // Ratio lock: when enabled, a scale-mode drag resizes every axis by the
        // same factor so the object keeps its aspect ratio. The base snapshot
        // is taken at drag start and only lives for that one drag.
        this.ratioLockEnabled = false;
        this._ratioLockBase = null;

        // Pointer shows grab while a handle is hovered, so drags feel intentional
        this.control.addEventListener('hoverOn', () => {
            this.domElement.style.cursor = 'grab';
        });

        this.control.addEventListener('hoverOff', () => {
            this.domElement.style.cursor = 'default';
        });

        this.control.addEventListener('objectChange', () => {
            // Broadcast transform-update so dependent modules can follow the drag live
            window.dispatchEvent(new CustomEvent('transform-update'));
            this._updateRatioLock();
        });

        // Drag lifecycle - used to wrap/unwrap the attached object in a
        // temporary pivot for non-default rotate pivots. Wrapping only for
        // the duration of an actual drag (rather than for the whole time
        // the object is selected) keeps the object a direct child of the
        // scene at all other times, so deletion/undo/etc. keep working
        // exactly as before. Also snapshots the pre-drag scale while ratio
        // lock is on, so locked drags can derive their factor from it.
        this.control.addEventListener('dragging-changed', (event) => {
            if (event.value) {
                this._beginPivotDrag();
                this._beginRatioLock();
            } else {
                this._endPivotDrag();
                this._ratioLockBase = null;
            }
        });

        this.control.addEventListener('mouseUp', () => {
            // Broadcast transform-end so grid snapping and undo capture run once the drag settles
            window.dispatchEvent(new CustomEvent('transform-end'));
        });
    }

    /**
     * Attach the gizmo to an object, re-applying the current transform mode.
     */
    attach(object) {
        this._realObject = object;
        this.control.attach(object);
        this.enabled = true;
        if (this.mode) {
            this.control.setMode(this.mode);
        }
    }

    /**
     * Detach from the current object and clear all attachment state.
     */
    detach() {
        // Never leave an object parented under a stray pivot.
        this._endPivotDrag();
        this._ratioLockBase = null;
        this.control.detach();
        this._realObject = null;
        this.enabled = false;
    }

    /**
     * Choose the point rotate-mode drags pivot around: 'origin' (world
     * 0,0,0) or 'center' (the attached object's own bounding-box center).
     */
    setPivotMode(mode) {
        this.pivotMode = mode === 'center' ? 'center' : 'origin';
    }

    /**
     * Enable or disable ratio locking for scale-mode drags. When on, dragging
     * an axis handle resizes the other axes by the same factor so the object's
     * aspect ratio is preserved; when off, each axis scales independently.
     */
    setRatioLock(enabled) {
        this.ratioLockEnabled = !!enabled;
        if (!this.ratioLockEnabled) this._ratioLockBase = null;
    }

    /**
     * At drag start (scale mode only), snapshot the object's scale so every
     * locked update during this one drag derives its factor from the same
     * baseline. TransformControls rewrites object.scale from its own start
     * value on every pointer move, resetting untouched axes - so the lock has
     * to re-assert proportionality after each of those writes (see
     * _updateRatioLock) rather than adjusting incrementally.
     */
    _beginRatioLock() {
        if (!this.ratioLockEnabled || this.mode !== 'scale') return;
        const object = this._realObject;
        if (!object) return;
        this._ratioLockBase = object.scale.clone();
    }

    /**
     * Re-asserts proportional scaling after each TransformControls write. The
     * controls' scale mode sets object.scale to (startScale × factor) with the
     * factor applied only along the dragged handle's axis, so this reads that
     * factor back off the dragged axis and applies it to all three axes from
     * the drag-start baseline. Runs on every objectChange; no-ops outside a
     * locked scale drag.
     */
    _updateRatioLock() {
        if (!this.ratioLockEnabled || this.mode !== 'scale') return;
        const object = this._realObject;
        const base = this._ratioLockBase;
        if (!object || !base) return;

        // The handle currently being dragged: 'X'/'Y'/'Z', a two-axis plane
        // ('XY'/'XZ'/'YZ'), or the uniform box ('XYZ'); null when not dragging.
        const axis = this.control.axis;
        if (!axis) return;

        let factor;
        if (axis === 'XYZ') {
            return; // uniform handle already scales all axes equally
        } else if (axis.length === 1) {
            const a = axis.toLowerCase();
            if (!(Math.abs(base[a]) > 1e-9)) return;
            factor = object.scale[a] / base[a];
        } else {
            // Two-axis plane handle: average the two per-axis factors.
            let sum = 0, n = 0;
            for (const ch of axis.toLowerCase()) {
                if (Math.abs(base[ch]) > 1e-9) {
                    sum += object.scale[ch] / base[ch];
                    n++;
                }
            }
            if (!n) return;
            factor = sum / n;
        }

        for (const a of ['x', 'y', 'z']) object.scale[a] = base[a] * factor;
    }

    /**
     * On drag start, if we're in rotate mode, reparent the real object
     * under a temporary pivot positioned at the world point rotation
     * should occur around, and point the gizmo at the pivot instead - so
     * the handle spins the object around that point rather than the
     * object's own origin. Preserves the object's world transform exactly.
     */
    _beginPivotDrag() {
        if (this.mode !== 'rotate') return;
        const object = this._realObject;
        if (!object || !object.parent) return;

        let pivotPos;
        if (this.pivotMode === 'center') {
            const box = new THREE.Box3().setFromObject(object);
            if (box.isEmpty()) return;
            pivotPos = box.getCenter(new THREE.Vector3());
        } else {
            pivotPos = new THREE.Vector3(0, 0, 0);
        }

        const originalParent = object.parent;
        const pivot = new THREE.Object3D();
        pivot.position.copy(pivotPos);
        originalParent.add(pivot);
        pivot.updateMatrixWorld(true);

        this._reparentPreservingWorldTransform(object, pivot);

        this._pivot = pivot;
        this._pivotedObject = object;
        this._pivotOriginalParent = originalParent;

        this.control.attach(pivot);
    }

    /**
     * On drag end, bake the pivot's transform back into the real object,
     * restore it as a direct child of its original parent, remove the
     * temporary pivot, and point the gizmo back at the real object.
     */
    _endPivotDrag() {
        if (!this._pivot || !this._pivotedObject) return;
        const pivot = this._pivot;
        const object = this._pivotedObject;
        const originalParent = this._pivotOriginalParent || pivot.parent;

        pivot.updateMatrixWorld(true);
        if (originalParent) {
            this._reparentPreservingWorldTransform(object, originalParent);
        }
        if (pivot.parent) pivot.parent.remove(pivot);

        this._pivot = null;
        this._pivotedObject = null;
        this._pivotOriginalParent = null;

        if (this._realObject && this.enabled) {
            this.control.attach(this._realObject);
        }
    }

    /**
     * Move `object` to be a child of `newParent`, adjusting its local
     * position/quaternion/scale so its world transform is unchanged.
     */
    _reparentPreservingWorldTransform(object, newParent) {
        object.updateMatrixWorld(true);
        const worldMatrix = object.matrixWorld.clone();
        newParent.add(object);
        newParent.updateMatrixWorld(true);
        const localMatrix = new THREE.Matrix4()
            .copy(newParent.matrixWorld)
            .invert()
            .multiply(worldMatrix);
        localMatrix.decompose(object.position, object.quaternion, object.scale);
    }

    /**
     * Enable or disable gizmo interaction without detaching from the object.
     */
    setEnabled(enabled) {
        this.enabled = enabled;
        this.control.enabled = enabled;
    }

    /**
     * Switch between translate/rotate/scale modes.
     */
    setMode(mode) {
        // Defensive: don't leave an object parented under a stray pivot if
        // the mode changes mid-drag for any reason. A stale ratio-lock base is
        // equally invalid once the mode changes, so drop it too.
        this._endPivotDrag();
        this._ratioLockBase = null;
        this.mode = mode;
        if (this.enabled) {
            this.control.setMode(mode);
        }
    }
}
