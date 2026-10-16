import * as THREE from 'three';

/**
 * ColliBoy - Nudges the current selection with the arrow keys in Move and
 * Rotate modes. The world axis is picked like a click-and-drag would be:
 * each axis projects onto the screen for the current camera view, and the
 * key's on-screen direction decides which one (and sign) it drives.
 */
export class ArrowKeys {
    constructor(app) {
        this.app = app;
        // Debounced commit: arrow bursts move the selection live; one
        // transform-end (backend commit + grid snap) fires after the burst ends.
        this._endTimer = null;
    }

    init() {
        const app = this.app;
        const scene = app.sceneController;
        const canvas = document.getElementById('viewport-canvas');

        const MOVE_STEP = 1;          // mm per press in move mode
        const ROTATE_STEP_DEG = 5;    // degrees per press in rotate mode
        const SHIFT_FACTOR = 10;      // holding Shift multiplies both steps
        const COMMIT_DELAY_MS = 400;

        document.addEventListener('keydown', (e) => {
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
            if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) return;
            if (app.splitMode.isActive()) return;

            const mode = app._transformMode;
            if (mode !== 'move' && mode !== 'rotate') return;

            // Don't nudge while a modal dialog is up - the keys belong to it.
            if (document.querySelector('.modal-overlay:not(.hidden)')) return;

            const selectedIds = scene.getSelectedObjectIds ? scene.getSelectedObjectIds() : [];
            if (!selectedIds || selectedIds.length === 0) return;

            e.preventDefault();

            // The key's on-screen direction as a unit vector (screen y grows downward).
            const dir = { x: 0, y: 0 };
            if (e.key === 'ArrowLeft') dir.x = -1;
            else if (e.key === 'ArrowRight') dir.x = 1;
            else if (e.key === 'ArrowUp') dir.y = -1;
            else dir.y = 1;

            const objs = selectedIds.map(id => scene.objects.get(id)).filter(Boolean);
            if (objs.length === 0) return;

            // Project each world axis onto the screen from the selection's
            // position (mirroring AxisDrag's locked-axis pick): the axis that
            // reads most strongly along the key's screen direction wins.
            const origin = new THREE.Vector3();
            if (objs.length === 1) {
                origin.copy(objs[0].position);
            } else {
                const box = app.axisDrag._getSelectionBox3(selectedIds);
                if (box) box.getCenter(origin); else origin.copy(objs[0].position);
            }

            const rect = canvas.getBoundingClientRect();
            const toScreen = (worldPos) => {
                const v = worldPos.clone().project(scene.camera);
                return { x: (v.x * 0.5 + 0.5) * rect.width, y: (-v.y * 0.5 + 0.5) * rect.height };
            };

            const projections = {};
            for (const axis of ['x', 'y', 'z']) {
                const offset = new THREE.Vector3();
                offset[axis] = 1;
                const a = toScreen(origin);
                const b = toScreen(origin.clone().add(offset));
                projections[axis] = { x: b.x - a.x, y: b.y - a.y };
            }

            // Move tracks the axis most parallel to the key's direction; Rotate
            // spins around the axis most perpendicular to it, mirroring AxisDrag.
            const screenAxis = dir.x !== 0 ? 'x' : 'y';
            const scoreAxis = (mode === 'rotate') ? (screenAxis === 'x' ? 'y' : 'x') : screenAxis;

            let bestAxis = null;
            let bestScore = -1;
            for (const axis of ['x', 'y', 'z']) {
                const component = Math.abs(projections[axis][scoreAxis]);
                if (component > bestScore) {
                    bestScore = component;
                    bestAxis = axis;
                }
            }
            if (!bestAxis || bestScore < 1e-6) return;

            const v = projections[bestAxis];
            const factor = e.shiftKey ? SHIFT_FACTOR : 1;

            if (mode === 'move') {
                // Sign: does +1 unit along this axis point the way the key was pressed?
                const dot = v.x * dir.x + v.y * dir.y;
                const amount = Math.sign(dot || 1) * MOVE_STEP * factor;
                objs.forEach((obj) => {
                    obj.position[bestAxis] += amount;
                });
            } else {
                // Rotate around the chosen axis; the drag-equivalent direction
                // is the tangent of its screen vector, so keys spin like a drag.
                const tangent = { x: -v.y, y: v.x };
                const dot = tangent.x * dir.x + tangent.y * dir.y;
                const angle = Math.sign(dot || 1) * THREE.MathUtils.degToRad(ROTATE_STEP_DEG * factor);

                let pivotPoint = null;
                if (app._rotatePivotMode === 'center') {
                    const box = app.axisDrag._getSelectionBox3(selectedIds);
                    if (box) pivotPoint = box.getCenter(new THREE.Vector3());
                } else {
                    pivotPoint = new THREE.Vector3(0, 0, 0);
                }

                const axisVec = new THREE.Vector3();
                axisVec[bestAxis] = 1;
                const deltaQuat = new THREE.Quaternion().setFromAxisAngle(axisVec, angle);

                objs.forEach((obj) => {
                    const relative = obj.position.clone().sub(pivotPoint);
                    relative.applyAxisAngle(axisVec, angle);
                    obj.position.copy(pivotPoint).add(relative);
                    obj.quaternion.premultiply(deltaQuat);
                });
            }

            window.dispatchEvent(new Event('transform-update'));

            // Commit once per burst of presses rather than on every event.
            if (this._endTimer) clearTimeout(this._endTimer);
            this._endTimer = setTimeout(() => {
                this._endTimer = null;
                window.dispatchEvent(new Event('transform-end'));
            }, COMMIT_DELAY_MS);
        });
    }
}
