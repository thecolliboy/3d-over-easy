import * as THREE from 'three';

/**
 * ColliBoy - "Scene Objects" thumbnail panel in the right sidebar: one button
 * per loaded model with a rendered preview image; clicking toggles its selection.
 */
export class ObjectListPanel {
    constructor(app) {
        this.app = app;
    }

    /**
     * "Scene Objects" thumbnail panel - right sidebar, above Properties.
     * One button per loaded model: a rendered preview image plus its name;
     * clicking toggles that model's selection. The list is rebuilt whenever
     * an object is added or removed (the hooks wrap SceneController's own
     * addObject/removeObject, so every code path that mutates the scene keeps
     * the panel correct), and refreshed on selection-only changes via the
     * updatePropertiesPanel wrapper.
     */
    init() {
        const app = this.app;
        const scene = app.sceneController;
        const ui = app.ui;

        this._objectThumbCache = new Map(); // frontendId -> data URL; dropped when the object is removed

        const origAddObject = scene.addObject.bind(scene);
        scene.addObject = (object, id = null) => {
            const result = origAddObject(object, id);
            this._refreshObjectListPanel();
            return result;
        };

        const origRemoveObject = scene.removeObject.bind(scene);
        scene.removeObject = (id) => {
            origRemoveObject(id);
            this._objectThumbCache.delete(id);
            this._refreshObjectListPanel();
        };

        ui.on('objectThumbClick', (id) => {
            if (!id || !scene.objects.has(id)) return;
            scene.toggleObjectSelection(id);
            app._updatePropertiesForSelected();
        });
    }

    _refreshObjectListPanel() {
        const app = this.app;
        const scene = app.sceneController;
        const container = app.ui.elements['object-list'];
        if (!container) return;

        container.innerHTML = '';

        if (scene.objects.size === 0) {
            const empty = document.createElement('div');
            empty.className = 'object-list-empty';
            empty.textContent = 'No models loaded';
            container.appendChild(empty);
            return;
        }

        scene.objects.forEach((object, id) => {
            const label = object.name || id;

            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'object-thumb';
            btn.dataset.id = id;
            btn.title = label;
            if (scene.selectedObjects.has(id)) btn.classList.add('selected');

            let dataUrl = this._objectThumbCache.get(id);
            if (!dataUrl) {
                dataUrl = this._renderThumbnail(object);
                if (dataUrl) this._objectThumbCache.set(id, dataUrl);
            }

            if (dataUrl) {
                const img = document.createElement('img');
                img.src = dataUrl;
                img.alt = label;
                btn.appendChild(img);
            }

            const labelEl = document.createElement('span');
            labelEl.className = 'object-thumb-label';
            labelEl.textContent = label;
            btn.appendChild(labelEl);

            container.appendChild(btn);
        });
    }

    /**
     * Lightweight pass that only toggles the .selected class on
     * already-built thumbnail buttons - runs on every selection change via
     * the updatePropertiesPanel wrapper, avoiding a full re-render.
     */
    syncSelection() {
        const app = this.app;
        const scene = app.sceneController;
        const container = app.ui.elements['object-list'];
        if (!container) return;
        container.querySelectorAll('.object-thumb').forEach((el) => {
            el.classList.toggle('selected', scene.selectedObjects.has(el.dataset.id));
        });
    }

    _ensureThumbnailRenderer() {
        if (this._thumbRenderer) return this._thumbRenderer;

        const size = 128;
        const canvas = document.createElement('canvas');
        const renderer = new THREE.WebGLRenderer({
            canvas,
            antialias: true,
            alpha: true,
            preserveDrawingBuffer: true, // keeps the last rendered frame readable via toDataURL()
        });
        renderer.setPixelRatio(1);
        renderer.setSize(size, size, false);
        renderer.setClearColor(0x000000, 0);

        const scene = new THREE.Scene();
        const camera = new THREE.PerspectiveCamera(35, 1, 0.01, 1000);
        scene.add(new THREE.AmbientLight(0xffffff, 0.9));
        const key = new THREE.DirectionalLight(0xffffff, 1.1);
        key.position.set(3, 5, 4);
        scene.add(key);
        const fill = new THREE.DirectionalLight(0xffffff, 0.35);
        fill.position.set(-3, -2, -4);
        scene.add(fill);

        this._thumbRenderer = { renderer, scene, camera };
        return this._thumbRenderer;
    }

    /**
     * Render `object` to a small preview image from a fixed 3/4 angle.
     * The object is cloned into a dedicated offscreen renderer - separate
     * from the main viewport, so the live camera and selection state are
     * never disturbed. Cloning is cheap here: Three.js shares geometry and
     * material by reference on clone(), so nothing owned by the live scene
     * is mutated or disposed.
     */
    _renderThumbnail(object) {
        try {
            const { renderer, scene, camera } = this._ensureThumbnailRenderer();

            const box = new THREE.Box3().setFromObject(object);
            if (box.isEmpty()) return null;
            const sphere = box.getBoundingSphere(new THREE.Sphere());
            const center = sphere.center;
            const radius = Math.max(sphere.radius, 0.001);

            const clone = object.clone(true);
            scene.add(clone);

            const fovRad = THREE.MathUtils.degToRad(camera.fov);
            const distance = (radius / Math.sin(fovRad / 2)) * 1.4;
            camera.position.set(
                center.x + distance * 0.6,
                center.y + distance * 0.55,
                center.z + distance * 0.6
            );
            camera.near = Math.max(distance - radius * 4, 0.01);
            camera.far = distance + radius * 4;
            camera.lookAt(center);
            camera.updateProjectionMatrix();

            renderer.render(scene, camera);
            const dataUrl = renderer.domElement.toDataURL('image/png');

            scene.remove(clone);
            return dataUrl;
        } catch (err) {
            console.warn('Thumbnail render failed:', err);
            return null;
        }
    }
}
