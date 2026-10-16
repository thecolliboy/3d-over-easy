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
     * Build the panel and keep it in sync: hooks wrap SceneController's own
     * addObject/removeObject so every scene mutation rebuilds the list, while
     * selection-only changes refresh via the updatePropertiesPanel wrapper.
     */
    init() {
        const app = this.app;
        const scene = app.sceneController;
        const ui = app.ui;

        this._objectThumbCache = new Map(); // frontendId -> data URL; dropped when the object is removed

        // Shrink-to-fit for the preview grid, seeded from .config (ui.preview_shrink).
        const uiSettings = (app._settings && app._settings.ui) || {};
        this.shrinkEnabled = uiSettings.preview_shrink ?? true;

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

        // Re-fit the grid when the window resizes (the panel width changes).
        this._resizeHandler = () => {
            const c = ui.elements['object-list'];
            if (c) this._layoutObjectList(c);
        };
        window.addEventListener('resize', this._resizeHandler);
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

        this._layoutObjectList(container);
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

    /**
     * Fit the thumbnail grid inside the panel's fixed height. When shrink mode is on
     * (ui.preview_shrink) and the natural auto-fill grid overflows, recompute a
     * column/row split with the largest square-ish cells that still fit; otherwise
     * leave the base CSS (auto-fill + scroll) untouched.
     */
    _layoutObjectList(container) {
        const n = container.querySelectorAll('.object-thumb').length;
        if (n === 0) return;

        // Reset to the natural layout first, then only shrink when needed.
        this._clearShrinkStyles(container);

        if (!this.shrinkEnabled) return;

        const style = getComputedStyle(container);
        const padL = parseFloat(style.paddingLeft) || 0;
        const padR = parseFloat(style.paddingRight) || 0;
        const gap = parseFloat(style.gap) || 8;
        const maxH = parseFloat(style.maxHeight); // px, e.g. "216px" -> 216

        const W = container.clientWidth - padL - padR; // content width (clientWidth includes padding)
        if (!(W > 0) || !(maxH > 0)) return; // collapsed/hidden panel: nothing to fit

        // Natural layout mirrors the base CSS: repeat(auto-fill, minmax(60px, 1fr)).
        const MIN_CELL = 60;
        const colsNatural = Math.max(1, Math.floor((W + gap) / (MIN_CELL + gap)));
        const rowsNatural = Math.ceil(n / colsNatural);
        const cellNatural = (W - (colsNatural - 1) * gap) / colsNatural; // 1fr stretch -> square via aspect-ratio
        const naturalH = rowsNatural * cellNatural + (rowsNatural - 1) * gap;

        if (naturalH <= maxH) return; // fits without shrinking

        // Pick the row count whose cells are largest while still fitting in maxH.
        let best = null;
        for (let r = 1; r <= n; r++) {
            const c = Math.ceil(n / r);
            const cellW = (W - (c - 1) * gap) / c;
            const cellH = (maxH - (r - 1) * gap) / r;
            if (cellW <= 0 || cellH <= 0) continue;
            const score = Math.min(cellW, cellH); // prefer the bigger, squarer cells
            if (!best || score > best.score) best = { c, r, score };
        }
        if (!best) return;

        // Derive the real row count from the chosen columns so the declared tracks
        // always match the rows the items actually form (no sparse/empty tracks).
        const rows = Math.ceil(n / best.c);

        container.classList.add('object-list--shrink');
        container.style.gridTemplateColumns = `repeat(${best.c}, 1fr)`;
        container.style.gridTemplateRows = `repeat(${rows}, 1fr)`;
    }

    _clearShrinkStyles(container) {
        container.classList.remove('object-list--shrink');
        container.style.gridTemplateColumns = '';
        container.style.gridTemplateRows = '';
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
     * Render `object` to a small preview image from a fixed 3/4 angle, cloned into a
     * dedicated offscreen renderer so the live camera and selection state are never
     * disturbed; cloning shares geometry/material by reference, so nothing owned by
     * the live scene is mutated or disposed.
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
