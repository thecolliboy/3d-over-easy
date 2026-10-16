import * as THREE from 'three';

/**
 * ColliBoy - Small orientation indicator docked at the top-left of the viewport.
 * Renders a miniature X/Y/Z axis gizmo in its own scene; the gizmo group is rotated
 * by the inverse of the main camera's quaternion each frame, so the axes spin in
 * place as the user orbits and always show which way they are looking.
 */
export class ViewCube {
    constructor(app) {
        this.app = app;

        const container = document.getElementById('viewport-container');
        if (!container) return;

        // Own DOM + renderer: a second, tiny WebGL context keeps the main
        // render loop untouched and lets us redraw only when needed.
        this.visible = true;
        this.el = document.createElement('div');
        this.el.className = 'view-cube';
        const canvas = document.createElement('canvas');
        canvas.width = 96;
        canvas.height = 96;
        this.el.appendChild(canvas);
        container.appendChild(this.el);

        this.renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
        this.scene = new THREE.Scene();

        // Fixed camera: position and orientation never change; the gizmo group is rotated by the inverse of the main camera's quaternion instead, so the axes spin in place as the user orbits. Copying the camera's orientation onto a fixed-position camera would swing its view direction around rather than rotate the gizmo.
        this.camera = new THREE.PerspectiveCamera(45, 1, 0.1, 10);
        this.camera.position.set(0, 0, 3);

        const axisLen = 1;
        // Same colors as the scene's own axis stubs so both read consistently.
        const axes = [
            { color: '#ff4444', from: [-axisLen, 0, 0], to: [axisLen, 0, 0] },
            { color: '#44ff44', from: [0, -axisLen, 0], to: [0, axisLen, 0] },
            { color: '#4488ff', from: [0, 0, -axisLen], to: [0, 0, axisLen] },
        ];

        // All gizmo geometry lives in one group so it can be spun as a whole.
        const gizmo = new THREE.Group();
        for (const a of axes) {
            const geo = new THREE.BufferGeometry().setFromPoints([
                new THREE.Vector3(...a.from),
                new THREE.Vector3(...a.to),
            ]);
            gizmo.add(new THREE.Line(geo, new THREE.LineBasicMaterial({ color: a.color })));
        }

        // A small wireframe cube for spatial reference.
        const cubeGeo = new THREE.BoxGeometry(0.9, 0.9, 0.9);
        const edges = new THREE.EdgesGeometry(cubeGeo);
        gizmo.add(new THREE.LineSegments(edges, new THREE.LineBasicMaterial({ color: '#8888aa' })));
        this.scene.add(gizmo);
        this._gizmo = gizmo;

        // Render only when the main camera's orientation changes - orbiting is the only thing that moves the indicator. The gizmo takes the inverse of the camera's quaternion, so it shows what the world axes look like from the current viewpoint.
        this._lastQuaternion = null;
        const tick = () => {
            requestAnimationFrame(tick);
            if (!this.visible) return; // hidden - skip the render entirely
            const q = app.sceneController.camera.quaternion;
            if (this._lastQuaternion && this._lastQuaternion.equals(q)) return;
            this._lastQuaternion = q.clone();
            this._gizmo.quaternion.copy(q).invert();
            this.renderer.render(this.scene, this.camera);
        };
        requestAnimationFrame(tick);
    }

    /**
     * Shows or hides the indicator. Driven by the status-bar toggle (ui.view_cube_visible);
     * aesthetic mode hides it independently via CSS (body.aesthetic-mode .view-cube).
     */
    setVisible(visible) {
        if (!this.el) return;
        this.visible = !!visible;
        this.el.style.display = this.visible ? '' : 'none';
    }
}
