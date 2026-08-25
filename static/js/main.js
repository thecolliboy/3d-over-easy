/**
 * ColliBoy - main entry point for the browser app: DOM wiring, viewport
 * scene management, and backend API calls for the 3D model builder.
 */
import * as THREE from 'three';
import { APIClient, hasId } from './api/ApiClient.js';
import { SceneController, SELECTION_COLOR } from './viewport/SceneController.js';
import { TransformGizmo } from './viewport/TransformGizmo.js';
import { CuttingPlane } from './viewport/CuttingPlane.js';
import { GridSnapper } from './viewport/GridSnapper.js';
import { WebGLOptimizer } from './viewport/WebGLOptimizer.js';
import { SplitMode } from './viewport/SplitMode.js';
import { AxisDrag } from './viewport/AxisDrag.js';
import { MeshSync } from './viewport/MeshSync.js';
import { ContextMenu } from './ui/ContextMenu.js';
import { ObjectListPanel } from './ui/ObjectListPanel.js';
import { PrimitivePalette } from './ui/PrimitivePalette.js';
import { UIManager, AI_OPENAI_ADD_OPTION } from './ui/UIManager.js';
import {
    showHollowModal,
    showSimplifyModal,
    showSmoothModal,
    showFilletModal,
    showChamferModal,
    showExportModal,
    showSaveModal,
    showPrimitiveModal,
} from './ui/Modal.js';

/**
 * Top-level application class: owns the API client, UI manager, and scene
 * controller, and wires their events into working behavior.
 */
class App {
    constructor(defaults = {}) {
        const buildPlateDefaults = defaults.build_plate || {};
        const snapDefaults = defaults.snap || {};
        const uiDefaults = defaults.ui || {};

        // Raw .config sections from /api/settings; _initViewport reads the ones
        // App doesn't keep as fields (viewport, snap)
        this._settings = defaults;

        this.api = new APIClient();
        this.ui = new UIManager({ units: uiDefaults.units, messages_muted: uiDefaults.messages_muted });
        this.sceneController = null;
        this.transformGizmo = null;
        this.cuttingPlane = null;
        this.gridSnapper = null;
        this.webglOptimizer = null;

        // Smart snap - magnetic snapping applied while dragging a shape's
        // position/orientation directly; distinct from the grid-size-based
        // Grid Snap feature. Seeded from .config (snap.smart_enabled).
        this.smartSnapEnabled = snapDefaults.smart_enabled ?? true;

        // "Night" mode is the dark UI theme; "day" flips to the light one.
        // Driven by .config's ui.theme ("night"/"day").
        this.nightModeEnabled = (uiDefaults.theme ?? 'night') !== 'day';

        // Aesthetic mode - glassy dark-grey menus, slowly drifting 2D waves,
        // and dramatic lighting; toggled from the status-bar toggle.
        this.aestheticModeEnabled = uiDefaults.aesthetic_mode ?? false;

        // Even lighting - flattens the viewport's light rig so all surfaces
        // are lit about equally; toggled from the bottom-left view-mode cluster.
        this.evenLightingEnabled = uiDefaults.even_lighting ?? false;

        // Visual state for the build plate and axes, seeded from .config
        this.buildPlateVisible = buildPlateDefaults.visible ?? true;
        this.axisVisible = buildPlateDefaults.axis_lines_visible ?? true;
        this.infinitePlateEnabled = buildPlateDefaults.infinite ?? true;
        this.simplePlateEnabled = buildPlateDefaults.simple_plate ?? false;
        this._defaultPlateSize = buildPlateDefaults.default_size_mm ?? 10; // kept in sync with SceneController's initial gridSize
        this._lastPlateSize = this._defaultPlateSize;

        // Render-stats display state
        this._renderStatsVisible = false;
        this._statsUpdateTimer = null;

        // Transform value-bar state
        this._transformMode = 'move';

        // Rotation pivot choice: 'origin' (world 0,0,0) versus 'center'
        // (the shape's own bounding-box center). Matters only in rotate mode;
        // seeded from .config to match the checkbox state.
        this._rotatePivotMode = uiDefaults.rotate_pivot ?? 'center';

        // Lock ratio: when on, scaling one axis resizes the other axes by the
        // same factor (aspect ratio preserved); off, each axis scales
        // independently. Matters only in scale mode; off by default.
        this._lockRatioEnabled = false;

        // Session state - the active backend session and the frontend→backend id mapping
        this.sessionId = null;
        this.backendIds = new Map();  // maps frontendId to its { sessionId, objectId } pair

        // Generation-job backing state - holds the in-flight job (if
        // one exists) so the Stop button and the status-polling loop can
        // coordinate. Shape: { jobId, pollTimer, cancelled }
        this._aiJob = null;

        // One-shot guard: AI scratch cleanup runs only on the first open of the
        // AI panel per page load (residual-dir sweep), not on every reopen.
        this._aiFirstOpenCleaned = false;

        // Clipboard backing state for the Copy / Cut / Paste operations
        this._clipboard = null;  // shape: { mode: 'copy'|'cut', entries: [{ frontendId, backendInfo }] }
        this.contextMenu = new ContextMenu();
        this.primitivePalette = new PrimitivePalette();
        this.splitMode = new SplitMode(this);
        this.axisDrag = new AxisDrag(this);
        this.objectListPanel = new ObjectListPanel(this);
        this.meshSync = new MeshSync(this);

        this._initViewport();
        this._applyInitialSettings();
        this._bindUIEvents();
        this.axisDrag.init();
        this.splitMode.init();
        this._initConnectionStatus();
        this._initAdBanner();
    }

    /**
     * Drives the ad banner at the bottom of the right-hand menu. The host is
     * probed with a lightweight fetch on the same cadence as the connection
     * dot; no-cors mode means we only care whether the network path answers,
     * not what comes back - so the probe works without CORS headers. While
     * the host is unreachable the banner container is hidden, which removes
     * its space from the menu layout; once a probe succeeds again the space
     * is restored and the iframe resumes on its own.
     */
    _initAdBanner() {
        const banner = document.getElementById('ad-banner');
        if (!banner) return;

        const BANNER_URL = 'https://ads.colliboy.com';
        const CHECK_INTERVAL_MS = 20000;
        let hidden = false;

        const check = async () => {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 8000);
            let reachable;
            try {
                await fetch(BANNER_URL, { mode: 'no-cors', signal: controller.signal });
                reachable = true;
            } catch (err) {
                reachable = false;
            } finally {
                clearTimeout(timer);
            }

            if (reachable === hidden) return; // state unchanged - nothing to do
            hidden = !reachable;
            banner.style.display = hidden ? 'none' : '';
        };

        check();

        setInterval(() => {
            if (document.visibilityState === 'visible') check();
        }, CHECK_INTERVAL_MS);

        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible') check();
        });
    }

    /**
     * Drives the connection indicator - the leftmost dot in the status bar.
     * The health check runs sparingly: every 20s, and only while the tab is
     * visible, so the server isn't hammered. It also re-runs immediately when
     * the tab regains focus, keeping the dot from sitting stale.
     */
    _initConnectionStatus() {
        const dot = this.ui.elements['connection-status'];
        if (!dot) return;

        const CHECK_INTERVAL_MS = 20000;

        const setStatus = (connected) => {
            dot.classList.toggle('connected', connected);
            dot.classList.toggle('disconnected', !connected);
            dot.title = connected
                ? 'Connected to backend server'
                : 'Backend server unreachable';
        };

        const check = async () => {
            const ok = await this.api.checkHealth();
            setStatus(ok);
        };

        check();

        setInterval(() => {
            if (document.visibilityState === 'visible') check();
        }, CHECK_INTERVAL_MS);

        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible') check();
        });
    }

    /**
     * Themed stand-in for the browser's native alert(): a modal matching the
     * app's own dialog styling rather than a generic "localhost says" popup.
     * Dismissable via OK, the close button, clicking outside, or Escape/Enter.
     * Every call site is fire-and-forget - none of them depend on dismissal -
     * so callers don't need to await this promise.
     */
    _showAlert(message, title = 'Notice') {
        return new Promise((resolve) => {
            const overlay = document.createElement('div');
            overlay.className = 'modal-overlay';
            overlay.style.zIndex = '3000';

            const dialog = document.createElement('div');
            dialog.className = 'modal-dialog';
            dialog.style.minWidth = '320px';

            const header = document.createElement('div');
            header.className = 'modal-header';
            const titleEl = document.createElement('span');
            titleEl.className = 'modal-title';
            titleEl.textContent = title;
            const closeBtn = document.createElement('button');
            closeBtn.className = 'modal-close';
            closeBtn.innerHTML = '&times;';

            const finish = () => {
                document.removeEventListener('keydown', onKeydown);
                overlay.remove();
                resolve();
            };

            closeBtn.addEventListener('click', finish);
            header.appendChild(titleEl);
            header.appendChild(closeBtn);

            const body = document.createElement('div');
            body.className = 'modal-body';
            body.style.padding = '16px 20px';
            body.style.whiteSpace = 'pre-line';
            body.style.lineHeight = '1.5';
            body.textContent = message;

            const footer = document.createElement('div');
            footer.className = 'modal-footer';

            const okBtn = document.createElement('button');
            okBtn.className = 'btn-primary';
            okBtn.textContent = 'OK';
            okBtn.addEventListener('click', finish);
            footer.appendChild(okBtn);

            dialog.appendChild(header);
            dialog.appendChild(body);
            dialog.appendChild(footer);
            overlay.appendChild(dialog);
            document.body.appendChild(overlay);

            overlay.addEventListener('click', (e) => {
                if (e.target === overlay) finish();
            });

            const onKeydown = (e) => {
                if (e.key === 'Escape' || e.key === 'Enter') {
                    e.preventDefault();
                    finish();
                }
            };
            document.addEventListener('keydown', onKeydown);

            okBtn.focus();
        });
    }

    /**
     * Save flow shared by Ctrl-S and the menu "Save" item. Opens the Save dialog
     * (preset chips plus format selection), then saves the entire scene in one
     * file - unlike Export, it never narrows to the selected shape. Presets are
     * sent without an object id so the backend targets the whole session; raw
     * formats go through the combined /export/all endpoint, which merges every
     * shape into a single file.
     */
    async _saveScene() {
        if (this.sceneController.objects.size === 0) {
            this._showAlert('No objects in scene to save.');
            return;
        }

        const config = await showSaveModal();
        if (!config) return;

        try {
            let blob, downloadName;

            this.ui.showLoading('Saving...');

            if (config.preset) {
                // Whole-session preset export: no object id means the backend
                // targets every shape in the session.
                blob = await this.api.exportPreset(config.preset, this.sessionId);
                const ext = config.preset === '3mf' ? '3mf' : (config.preset === 'obj-texture' ? 'obj' : 'stl');
                downloadName = `project.${ext}`;
            } else {
                const format = (config.format || 'stl').toLowerCase();
                blob = await this.api.exportAll(format, this.sessionId);
                downloadName = `project.${format}`;
            }

            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = downloadName;
            a.click();
            URL.revokeObjectURL(url);
        } catch (err) {
            console.error('Save failed:', err);
            this._showAlert(`Save failed: ${err.message}`);
        } finally {
            this.ui.hideLoading();
        }
    }

    /**
     * Guard for Split/Merge/Subtract/Intersect: warns and returns true if any
     * of the given objects is marked not solid (open surface / holes - the
     * same condition shown as "Solid: No" in the properties panel). These ops
     * need watertight input, so the alert points toward the Solid tool rather
     * than letting the backend call fail opaquely. A missing/undefined
     * userData.isSolid counts as solid (untested objects - primitives, CSG
     * results, pasted copies - are assumed fine), matching the default used
     * when displaying the property.
     */
    _warnIfNotSolid(ids, opLabel) {
        const scene = this.sceneController;
        const notSolidIds = ids.filter((id) => {
            const obj = scene.objects.get(id);
            return !!(obj && obj.userData && obj.userData.isSolid === false);
        });
        if (notSolidIds.length === 0) return false;

        const plural = notSolidIds.length > 1;
        this._showAlert(
            `${plural ? `${notSolidIds.length} of the selected shapes are` : 'One of the selected shapes is'} ` +
            `not solid (open surface / holes in the mesh). Use the Solid tool to repair ` +
            `${plural ? 'them' : 'it'} before you ${opLabel}.`,
            'Solid Shape Required'
        );
        return true;
    }

    _initViewport() {
        const canvas = document.getElementById('viewport-canvas');
        const viewportDefaults = this._settings.viewport || {};
        const snapDefaults = this._settings.snap || {};
        this.sceneController = new SceneController(canvas, {
            smoothShading: viewportDefaults.smooth_shading ?? false,
            lodEnabled: viewportDefaults.lod_enabled ?? true,
            cameraFar: viewportDefaults.camera_far ?? 100000,
            gridSize: this._defaultPlateSize,
            simplePlate: this.simplePlateEnabled,
        });

        // Seed the initial view mode from .config (viewport.view_mode). addObject
        // applies the active mode to every part registered afterwards, so setting
        // it before any object exists is enough. Unknown values fall back to 'normal'.
        const validViewModes = ['normal', 'wireframe', 'transparent', 'wireframe-hybrid'];
        this.sceneController.setViewMode(validViewModes.includes(viewportDefaults.view_mode) ? viewportDefaults.view_mode : 'normal');

        // Set up the WebGL optimizer: buffer reuse, material caching, and render stats
        this.webglOptimizer = new WebGLOptimizer(this.sceneController);
        this.sceneController.setOptimizer(this.webglOptimizer);

        this.transformGizmo = new TransformGizmo(this.sceneController.camera, canvas);
        if (this.transformGizmo.setPivotMode) this.transformGizmo.setPivotMode(this._rotatePivotMode);
        if (this.transformGizmo.setRatioLock) this.transformGizmo.setRatioLock(this._lockRatioEnabled);
        this.cuttingPlane = new CuttingPlane(this.sceneController.scene);
        this.gridSnapper = new GridSnapper(this.sceneController.scene, {
            enabled: snapDefaults.grid_enabled ?? false,
            snapSize: snapDefaults.grid_size_mm ?? 1.0,
        });

        // Begin the render loop
        this.sceneController.start();

        // Frame the initial view; it is re-framed again once a model loads
        this.sceneController.resetView();

        // The infinite build plate starts enabled - apply its initial extent
        // now, then keep refreshing on an interval so it tracks drags, scales,
        // and any other change without hooks scattered across call sites.
        this._updateBuildPlateExtent(true);
        setInterval(() => {
            if (this.infinitePlateEnabled) this._updateBuildPlateExtent();
        }, 400);
    }

    /**
     * Applies the .config feature defaults that need DOM or scene state to take
     * effect at startup - theme classes, lighting treatments, and the button
     * states for every toggle whose default differs from the HTML markup.
     */
    _applyInitialSettings() {
        const ui = this.ui;
        const scene = this.sceneController;

        // Day/night theme: day mode flips to the light UI
        if (!this.nightModeEnabled) document.body.classList.add('light-mode');
        if (ui.btnDayMode) ui.btnDayMode.classList.toggle('active', this.nightModeEnabled);

        // Aesthetic mode and even lighting both reshape the light rig; apply
        // aesthetic first so even lighting can flatten on top of it.
        if (this.aestheticModeEnabled) {
            document.body.classList.add('aesthetic-mode');
            if (ui.btnAestheticMode) ui.btnAestheticMode.classList.add('active');
            if (scene.setDramaticLighting) scene.setDramaticLighting(true);
        }
        if (this.evenLightingEnabled) {
            scene.setEvenLighting(true, this.aestheticModeEnabled);
            const btn = ui.elements['btn-even-lighting'];
            if (btn) {
                btn.classList.add('active');
                btn.title = 'Even Lighting On';
            }
        }

        // View mode seeded from .config (viewport.view_mode). Wireframe also turns
        // on smooth shading, mirroring the runtime toggle's side effect; the
        // shading-button sync below picks that up. Button states track viewMode.
        if (scene.viewMode === 'wireframe') {
            scene.setSmoothShading(true);
        }
        this._updateViewModeButtonStates();

        // Shading and LOD button states track the SceneController's initial values
        const shadingBtn = ui.elements['btn-shading-toggle'];
        if (shadingBtn) {
            shadingBtn.classList.toggle('active', scene.smoothShading);
            shadingBtn.title = scene.smoothShading
                ? 'Smooth Shading On - click for flat/faceted shading'
                : 'Smooth Shading (off - flat/faceted shading is default)';
        }
        const lodBtn = ui.elements['btn-lod-toggle'];
        if (lodBtn) {
            lodBtn.classList.toggle('active', scene.lodEnabled);
            lodBtn.title = scene.lodEnabled ? 'LOD On - auto detail based on distance' : 'LOD Off - always highest detail';
        }

        // Build-plate furniture visibility and its buttons
        if (scene.setBuildPlateVisible) scene.setBuildPlateVisible(this.buildPlateVisible);
        if (ui.btnPlateToggle) ui.btnPlateToggle.classList.toggle('active', this.buildPlateVisible);
        if (scene.setAxisVisible) scene.setAxisVisible(this.axisVisible);
        if (ui.btnAxisToggle) ui.btnAxisToggle.classList.toggle('active', this.axisVisible);
        if (ui.btnInfinitePlate) ui.btnInfinitePlate.classList.toggle('active', this.infinitePlateEnabled);
        if (ui.btnSimplePlate) ui.btnSimplePlate.classList.toggle('active', this.simplePlateEnabled);

        // Grid snap button and size picker track the GridSnapper's initial state
        if (ui.btnGridSnap) ui.btnGridSnap.classList.toggle('active', this.gridSnapper.enabled);
        if (ui.btnGridSize) {
            const size = String(this.gridSnapper.snapSize);
            const offered = Array.from(ui.btnGridSize.options).some(o => o.value === size);
            if (offered) ui.btnGridSize.value = size;
        }

        // Smart snap button state
        if (ui.btnSmartSnap) ui.btnSmartSnap.classList.toggle('active', this.smartSnapEnabled);

        // Unit label and message-mute switch track the UIManager's initial values
        if (ui.btnUnitToggle) ui.btnUnitToggle.textContent = ui._currentUnit || 'mm';
        if (ui.messagesMuted && ui.btnMuteMessages) {
            ui.btnMuteMessages.classList.remove('active');
            ui.btnMuteMessages.title = 'Setting messages muted - click to unmute';
        }

        // Rotate-pivot checkbox tracks the initial pivot mode
        if (ui.chkRotatePivotCenter) ui.chkRotatePivotCenter.checked = this._rotatePivotMode === 'center';
    }

    _bindUIEvents() {
        const ui = this.ui;
        const scene = this.sceneController;
        const gizmo = this.transformGizmo;

        this.objectListPanel.init();

        // New-project handler
        ui.on('new', async () => {
            const hasObjects = scene.objects.size > 0;

            if (!hasObjects) {
                // The scene is already empty - nothing to discard; just reset
                // state and view and make sure the import prompt is showing.
                // No default cube: "New" leaves an empty scene rather than
                // adding a shape nobody asked for.
                this.sessionId = null;
                this.backendIds.clear();
                scene.deselectAll();
                gizmo.setEnabled(false);
                gizmo.detach();
                ui.updatePropertiesPanel({});
                scene.resetView();
                ui.showDropZone(true);
                return;
            }

            const choice = await new Promise((resolve) => {
                const overlay = document.createElement('div');
                overlay.className = 'modal-overlay';
                overlay.style.zIndex = '3000';

                const dialog = document.createElement('div');
                dialog.className = 'modal-dialog';
                dialog.style.minWidth = '320px';

                const header = document.createElement('div');
                header.className = 'modal-header';
                const titleEl = document.createElement('span');
                titleEl.className = 'modal-title';
                titleEl.textContent = 'New Project';
                const closeBtn = document.createElement('button');
                closeBtn.className = 'modal-close';
                closeBtn.innerHTML = '&times;';
                closeBtn.addEventListener('click', () => { overlay.remove(); resolve(null); });
                header.appendChild(titleEl);
                header.appendChild(closeBtn);

                const body = document.createElement('div');
                body.className = 'modal-body';
                body.style.padding = '16px 20px';
                body.innerHTML = '<p style="margin-bottom:8px;">Save changes before starting a new project?</p>';

                const footer = document.createElement('div');
                footer.className = 'modal-footer';

                const saveBtn = document.createElement('button');
                saveBtn.className = 'btn-primary';
                saveBtn.textContent = "Save";
                saveBtn.addEventListener('click', () => { overlay.remove(); resolve('save'); });

                const dontSaveBtn = document.createElement('button');
                dontSaveBtn.className = 'btn-secondary';
                dontSaveBtn.textContent = "Don't Save";
                dontSaveBtn.addEventListener('click', () => { overlay.remove(); resolve('discard'); });

                const cancelBtn = document.createElement('button');
                cancelBtn.className = 'btn-secondary';
                cancelBtn.textContent = 'Cancel';
                cancelBtn.addEventListener('click', () => { overlay.remove(); resolve(null); });

                footer.appendChild(saveBtn);
                footer.appendChild(dontSaveBtn);
                footer.appendChild(cancelBtn);

                dialog.appendChild(header);
                dialog.appendChild(body);
                dialog.appendChild(footer);
                overlay.appendChild(dialog);
                document.body.appendChild(overlay);

                overlay.addEventListener('click', (e) => {
                    if (e.target === overlay) {
                        overlay.remove();
                        resolve(null);
                    }
                });
            });

            if (choice === 'save') {
                await this._saveScene();
                if (scene.objects.size > 0) return;
            }

            if (choice === 'discard' || choice === null) {
                this.sessionId = null;
                this.backendIds.clear();
                for (const [id] of scene.objects) {
                    scene.removeObject(id);
                }
                scene.deselectAll();
                gizmo.setEnabled(false);
                gizmo.detach();
                ui.updatePropertiesPanel({});
                scene.resetView();
                ui.showDropZone(true);
            }
        });

        // Menu "New": re-dispatches the toolbar's 'new' action
        ui.on('menu-new', () => {
            ui.elements['btn-new'].click();
        });

        // Menu "Open": clears all objects, then imports (warns about unsaved changes first)
        ui.on('menu-open', async () => {
            const hasObjects = scene.objects.size > 0;

            if (hasObjects) {
                const choice = await new Promise((resolve) => {
                    const overlay = document.createElement('div');
                    overlay.className = 'modal-overlay';
                    overlay.style.zIndex = '3000';

                    const dialog = document.createElement('div');
                    dialog.className = 'modal-dialog';
                    dialog.style.minWidth = '320px';

                    const header = document.createElement('div');
                    header.className = 'modal-header';
                    const titleEl = document.createElement('span');
                    titleEl.className = 'modal-title';
                    titleEl.textContent = 'Open Project';
                    const closeBtn = document.createElement('button');
                    closeBtn.className = 'modal-close';
                    closeBtn.innerHTML = '&times;';
                    closeBtn.addEventListener('click', () => { overlay.remove(); resolve(null); });
                    header.appendChild(titleEl);
                    header.appendChild(closeBtn);

                    const body = document.createElement('div');
                    body.className = 'modal-body';
                    body.style.padding = '16px 20px';
                    body.innerHTML = '<p style="margin-bottom:8px;">Save changes before opening a new project?</p>';

                    const footer = document.createElement('div');
                    footer.className = 'modal-footer';

                    const saveBtn = document.createElement('button');
                    saveBtn.className = 'btn-primary';
                    saveBtn.textContent = "Save";
                    saveBtn.addEventListener('click', () => { overlay.remove(); resolve('save'); });

                    const dontSaveBtn = document.createElement('button');
                    dontSaveBtn.className = 'btn-secondary';
                    dontSaveBtn.textContent = "Don't Save";
                    dontSaveBtn.addEventListener('click', () => { overlay.remove(); resolve('discard'); });

                    const cancelBtn = document.createElement('button');
                    cancelBtn.className = 'btn-secondary';
                    cancelBtn.textContent = 'Cancel';
                    cancelBtn.addEventListener('click', () => { overlay.remove(); resolve(null); });

                    footer.appendChild(saveBtn);
                    footer.appendChild(dontSaveBtn);
                    footer.appendChild(cancelBtn);

                    dialog.appendChild(header);
                    dialog.appendChild(body);
                    dialog.appendChild(footer);
                    overlay.appendChild(dialog);
                    document.body.appendChild(overlay);

                    overlay.addEventListener('click', (e) => {
                        if (e.target === overlay) {
                            overlay.remove();
                            resolve(null);
                        }
                    });
                });

                if (choice === 'save') {
                    await this._saveScene();
                    if (scene.objects.size > 0) return;
                }

                if (choice === null) return;
            }

            // Wipe every object
            this.sessionId = null;
            this.backendIds.clear();
            for (const [id] of scene.objects) {
                scene.removeObject(id);
            }
            scene.deselectAll();
            gizmo.setEnabled(false);
            gizmo.detach();
            ui.updatePropertiesPanel({});

            // Open the file picker to choose what to import
            ui.triggerFilePicker();
        });

        // Menu "Save" and Ctrl-S both open the Save dialog, which saves the
        // entire scene in one file (format or preset) - never a single shape.
        ui.on('menu-save', () => this._saveScene());
        ui.on('save', () => this._saveScene());

        // Menu "Import": re-dispatches 'import' - the same file picker the toolbar button uses
        ui.on('menu-import', () => {
            ui._emit('import');
        });

        // Menu "Export": exports just the selected object as STL
        ui.on('menu-export', async () => {
            if (scene.objects.size === 0) {
                this._showAlert('No objects in scene to export.');
                return;
            }

            if (!scene.selectedObject) {
                this._showAlert('Select an object to export.');
                return;
            }

            // The selected shape must have server-side data to export. Some shapes
            // don't (e.g. pieces created by Separate, or a pasted copy whose backend
            // duplicate failed) - say so clearly instead of failing with a cryptic 400.
            const backendInfo = this.backendIds.get(scene.selectedObject);
            const objectId = backendInfo ? backendInfo.objectId : null;
            if (!hasId(objectId)) {
                this._showAlert('The selected object has no server data to export.');
                return;
            }

            try {
                const format = 'stl';
                ui.showLoading('Exporting...');

                const blob = await this.api.exportModel(format, this.sessionId, objectId);
                const downloadName = `object.${format}`;

                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = downloadName;
                a.click();
                URL.revokeObjectURL(url);
            } catch (err) {
                console.error('Export failed:', err);
                this._showAlert(`Export failed: ${err.message}`);
            } finally {
                ui.hideLoading();
            }
        });

        // Import handler
        ui.on('import', () => {
            ui.triggerFilePicker();
        });

        ui.on('importFiles', async (files) => {
            ui.showLoading('Importing model...');
            try {
                for (const file of files) {
                    const result = await this.api.uploadFile(file, this.sessionId ? { session_id: this.sessionId } : {});
                    if (result && result.objects) {
                        // Adopt the session id returned by the upload response
                        if (result.session_id) {
                            this.sessionId = result.session_id;
                        }
                        for (const objData of result.objects) {
                            const frontendId = this.meshSync.loadFromServer(objData, { snapToFloor: true, testHollow: true });
                            if (hasId(frontendId) && hasId(objData.id)) {
                                this.backendIds.set(frontendId, { sessionId: this.sessionId, objectId: objData.id });
                            }
                        }
                    }
                }
                scene.resetView();
                ui.showDropZone(false);
            } catch (err) {
                console.error('Import failed:', err);
                this._showAlert(`Import failed: ${err.message}`);
            } finally {
                ui.hideLoading();
            }
        });

        // Undo and redo handlers
        ui.on('undo', () => this._undo());
        ui.on('redo', () => this._redo());

        // Export flow
        ui.on('export', async () => {
            try {
                const exportConfig = await showExportModal();
                if (!exportConfig) return;

                const preset = exportConfig.preset || null;
                const format = (preset ? 'stl' : (exportConfig.format || 'stl')).toLowerCase();
                let blob, downloadName;

                ui.showLoading(`Exporting${preset ? ` (${preset})` : ''}...`);

                if (preset) {
                    // Quick presets go through the dedicated preset endpoint
                    const objectId = scene.selectedObject
                        ? (this.backendIds.get(scene.selectedObject)?.objectId ?? null)
                        : null;
                    blob = await this.api.exportPreset(preset, this.sessionId, objectId);
                    downloadName = `model_${preset}.${preset === '3mf' ? '3mf' : 'stl'}`;
                } else if (this.sessionId && scene.objects.size > 1) {
                    blob = await this.api.exportAll(format, this.sessionId);
                    downloadName = `combined_model.${format}`;
                } else if (scene.selectedObject) {
                    const backendInfo = this.backendIds.get(scene.selectedObject);
                    const objectId = backendInfo ? backendInfo.objectId : null;
                    blob = await this.api.exportModel(format, this.sessionId, objectId);
                    downloadName = `model.${format}`;
                } else {
                    blob = await this.api.exportModel(format);
                    downloadName = `model.${format}`;
                }

                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = downloadName;
                a.click();
                URL.revokeObjectURL(url);
            } catch (err) {
                console.error('Export failed:', err);
                this._showAlert(`Export failed: ${err.message}`);
            } finally {
                ui.hideLoading();
            }
        });

        // Hollow - hollows out a single selected object using a smart default
        // wall thickness (5% of its longest bounding-box dimension). Since it
        // only ever operates on one shape at a time, the selection must be
        // exactly one object before the modal opens.
        ui.on('hollow', async () => {
            const selectedIds = scene.getSelectedObjectIds().length > 0
                ? scene.getSelectedObjectIds()
                : (scene.selectedObject ? [scene.selectedObject] : []);
            if (selectedIds.length === 0) {
                this._showAlert('Select an object to hollow.');
                return;
            }
            if (selectedIds.length > 1) {
                this._showAlert('Hollow only works on one object at a time. Select a single shape.');
                return;
            }

            const [id] = selectedIds;
            const backendInfo = this.backendIds.get(id);
            if (!backendInfo || !hasId(backendInfo.objectId)) {
                this._showAlert(`Cannot hollow: object "${id}" has no backend ID. Re-import the file.`);
                return;
            }

            // The selected object's bounding box drives the modal's default
            // wall thickness (5% of its longest dimension) and slider range.
            const hollowBox = scene.getBoundingBox(id);
            const hollowDims = hollowBox
                ? { width: hollowBox.width, height: hollowBox.height, depth: hollowBox.depth }
                : null;

            const params = await showHollowModal(hollowDims);
            if (!params) return;

            ui.showLoading('Hollowing model...');
            try {
                const result = await this.api.post('/geometry/hollow', {
                    session_id: backendInfo.sessionId || this.sessionId,
                    object_id: backendInfo.objectId,
                    wall_thickness: params.wallThickness,
                    opening_size: params.openingSize,
                });
                if (result && hasId(result.id)) {
                    this.meshSync.replaceObject(id, result, false, true);
                }
            } catch (err) {
                console.error('Hollow failed:', err);
                this._showAlert(`Hollow failed: ${err.message}`);
            } finally {
                ui.hideLoading();
            }
        });

        // Solid - makes every selected object watertight by repairing its mesh
        ui.on('solid', async () => {
            const selectedIds = scene.getSelectedObjectIds().length > 0
                ? scene.getSelectedObjectIds()
                : (scene.selectedObject ? [scene.selectedObject] : []);
            if (selectedIds.length === 0) {
                this._showAlert('Select an object to make solid.');
                return;
            }

            ui.showLoading('Making objects solid...');
            try {
                for (const id of selectedIds) {
                    const backendInfo = this.backendIds.get(id);
                    if (!backendInfo || !hasId(backendInfo.objectId)) {
                        this._showAlert(`Cannot make solid: object "${id}" has no backend ID. Re-import the file.`);
                        return;
                    }
                    const result = await this.api.repairMesh(backendInfo.sessionId || this.sessionId, backendInfo.objectId);
                    if (result && hasId(result.id)) {
                        this.meshSync.replaceObject(id, result, false, true);
                    }
                }
            } catch (err) {
                console.error('Solid failed:', err);
                this._showAlert(`Solid failed: ${err.message}`);
            } finally {
                ui.hideLoading();
            }
        });

        // Copy - snapshots the current selection onto the clipboard for a later paste
        ui.on('copy', () => {
            const ids = scene.getSelectedObjectIds().length > 0
                ? scene.getSelectedObjectIds()
                : (scene.selectedObject ? [scene.selectedObject] : []);
            if (ids.length === 0) {
                this._showAlert('Select an object to copy.');
                return;
            }
            this._clipboard = {
                mode: 'copy',
                entries: ids.map(id => ({ frontendId: id, backendInfo: this.backendIds.get(id) || null })),
            };
        });

        // Cut - like copy, but also hides the source objects until they're pasted
        ui.on('cut', () => {
            const ids = scene.getSelectedObjectIds().length > 0
                ? scene.getSelectedObjectIds()
                : (scene.selectedObject ? [scene.selectedObject] : []);
            if (ids.length === 0) {
                this._showAlert('Select an object to cut.');
                return;
            }
            this._clipboard = {
                mode: 'cut',
                entries: ids.map(id => ({ frontendId: id, backendInfo: this.backendIds.get(id) || null })),
            };
            ids.forEach(id => {
                const obj = scene.objects.get(id);
                if (obj) obj.visible = false;
            });
        });

        // Paste - duplicates the clipboard entries into the scene, offset so
        // they don't overlap the originals. A copy can be pasted repeatedly;
        // a cut is consumed by its first paste and then removes the originals.
        ui.on('paste', async () => {
            if (!this._clipboard || this._clipboard.entries.length === 0) {
                this._showAlert('Nothing to paste - copy or cut an object first.');
                return;
            }

            ui.showLoading('Pasting...');
            const pastedIds = [];
            try {
                for (const entry of this._clipboard.entries) {
                    const sourceObj = scene.objects.get(entry.frontendId);
                    if (!sourceObj) continue;

                    const geometry = sourceObj.geometry.clone();
                    const material = sourceObj.material.clone();
                    // If the source object is currently selected, its material
                    // carries the selection-highlight color in `emissive`.
                    // Cloning it verbatim would bake that tint into the new
                    // object permanently - the fresh mesh has no _origEmissive
                    // backup yet, so the next selection/deselection cycle would
                    // "restore" it straight back to the highlight color. Zeroing
                    // it here keeps pasted copies looking unselected from the start.
                    if (material.emissive) {
                        material.emissive.setHex(0x000000);
                    }
                    material.emissiveIntensity = 0;
                    const mesh = new THREE.Mesh(geometry, material);
                    const newFrontendId = `obj_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
                    mesh.name = newFrontendId;

                    // Apply an x-offset so the pasted copy doesn't land exactly on top of the original
                    mesh.position.copy(sourceObj.position);
                    mesh.position.x += 10;
                    mesh.rotation.copy(sourceObj.rotation);
                    mesh.scale.copy(sourceObj.scale);

                    scene.addObject(mesh, newFrontendId);

                    // Mirror the duplicate on the backend as well, so the pasted
                    // copy keeps full support for repair, boolean ops, and export.
                    if (entry.backendInfo && hasId(entry.backendInfo.objectId)) {
                        try {
                            const result = await this.api.duplicateObject(
                                entry.backendInfo.sessionId || this.sessionId,
                                entry.backendInfo.objectId
                            );
                            if (result && hasId(result.id)) {
                                this.backendIds.set(newFrontendId, { sessionId: entry.backendInfo.sessionId || this.sessionId, objectId: result.id });
                            }
                        } catch (err) {
                            console.warn('Backend duplicate failed - pasted copy will need re-importing before repair/boolean ops/export will work:', err.message);
                        }
                    }

                    pastedIds.push(newFrontendId);
                }

                // Once a cut has been pasted, remove its originals - a cut moves rather than copies.
                if (this._clipboard.mode === 'cut') {
                    for (const entry of this._clipboard.entries) {
                        scene.removeObject(entry.frontendId);
                        this.backendIds.delete(entry.frontendId);
                    }
                    this._clipboard = null;
                }

                scene.deselectAll();
                pastedIds.forEach(id => scene.toggleObjectSelection(id));
                this._updatePropertiesForSelected();
                this._updateBuildPlateExtent();
            } catch (err) {
                console.error('Paste failed:', err);
                this._showAlert(`Paste failed: ${err.message}`);
            } finally {
                ui.hideLoading();
            }
        });

        // Deselect all - drops the selection state without modifying any object
        ui.on('deselectAll', () => {
            scene.deselectAll();
            gizmo.setEnabled(false);
            gizmo.detach();
            ui.updatePropertiesPanel({});
        });

        // Merge/Union handler: requires a multi-object selection
        ui.on('union', async () => {
            const selectedIds = scene.getSelectedObjectIds();

            if (selectedIds.length < 2) {
                this._showAlert('Select at least 2 objects to merge (click to multi-select).');
                return;
            }

            if (this._warnIfNotSolid(selectedIds, 'merge these shapes')) return;

            // Verify that every selected object has a backend id
            for (const id of selectedIds) {
                const info = this.backendIds.get(id);
                if (!info || !hasId(info.objectId)) {
                    this._showAlert(`Object "${id}" has no backend data. Import it first.`);
                    return;
                }
            }

            // Sync any pending client-side transforms first, so the backend
            // operates on the visually-correct vertex positions rather than
            // stale created/imported ones.
            await this._commitTransforms(selectedIds);

            // Re-resolve the selection, since _commitTransforms may have swapped in replacement objects
            const currentSelected = scene.getSelectedObjectIds();

            ui.showLoading('Merging objects...');
            try {
                const objectIds = currentSelected.map(id => this.backendIds.get(id).objectId);
                const sessionInfo = this.backendIds.get(currentSelected[0]);
                const result = await this.api.unionObjects(sessionInfo.sessionId || this.sessionId, objectIds);

                // Remove every source object from the scene (some may already have been replaced by _commitTransforms)
                for (const id of currentSelected) {
                    scene.removeObject(id);
                    this.backendIds.delete(id);
                }

                if (result && hasId(result.id)) {
                    const newFrontendId = this.meshSync.loadFromServer(result);
                    if (hasId(newFrontendId) && hasId(result.id)) {
                        this.backendIds.set(newFrontendId, { sessionId: sessionInfo.sessionId || this.sessionId, objectId: result.id });
                    }
                }
                scene.resetView();
            } catch (err) {
                console.error('Union failed:', err);
                this._showAlert(`Union failed: ${err.message}`);
            } finally {
                ui.hideLoading();
            }
        });

        // Subtract - each selected shape acts as a cutting tool, subtracting
        // itself from every other shape in the session it intersects, applied
        // one tool at a time. A tool is consumed (removed) only if it actually
        // cut something.
        ui.on('subtract', async () => {
            const selectedIds = scene.getSelectedObjectIds();

            if (selectedIds.length < 1) {
                this._showAlert('Select one or more objects to use as the cutting tool (click to multi-select). Each will be subtracted from every shape it overlaps.');
                return;
            }

            if (this._warnIfNotSolid(selectedIds, 'use these shapes to subtract')) return;

            // Verify that every selected object has a backend id
            for (const id of selectedIds) {
                const info = this.backendIds.get(id);
                if (!info || !hasId(info.objectId)) {
                    this._showAlert(`Object "${id}" has no backend data. Import it first.`);
                    return;
                }
            }

            // Sync any pending client-side transforms first, so the backend
            // operates on the visually-correct vertex positions.
            await this._commitTransforms(selectedIds);

            // Re-resolve the selection, since _commitTransforms may have swapped in replacement objects
            const currentSelected = scene.getSelectedObjectIds();

            ui.showLoading('Subtracting...');
            try {
                const toolIds = currentSelected.map(id => this.backendIds.get(id).objectId);
                const allObjectIds = Array.from(this.backendIds.values()).map(info => info.objectId);
                const targetIds = allObjectIds.filter(id => !toolIds.includes(id));

                if (targetIds.length === 0) {
                    this._showAlert('Select one or more objects to subtract from, with at least one other object in the scene.');
                    ui.hideLoading();
                    return;
                }

                const sessionInfo = this.backendIds.get(currentSelected[0]);
                const actualSessionId = sessionInfo.sessionId || this.sessionId;

                const result = await this.api.subtractObjects(actualSessionId, targetIds, toolIds);

                // Build a backend-objectId → frontendId map over everything
                // currently in the scene, so each updated/removed id returned by
                // the result can be matched back to its mesh.
                const objectIdToFrontendId = new Map();
                for (const [frontendId, info] of this.backendIds.entries()) {
                    objectIdToFrontendId.set(info.objectId, frontendId);
                }

                // Delete any tool that was actually consumed (it cut something)
                for (const toolBackendId of (result.removed_tool_ids || [])) {
                    const frontendId = objectIdToFrontendId.get(toolBackendId);
                    if (frontendId) {
                        scene.removeObject(frontendId);
                        this.backendIds.delete(frontendId);
                    }
                }

                // Swap in a fresh mesh for each target that was actually cut
                for (const updatedObj of (result.updated || [])) {
                    const frontendId = objectIdToFrontendId.get(updatedObj.previous_id);
                    if (frontendId) {
                        scene.removeObject(frontendId);
                        this.backendIds.delete(frontendId);
                    }
                    const newFrontendId = this.meshSync.loadFromServer(updatedObj);
                    this.backendIds.set(newFrontendId, { sessionId: actualSessionId, objectId: updatedObj.id });
                }

                if (!result.updated || result.updated.length === 0) {
                    this._showAlert('The selected object(s) did not intersect any other shapes - nothing was subtracted.');
                }

                scene.resetView();
            } catch (err) {
                console.error('Subtract failed:', err);
                this._showAlert(`Subtract failed: ${err.message}`);
            } finally {
                ui.hideLoading();
            }
        });

        // Intersect handler: requires at least two selected objects
        ui.on('intersect', async () => {
            const selectedIds = scene.getSelectedObjectIds();

            if (selectedIds.length < 2) {
                this._showAlert('Select at least 2 objects to intersect (click to multi-select).');
                return;
            }

            if (this._warnIfNotSolid(selectedIds, 'intersect these shapes')) return;

            // Verify that every selected object has a backend id
            for (const id of selectedIds) {
                const info = this.backendIds.get(id);
                if (!info || !hasId(info.objectId)) {
                    this._showAlert(`Object "${id}" has no backend data. Import it first.`);
                    return;
                }
            }

            // Sync any pending client-side transforms first, so the backend
            // operates on the visually-correct vertex positions.
            await this._commitTransforms(selectedIds);

            // Re-resolve the selection, since _commitTransforms may have swapped in replacement objects
            const currentSelected = scene.getSelectedObjectIds();

            ui.showLoading('Intersecting...');
            try {
                const objectIds = currentSelected.map(id => this.backendIds.get(id).objectId);
                const sessionInfo = this.backendIds.get(currentSelected[0]);
                const result = await this.api.intersectObjects(sessionInfo.sessionId || this.sessionId, objectIds);

                // Remove every source object from the scene (some may already have been replaced by _commitTransforms)
                for (const id of currentSelected) {
                    scene.removeObject(id);
                    this.backendIds.delete(id);
                }

                if (result && hasId(result.id)) {
                    const newFrontendId = this.meshSync.loadFromServer(result);
                    if (hasId(newFrontendId) && hasId(result.id)) {
                        this.backendIds.set(newFrontendId, { sessionId: sessionInfo.sessionId || this.sessionId, objectId: result.id });
                    }
                }
                scene.resetView();
            } catch (err) {
                console.error('Intersect failed:', err);
                this._showAlert(`Intersect failed: ${err.message}`);
            } finally {
                ui.hideLoading();
            }
        });

        // Simplify handler: shows a live polygon-count preview while the slider moves
        this._simplifyPreviewTimer = null;
        ui.on('simplify', async () => {
            if (!scene.selectedObject) {
                this._showAlert('Select an object to simplify.');
                return;
            }
            const backendInfo = this.backendIds.get(scene.selectedObject);
            if (!backendInfo || !hasId(backendInfo.objectId)) {
                this._showAlert('Cannot simplify: object has no backend ID. Re-import the file.');
                return;
            }

            const meshData = scene.getObjectMesh(scene.selectedObject);
            const currentFaces = meshData?.indices ? meshData.indices.length / 3 : (meshData?.vertices ? meshData.vertices.length / 3 : 0);

            const params = await showSimplifyModal(Math.round(currentFaces), async (reductionPercent) => {
                if (this._simplifyPreviewTimer) clearTimeout(this._simplifyPreviewTimer);
                this._simplifyPreviewTimer = setTimeout(async () => {
                    try {
                        const preview = await this.api.previewSimplify(backendInfo.sessionId || this.sessionId, backendInfo.objectId, reductionPercent);
                        if (preview && preview.preview_faces !== undefined) {
                            const estEl = document.getElementById('modal-simplify-estimated');
                            if (estEl) {
                                estEl.textContent = `${preview.preview_faces.toLocaleString()} faces (${(preview.estimated_ratio * 100).toFixed(0)}%)`;
                            }
                        }
                    } catch (err) {
                        console.error('Simplify preview failed:', err);
                    }
                }, 250);
            });

            if (this._simplifyPreviewTimer) clearTimeout(this._simplifyPreviewTimer);
            if (!params) return;

            ui.showLoading('Simplifying mesh...');
            try {
                const result = await this.api.simplifyMesh(backendInfo.sessionId || this.sessionId, backendInfo.objectId, params.reductionPercent);
                if (result && hasId(result.id)) {
                    this.meshSync.replaceObject(scene.selectedObject, result, true);
                }
            } catch (err) {
                console.error('Simplify failed:', err);
                this._showAlert(`Simplify failed: ${err.message}`);
            } finally {
                ui.hideLoading();
            }
        });

        // Smooth handler
        ui.on('smooth', async () => {
            if (!scene.selectedObject) {
                this._showAlert('Select an object to smooth.');
                return;
            }
            const backendInfo = this.backendIds.get(scene.selectedObject);
            if (!backendInfo || !hasId(backendInfo.objectId)) {
                this._showAlert('Cannot smooth: object has no backend ID. Re-import the file.');
                return;
            }

            const params = await showSmoothModal();
            if (!params) return;

            ui.showLoading('Smoothing mesh...');
            try {
                const result = await this.api.smoothMesh(backendInfo.sessionId || this.sessionId, backendInfo.objectId, params.iterations);
                if (result && hasId(result.id)) {
                    this.meshSync.replaceObject(scene.selectedObject, result, true);
                }
            } catch (err) {
                console.error('Smooth failed:', err);
                this._showAlert(`Smooth failed: ${err.message}`);
            } finally {
                ui.hideLoading();
            }
        });

        // Fillet - rounds the edges of every selected object
        ui.on('fillet', async () => {
            const selectedIds = scene.getSelectedObjectIds();
            if (selectedIds.length === 0) {
                this._showAlert('Select an object to fillet.');
                return;
            }

            for (const id of selectedIds) {
                const info = this.backendIds.get(id);
                if (!info || !hasId(info.objectId)) {
                    this._showAlert(`Object "${id}" has no backend data. Import it first.`);
                    return;
                }
            }

            // The (first) selected object's bounding box drives the modal's
            // default radius (5% of its smallest dimension) and slider range.
            const filletBox = scene.getBoundingBox(selectedIds[0]);
            const filletDims = filletBox
                ? { width: filletBox.width, height: filletBox.height, depth: filletBox.depth }
                : null;

            const params = await showFilletModal(filletDims);
            if (!params) return;

            ui.showLoading('Applying fillet...');
            try {
                for (const id of selectedIds) {
                    const info = this.backendIds.get(id);
                    const actualSessionId = info.sessionId || this.sessionId;
                    const result = await this.api.filletMesh(actualSessionId, info.objectId, params.radius, params.segments);
                    if (result && hasId(result.id)) {
                        this.meshSync.replaceObject(id, result, true);
                    }
                }
                scene.resetView();
            } catch (err) {
                console.error('Fillet failed:', err);
                this._showAlert(`Fillet failed: ${err.message}`);
            } finally {
                ui.hideLoading();
            }
        });

        // Chamfer - bevels the edges of every selected object
        ui.on('chamfer', async () => {
            const selectedIds = scene.getSelectedObjectIds();
            if (selectedIds.length === 0) {
                this._showAlert('Select an object to chamfer.');
                return;
            }

            for (const id of selectedIds) {
                const info = this.backendIds.get(id);
                if (!info || !hasId(info.objectId)) {
                    this._showAlert(`Object "${id}" has no backend data. Import it first.`);
                    return;
                }
            }

            // The (first) selected object's bounding box drives the modal's
            // default distance (5% of its smallest dimension) and slider range.
            const chamferBox = scene.getBoundingBox(selectedIds[0]);
            const chamferDims = chamferBox
                ? { width: chamferBox.width, height: chamferBox.height, depth: chamferBox.depth }
                : null;

            const params = await showChamferModal(chamferDims);
            if (!params) return;

            ui.showLoading('Applying chamfer...');
            try {
                for (const id of selectedIds) {
                    const info = this.backendIds.get(id);
                    const actualSessionId = info.sessionId || this.sessionId;
                    const result = await this.api.chamferMesh(actualSessionId, info.objectId, params.distance, params.segments);
                    if (result && hasId(result.id)) {
                        this.meshSync.replaceObject(id, result, true);
                    }
                }
                scene.resetView();
            } catch (err) {
                console.error('Chamfer failed:', err);
                this._showAlert(`Chamfer failed: ${err.message}`);
            } finally {
                ui.hideLoading();
            }
        });

        // Separate - for each selected object, detects any physically
        // disconnected pieces of geometry (e.g. a sphere and a cube that
        // aren't touching) and splits them out into their own individual
        // models. Purely topological, so it runs entirely client-side with no
        // backend round trip; objects made of a single connected piece are left
        // untouched.
        ui.on('separate', async () => {
            const selectedIds = scene.getSelectedObjectIds ? scene.getSelectedObjectIds() : [];
            if (!selectedIds || selectedIds.length === 0) {
                this._showAlert('Select an object to separate.');
                return;
            }

            const jobs = [];
            for (const id of selectedIds) {
                const obj = scene.objects.get(id);
                if (!obj || !obj.isMesh) continue;
                const pieces = this.meshSync._findConnectedComponents(obj);
                if (pieces && pieces.length > 1) {
                    jobs.push({ id, pieces });
                }
            }

            if (jobs.length === 0) {
                this._showAlert('No disconnected pieces found in the current selection.');
                return;
            }

            ui.showLoading('Separating pieces...');
            try {
                for (const job of jobs) {
                    scene.removeObject(job.id);
                    this.backendIds.delete(job.id);
                    job.pieces.forEach((piece, i) => {
                        piece.id = `${job.id}_part${i + 1}_${Math.random().toString(36).slice(2, 8)}`;
                        this.meshSync.loadFromServer(piece);
                    });
                }
                scene.resetView();
            } catch (err) {
                console.error('Separate failed:', err);
                this._showAlert(`Separate failed: ${err.message}`);
            } finally {
                ui.hideLoading();
            }
        });

        // Handles primitive-type selection coming from the palette.
        // (PrimitivePalette binds its own click listener directly to the
        // #btn-primitives trigger to open/close the dropdown - see PrimitivePalette.js.)
        this.primitivePalette.onSelect = async (type) => {
            const params = await showPrimitiveModal(type);
            if (!params) return;

            try {
                const result = await this.api.createPrimitive(this.sessionId, params.type, params);
                if (result && result.objects) {
                    // Keep the session_id returned by the response around for later operations
                    if (result.session_id) {
                        this.sessionId = result.session_id;
                    }
                    for (const objData of result.objects) {
                        const frontendId = this.meshSync.loadFromServer(objData, { snapToFloor: true });
                        if (hasId(frontendId) && hasId(objData.id)) {
                            this.backendIds.set(frontendId, { sessionId: this.sessionId, objectId: objData.id });
                        }
                    }
                    scene.resetView();
                    ui.showDropZone(false);
                }
            } catch (err) {
                console.error('Primitive creation failed:', err);
                this._showAlert(`Primitive creation failed: ${err.message}`);
            }
        };

        // Generation panel - on open, first refresh whether the in-place "Edit"
        // action is offered (only valid with exactly one object selected), then loads
        // the local .gguf models and saved OpenAI provider configs to populate the picker.
        ui.on('openAiModal', async () => {
            // First open of AI mode per page load: ask the backend to sweep residual
            // job folders left in ai/input + ai/output by a generation whose server
            // died mid-run. Fire-and-forget - a cleanup failure must not block the panel.
            if (!this._aiFirstOpenCleaned) {
                this._aiFirstOpenCleaned = true;
                this.api.cleanupAi().catch((err) => console.error('AI scratch cleanup failed:', err));
            }
            const selectedIds = scene.getSelectedObjectIds().length > 0
                ? scene.getSelectedObjectIds()
                : (scene.selectedObject ? [scene.selectedObject] : []);
            ui.setAiEditAvailable(selectedIds.length === 1);
            ui.showAiModal();
            try {
                const result = await this.api.getAiModels();
                ui.populateAiModels(result && result.models, result && result.providers);
            } catch (err) {
                console.error('Failed to list AI models:', err);
                ui.populateAiModels(null, null, 'Failed to load models - is the backend running?');
            }
        });

        // Re-fetches /ai/models and rebuilds the picker, optionally re-selecting
        // an entry (used after saving/deleting a provider config so the list
        // and its fields stay in sync with ai/models on disk).
        const refreshAiModelList = async (selectValue) => {
            try {
                const result = await this.api.getAiModels();
                ui.populateAiModels(result && result.models, result && result.providers);
                if (selectValue && ui.aiModelSelect) {
                    ui.aiModelSelect.value = selectValue;
                    ui._syncOpenAiFieldsForSelection();
                }
            } catch (err) {
                console.error('Failed to refresh AI models:', err);
            }
        };

        // Saves the OpenAI-compatible API config: updates the selected json in
        // place when one is chosen, otherwise creates a new file (the backend
        // mints <provider>_<model>.json with an incrementing index on duplicates).
        ui.on('aiSaveProvider', async (data) => {
            if (!data.provider_name || !data.url || !data.model_name) {
                this._showAlert('Provider Name, URL and Model Name are required to save.');
                return;
            }
            try {
                const saved = await this.api.saveAiProvider(data);
                await refreshAiModelList(saved && saved.file ? saved.file : null);
            } catch (err) {
                console.error('Failed to save provider config:', err);
                this._showAlert(`Could not save the API config: ${err.message}`);
            }
        });

        // Deletes a saved provider json and clears the fields; in "* Add OpenAI
        // API *" mode there is no file yet, so deleting just clears them.
        ui.on('aiDeleteProvider', async ({ file }) => {
            if (!file) {
                ui.clearAiProviderFields();
                return;
            }
            try {
                await this.api.deleteAiProvider(file);
                ui.clearAiProviderFields();
                await refreshAiModelList(null);
            } catch (err) {
                console.error('Failed to delete provider config:', err);
                this._showAlert(`Could not delete the API config: ${err.message}`);
            }
        });

        ui.on('closeAiModal', () => {
            // Generation runs as a background job that the modal doesn't own,
            // but we still don't want it to disappear out from under an in-flight
            // job with no way back to its Stop button - so require Stop first.
            // (setAiGenerating(true) already disables the close button and
            // backdrop-click for the same reason; this is a backstop.)
            if (this._aiJob) return;
            ui.hideAiModal();
        });

        // Polls the generation status endpoint for <job_id> until the job finishes, cancels, or errors,
        // updating the progress bar and description text as it goes. It runs
        // independently of whether the modal is open - though in practice the
        // modal blocks closing while a job is active.
        const pollAiJob = async (jobId) => {
            let status;
            try {
                status = await this.api.getAiStatus(jobId);
            } catch (err) {
                console.error('AI status check failed:', err);
                // A 404 means the backend no longer knows this job - e.g. the server
                // restarted mid-generation. Polling a dead job can never recover it,
                // so stop and say why instead of sitting on "loading" forever.
                if (/\b404\b/.test(err.message || '')) {
                    if (this._aiJob && this._aiJob.jobId === jobId) {
                        const timer = this._aiJob.pollTimer;
                        if (timer) clearTimeout(timer);
                        this._aiJob = null;
                        ui.setAiGenerating(false);
                        this._showAlert('The generation was lost - the server restarted while it was running.');
                    }
                } else {
                    // Other failures are transient network hiccups - keep polling
                    // rather than giving up on a slow machine mid-generation.
                    if (this._aiJob && this._aiJob.jobId === jobId) {
                        this._aiJob.pollTimer = setTimeout(() => pollAiJob(jobId), 1500);
                    }
                }
                return;
            }

            if (!this._aiJob || this._aiJob.jobId !== jobId) return; // job was superseded or stopped

            if (status.status === 'running') {
                const pct = (status.iteration && status.max_iterations)
                    ? (status.iteration / status.max_iterations) * 100
                    : null;
                ui.setAiProgress(pct, status.message || 'Working…', pct === null);
                this._aiJob.pollTimer = setTimeout(() => pollAiJob(jobId), 800);
                return;
            }

            if (status.status === 'cancelled') {
                this._aiJob = null;
                ui.setAiGenerating(false);
                ui.setAiProgress(0, '', true);
                return;
            }

            if (status.status === 'error') {
                this._aiJob = null;
                ui.setAiGenerating(false);
                this._showAlert(`AI generation failed: ${status.error || 'unknown error'}`);
                return;
            }

            // The job finished successfully ('done')
            const { mode, targetFrontendId } = this._aiJob;
            this._aiJob = null;
            try {
                const result = status.result;
                if (result && result.session_id) {
                    this.sessionId = result.session_id;
                }

                if (mode === 'edit' && result && hasId(result.id)) {
                    this.meshSync.replaceObject(targetFrontendId, result, false, true);
                } else if (result && result.objects) {
                    for (const objData of result.objects) {
                        const frontendId = this.meshSync.loadFromServer(objData, { snapToFloor: true });
                        if (hasId(frontendId) && hasId(objData.id)) {
                            this.backendIds.set(frontendId, { sessionId: this.sessionId, objectId: objData.id });
                        }
                    }
                    scene.resetView();
                    ui.showDropZone(false);
                } else {
                }

                ui.setAiGenerating(false);
                ui.hideAiModal();
                if (ui.aiPromptInput) ui.aiPromptInput.value = '';
            } catch (err) {
                console.error('Failed to apply AI generation result:', err);
                this._showAlert(`AI generation failed: ${err.message}`);
                ui.setAiGenerating(false);
            }
        };

        ui.on('aiGenerate', async ({ mode, prompt, model, provider }) => {
            if (!prompt) {
                this._showAlert('Describe what you want the AI to create or change.');
                return;
            }
            // The picker points at an OpenAI context (add entry or saved json),
            // but its required fields are not all filled in yet.
            const openAiSelected = model === AI_OPENAI_ADD_OPTION || (typeof model === 'string' && model.endsWith('.json'));
            if (openAiSelected && !provider) {
                this._showAlert('Fill in the OpenAI API details - Provider Name, URL and Model Name are required.');
                return;
            }
            if (!model && !provider) {
                this._showAlert('Choose a model before generating.');
                return;
            }

            let backendInfo = null;
            let targetFrontendId = null;
            if (mode === 'edit') {
                const selectedIds = scene.getSelectedObjectIds().length > 0
                    ? scene.getSelectedObjectIds()
                    : (scene.selectedObject ? [scene.selectedObject] : []);
                if (selectedIds.length !== 1) {
                    this._showAlert('Select exactly one shape to edit with AI.');
                    return;
                }
                targetFrontendId = selectedIds[0];
                backendInfo = this.backendIds.get(targetFrontendId);
                if (!backendInfo || !hasId(backendInfo.objectId)) {
                    this._showAlert('Cannot edit: object has no backend ID. Re-import the file.');
                    return;
                }
            }

            ui.setAiGenerating(true);
            ui.setAiProgress(null, 'Starting AI generation…', true);
            try {
                const { job_id: jobId } = await this.api.generateAi({
                    mode,
                    prompt,
                    model,
                    provider,
                    sessionId: (backendInfo && backendInfo.sessionId) || this.sessionId,
                    objectId: backendInfo ? backendInfo.objectId : null,
                });
                if (!hasId(jobId)) {
                    throw new Error('Backend did not return a job id.');
                }
                this._aiJob = { jobId, mode, targetFrontendId, pollTimer: null };
                pollAiJob(jobId);
            } catch (err) {
                console.error('AI generation failed to start:', err);
                this._showAlert(`AI generation failed: ${err.message}`);
                ui.setAiGenerating(false);
            }
        });

        ui.on('aiStop', async () => {
            if (!this._aiJob) return;
            const { jobId, pollTimer } = this._aiJob;
            if (pollTimer) clearTimeout(pollTimer);
            ui.setAiProgress(null, 'Stopping…', true);
            ui.setAiStopping(true);
            try {
                await this.api.cancelAi(jobId);
            } catch (err) {
                console.error('Failed to cancel AI job:', err);
            } finally {
                ui.setAiStopping(false);
            }
            // The cancel call above only requests termination - resume polling
            // so we observe the authoritative 'cancelled' status once the
            // backend process actually exits, instead of assuming it succeeded.
            if (this._aiJob && this._aiJob.jobId === jobId) {
                pollAiJob(jobId);
            }
        });

        // View-mode toggle handlers
        ui.on('toggleWireframe', () => {
            const current = scene.viewMode;
            const enabling = current !== 'wireframe';
            scene.setViewMode(enabling ? 'wireframe' : 'normal');
            this._updateViewModeButtonStates();
            ui.showToggleMessage(enabling ? '◫ Wireframe view enabled' : '◫ Wireframe view disabled');

            if (enabling) {
                scene.setSmoothShading(true);
                const btn = this.ui.elements['btn-shading-toggle'];
                if (btn) {
                    btn.classList.add('active');
                    btn.title = 'Smooth Shading On - click for flat/faceted shading';
                }
                ui.showToggleMessage('◐ Smooth shading enabled');
            }
        });

        ui.on('toggleTransparent', () => {
            const current = scene.viewMode;
            const enabling = current !== 'transparent';
            scene.setViewMode(enabling ? 'transparent' : 'normal');
            this._updateViewModeButtonStates();
            ui.showToggleMessage(enabling ? '◎ Transparent view enabled' : '◎ Transparent view disabled');
        });

        ui.on('toggleWireframeHybrid', () => {
            const current = scene.viewMode;
            const enabling = current !== 'wireframe-hybrid';
            scene.setViewMode(enabling ? 'wireframe-hybrid' : 'normal');
            this._updateViewModeButtonStates();
            ui.showToggleMessage(enabling ? '◫ Wireframe hybrid view enabled' : '◫ Wireframe hybrid view disabled');
        });

        ui.on('toggleSmoothShading', () => {
            const enabled = !scene.smoothShading;
            scene.setSmoothShading(enabled);

            const btn = this.ui.elements['btn-shading-toggle'];
            if (btn) {
                btn.classList.toggle('active', enabled);
                btn.title = enabled
                    ? 'Smooth Shading On - click for flat/faceted shading'
                    : 'Smooth Shading (off - flat/faceted shading is default)';
            }

            ui.showToggleMessage(enabled
                ? '◐ Smooth shading enabled'
                : '◑ Flat shading (raw polygons)');
        });

        ui.on('toggleEvenLighting', () => {
            const enabled = !this.evenLightingEnabled;
            this.evenLightingEnabled = enabled;
            scene.setEvenLighting(enabled, this.aestheticModeEnabled);

            const btn = this.ui.elements['btn-even-lighting'];
            if (btn) {
                btn.classList.toggle('active', enabled);
                btn.title = enabled ? 'Even Lighting On' : 'Even Lighting (off)';
            }

            ui.showToggleMessage(enabled
                ? '☉ Even lighting enabled - all surfaces lit evenly'
                : '☉ Even lighting disabled');
        });

        ui.on('toggleLod', () => {
            const enabled = !scene.lodEnabled;
            scene.toggleLod(enabled);

            const btn = this.ui.elements['btn-lod-toggle'];
            if (btn) {
                btn.classList.toggle('active', enabled);
                btn.title = enabled ? 'LOD On - auto detail based on distance' : 'LOD Off - always highest detail';
            }

            ui.showToggleMessage(enabled
                ? 'LOD Enabled - detail adjusts as you zoom in/out'
                : 'LOD Disabled - always highest detail');
        });

        // Render-stats toggle
        ui.on('toggleRenderStats', () => {
            const isHidden = !this.webglOptimizer || ui.renderStatsEl.classList.contains('hidden');
            
            if (!this.webglOptimizer) {
                ui.showToggleMessage('WebGL optimizer not initialized');
                return;
            }

            if (isHidden) {
                // Show the render stats, refreshed on an interval (see below)
                ui.renderStatsEl.classList.remove('hidden');
                this._renderStatsVisible = true;
                
                // Begin the periodic stats-update timer
                if (this._statsUpdateTimer) clearInterval(this._statsUpdateTimer);
                const sceneCtrl = this.sceneController;
                this._statsUpdateTimer = setInterval(() => {
                    if (!this._renderStatsVisible || !this.webglOptimizer) return;
                    this.webglOptimizer.updateStats(sceneCtrl.renderer);
                    const stats = this.webglOptimizer.getStatsString();
                    ui.renderStatsEl.textContent = stats;
                }, 500);
                
                ui.showToggleMessage('Render stats enabled');
            } else {
                // Hide the render stats and tear down its update timer
                ui.renderStatsEl.classList.add('hidden');
                this._renderStatsVisible = false;
                if (this._statsUpdateTimer) {
                    clearInterval(this._statsUpdateTimer);
                    this._statsUpdateTimer = null;
                }
                ui.showToggleMessage('Render stats hidden');
            }
        });

        // Reset-view handler
        ui.on('resetView', () => scene.resetView());

        // Toggles build-plate visibility via the button in the viewport's bottom-right corner
        ui.on('toggleBuildPlate', () => {
            this.buildPlateVisible = !this.buildPlateVisible;
            if (ui.btnPlateToggle) ui.btnPlateToggle.classList.toggle('active', this.buildPlateVisible);
            if (scene.setBuildPlateVisible) scene.setBuildPlateVisible(this.buildPlateVisible);
            ui.showToggleMessage(this.buildPlateVisible ? '▦ Build plate shown' : '▦ Build plate hidden');
        });

        // Toggles the axis lines' visibility - X/Y/Z colored lines drawn at the origin
        ui.on('toggleAxisVisible', () => {
            this.axisVisible = !this.axisVisible;
            if (ui.btnAxisToggle) ui.btnAxisToggle.classList.toggle('active', this.axisVisible);
            if (scene.setAxisVisible) scene.setAxisVisible(this.axisVisible);
            ui.showToggleMessage(this.axisVisible ? '↕ Axis lines shown' : '↕ Axis lines hidden');
        });

        // Infinite build-plate toggle - when on, the plate auto-scales to
        // extend well past whatever is currently loaded. It's enabled by default.
        ui.on('toggleInfiniteBuildPlate', () => {
            this.infinitePlateEnabled = !this.infinitePlateEnabled;
            if (ui.btnInfinitePlate) ui.btnInfinitePlate.classList.toggle('active', this.infinitePlateEnabled);
            this._updateBuildPlateExtent(true);
            ui.showToggleMessage(this.infinitePlateEnabled
                ? '▦ Infinite build plate enabled - auto-scales to fit all objects'
                : '▦ Infinite build plate disabled - fixed size');
        });

        // Simple-plate toggle - when on, resizes stretch the existing plate
        // furniture instead of rebuilding it (cheaper for frequent changes).
        ui.on('toggleSimplePlate', () => {
            this.simplePlateEnabled = !this.simplePlateEnabled;
            if (ui.btnSimplePlate) ui.btnSimplePlate.classList.toggle('active', this.simplePlateEnabled);
            scene.setSimplePlateMode(this.simplePlateEnabled);

            if (this.simplePlateEnabled) {
                // Simple plate only stretches in response to the infinite plate's
                // auto-resize, so enabling it forces the infinite plate on as well.
                if (!this.infinitePlateEnabled) {
                    this.infinitePlateEnabled = true;
                    if (ui.btnInfinitePlate) ui.btnInfinitePlate.classList.add('active');
                }
                // Re-baseline the furniture at the default size so stretching always
                // starts from the default build-plate geometry - otherwise a plate that
                // was already grown via rebuilds keeps its dense tiling when stretched
                // instead of scaling up cleanly.
                if (scene.rebuildBuildPlate) scene.rebuildBuildPlate(this._defaultPlateSize);
            }

            // Re-apply the current extent so the switch takes effect immediately.
            this._updateBuildPlateExtent(true);
            ui.showToggleMessage(this.simplePlateEnabled
                ? '▦ Simple plate enabled - stretches instead of rebuilding'
                : '▦ Simple plate disabled - rebuilds on resize');
        });

        // Viewport click - clicking a model toggles its selection; several
        // models can be selected this way, while clicking empty space leaves the
        // current selection untouched.
        ui.on('viewportClick', (clientX, clientY, shiftKey = false) => {
            if (this.splitMode.isActive()) return;

            const pickedId = scene.pickObject(clientX, clientY);

            if (!pickedId) {
                // A click that lands on no model is ignored.
                return;
            }

            // A plain click adds or removes this object from the current
            // multi-selection without disturbing anything else that's selected;
            // no Shift key needed - clicking an already-selected shape again
            // deselects it.
            scene.toggleObjectSelection(pickedId);
            this._updatePropertiesForSelected();

            const selected = scene.getSelectedObjectIds();
            if (selected.length > 0) {
                gizmo.setMode(this._transformMode === 'move' ? 'translate' : (this._transformMode || 'scale'));
                gizmo.setEnabled(true);
                // Attach to the just-clicked object when it's still selected;
                // otherwise fall back to the first of the remaining selected objects.
                const attachId = scene.selectedObjects.has(pickedId) ? pickedId : selected[0];
                const obj = scene.objects.get(attachId);
                if (obj) gizmo.attach(obj);
            } else {
                // The last selected model was just deselected - drop the gizmo entirely.
                gizmo.setEnabled(false);
                gizmo.detach();
                ui.updatePropertiesPanel({});
            }
        });

        // Right-click context menu - the logic lives here rather than in
        // UIManager, since it needs scene, this.contextMenu, and
        // this._handleContextAction, all of which belong to App.
        ui.on('viewportContextMenu', (clientX, clientY) => {
            if (this.splitMode.isActive()) return;

            const pickedId = scene.pickObject(clientX, clientY);
            const hasObjects = scene.objects.size > 0;
            const selectionCount = scene.getSelectionCount();

            const items = [];

            // Actions that apply to the clicked object itself
            if (pickedId) {
                items.push({ label: 'Select', icon: '<circle cx="12" cy="12" r="3"/><path d="M12 2v4m0 12v4m-7.07-15.93l2.83 2.83m8.48 8.48l2.83 2.83M2 12h4m12 0h4M4.93 4.93l2.83 2.83m8.48 8.48l2.83 2.83"/>' });
                items.push({ label: 'Delete', shortcut: 'Del', icon: '<polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>' });
                items.push('divider');

                // Rotation options (90° steps around each axis)
                items.push({ label: 'Rotate 90° X', icon: '<polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>' });
                items.push({ label: 'Rotate -90° X', icon: '<polyline points="1 10 1 4 7 4"/><path d="M3.51 15a9 9 0 1 0 2.12-9.36L1 10"/>' });
                items.push({ label: 'Rotate 90° Y', icon: '<polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>' });
                items.push({ label: 'Rotate 90° Z', icon: '<polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>' });
                items.push('divider');

                // Transform options - offered only when the object has a bounding box
                const box = scene.getBoundingBox(pickedId);
                if (box) {
                    items.push({ label: `Reset Rotation`, icon: '<circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/>' });
                    items.push({ label: `Snap to Center`, icon: '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="3"/>' });
                }
            }

            // Global actions - available as long as the scene contains objects
            if (hasObjects) {
                items.push('divider');
                if (selectionCount > 0) {
                    items.push({ label: `Delete Selected (${selectionCount})`, shortcut: 'Del', icon: '<polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>' });
                }
                items.push({ label: 'Select All', shortcut: 'Ctrl+A', icon: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 9l6 6m0-6l-6 6"/>' });
                items.push({ label: 'Delete All', icon: '<polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>' });
            }

            items.push('divider');
            items.push({ label: 'Properties', icon: '<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>' });

            if (items.length > 0) {
                this.contextMenu.show(clientX, clientY, items);
                this.contextMenu.onSelect = (item) => {
                    this._handleContextAction(item, pickedId, scene);
                };
            }
        });

        // Cancel / Escape - first exits split mode if it's active; otherwise
        // performs a full cancel: deselects everything, hides the gizmo, and
        // closes any open context menus or modals.
        ui.on('cancel', () => {
            if (this.splitMode.isActive()) {
                this.splitMode.cancel();
                return;
            }

            gizmo.setEnabled(false);
            gizmo.detach();
            scene.deselectAll();
            this.cuttingPlane.setVisible(false);
            this.contextMenu.hide();
            // Close every open modal by hiding its overlay element
            document.querySelectorAll('.modal-overlay').forEach(el => el.classList.add('hidden'));
        });

        // Transform-mode switch - updates the gizmo and refreshes the value bar
        ui.on('setTransformMode', (mode) => {
            this._transformMode = mode;
            gizmo.setMode(mode === 'move' ? 'translate' : mode);
            this.ui.setTransformMode(mode);
            this.axisDrag._refreshTransformPanel();
        });

        // Toggles grid snapping on/off and updates its button state
        ui.on('toggleGridSnap', () => {
            const active = this.gridSnapper.toggle();
            if (ui.btnGridSnap) {
                ui.btnGridSnap.classList.toggle('active', active);
            }
            // Show the grid-snap controls while the gizmo is active on a selected object
            if (gizmo.enabled && scene.selectedObject) {
                ui.gridSnapControls.style.display = 'flex';
            }
            ui.showToggleMessage(active ? '▤ Grid snap enabled' : '▤ Grid snap disabled');
        });

        // Sets the grid-snap cell size from the UI input
        ui.on('setGridSize', (size) => {
            this.gridSnapper.setSnapSize(size);
        });

        // Smart-snap toggle - magnetically snaps shapes while they're being
        // dragged directly: movement rounds to the nearest whole mm, rotation
        // to the nearest 45°. It's independent of the grid-snap feature above.
        ui.on('toggleSmartSnap', () => {
            this.smartSnapEnabled = !this.smartSnapEnabled;
            if (ui.btnSmartSnap) {
                ui.btnSmartSnap.classList.toggle('active', this.smartSnapEnabled);
            }
            ui.showToggleMessage(this.smartSnapEnabled ? 'Smart snap enabled' : 'Smart snap disabled');
        });

        // Day/Night mode toggle - flips the UI theme between a dark look
        // ("Night mode", the default) and a light one ("Day mode").
        ui.on('toggleDayMode', () => {
            this.nightModeEnabled = !this.nightModeEnabled;
            document.body.classList.toggle('light-mode', !this.nightModeEnabled);
            if (ui.btnDayMode) {
                // The button's icon is a moon, so its lit (active) state
                // tracks whether Night mode (the dark UI) is on.
                ui.btnDayMode.classList.toggle('active', this.nightModeEnabled);
            }
            ui.showToggleMessage(this.nightModeEnabled ? 'Night mode enabled' : 'Day mode enabled');
        });

        // Aesthetic mode toggle - off by default. It hides every menu, toolbar,
        // and panel except the bottom status bar (which turns solid black), and
        // switches on more dramatic viewport lighting. All of that is done in CSS
        // (see the .aesthetic-mode rules in app.css) except for the dramatic
        // lighting itself.
        ui.on('toggleAestheticMode', () => {
            this.aestheticModeEnabled = !this.aestheticModeEnabled;
            document.body.classList.toggle('aesthetic-mode', this.aestheticModeEnabled);
            if (ui.btnAestheticMode) {
                ui.btnAestheticMode.classList.toggle('active', this.aestheticModeEnabled);
            }
            if (scene.setDramaticLighting) {
                scene.setDramaticLighting(this.aestheticModeEnabled);
            }
            // Showing or hiding the toolbar and properties panel changes how much
            // space #viewport-container occupies, but only through a CSS layout
            // reflow - no window 'resize' event fires on its own. The renderer/
            // camera sizing logic in SceneController listens for that event to
            // know it should recompute, so we dispatch one manually after the new
            // layout has actually been painted (double rAF).
            requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                    window.dispatchEvent(new Event('resize'));
                });
            });
            ui.showToggleMessage(this.aestheticModeEnabled
                ? 'Aesthetic mode enabled'
                : 'Aesthetic mode disabled');
        });

        // Toggles whether setting-change toast messages are shown or muted
        ui.on('toggleMuteMessages', () => ui.toggleMuteMessages());



        // Rotate-pivot mode - chooses whether an interactive rotate drag spins
        // the shape around the world origin (0,0,0) or around its own center.
        ui.on('setRotatePivotMode', (mode) => {
            this._rotatePivotMode = mode === 'center' ? 'center' : 'origin';
            if (gizmo.setPivotMode) gizmo.setPivotMode(this._rotatePivotMode);
            ui.showToggleMessage(this._rotatePivotMode === 'center'
                ? '⟳ Rotate pivot: object center'
                : '⟳ Rotate pivot: world origin');
        });

        // Lock-ratio toggle - when on, scaling one axis resizes the other axes
        // by the same factor so the shape keeps its aspect ratio; applies to
        // both the Width/Height/Depth value bar and the scale gizmo handles.
        ui.on('setLockRatio', (locked) => {
            this._lockRatioEnabled = !!locked;
            if (gizmo.setRatioLock) gizmo.setRatioLock(this._lockRatioEnabled);
            ui.showToggleMessage(this._lockRatioEnabled
                ? 'Lock ratio enabled - scaling one axis resizes all axes proportionally'
                : 'Lock ratio disabled - each axis scales independently');
        });

        // Toggles the measurement unit used across the UI
        ui.on('toggleUnit', () => ui.toggleUnit());

        // Snap-to-center handler - centers the selection on the XZ plane and drops it onto the build plate
        ui.on('snapCenter', () => this._snapSelectedToCenter());

        // Delete handler - removes all currently selected objects from the scene
        ui.on('delete', () => {
            const selectedIds = scene.getSelectedObjectIds();
            
            if (selectedIds.length === 0 && !scene.selectedObject) return;
            
            const idsToDelete = selectedIds.length > 0 ? selectedIds : [scene.selectedObject];
            
            for (const id of idsToDelete) {
                scene.removeObject(id);
                this.backendIds.delete(id);
            }
            
            if (selectedIds.length === 0) {
                scene.selectObject(null);
            } else {
                scene.deselectAll();
            }
            
            gizmo.setEnabled(false);
            gizmo.detach();
            ui.updatePropertiesPanel({});
            if (scene.objects.size === 0) {
                scene.resetView();
                ui.showDropZone(true);
            }
            this._updateBuildPlateExtent();
        });

        // Select-all handler - puts every tracked object into the multi-selection and attaches the gizmo to the first one
        ui.on('selectAll', () => {
            const allIds = Array.from(this.backendIds.keys());
            if (allIds.length > 0) {
                scene.deselectAll();
                for (const id of allIds) {
                    scene.addToSelection(id);
                }
                this._updatePropertiesForSelected();
                gizmo.setMode(this._transformMode === 'move' ? 'translate' : (this._transformMode || 'scale'));
                gizmo.setEnabled(true);
                const firstObj = scene.objects.get(allIds[0]);
                if (firstObj) gizmo.attach(firstObj);
            }
        });

        // On each transform update, refreshes the properties panel and keeps the move/rotate/scale value bar live while dragging
        window.addEventListener('transform-update', () => {
            if (scene.selectedObject || scene.getSelectedObjectIds().length > 0) {
                this._updatePropertiesForSelected();
            }
            this.axisDrag._refreshTransformPanel();
        });

        // Refreshes the status bar every 500 ms so it tracks scene changes
        setInterval(() => {
            this._updateStatusBar();
        }, 500);

        // Every time the empty-state import popup appears, reframes the camera
        // back to the default view (the event is fired by UIManager.showDropZone).
        window.addEventListener('dropzone-shown', () => {
            scene.resetView();
        });

        // On gizmo transform end (mouse up), snaps the dragged object's position to the grid when grid snap is on
        window.addEventListener('transform-end', () => {
            if (this.gridSnapper.enabled && gizmo.enabled && scene.selectedObject) {
                const obj = scene.objects.get(scene.selectedObject);
                if (obj) {
                    this.gridSnapper.snapPosition(obj);
                    window.dispatchEvent(new Event('transform-update'));
                }
            }

            // Commit whatever move/rotate/scale just happened to the backend.
            // Both gizmo drags and direct-manipulation drags only update the
            // Three.js object locally; without this commit, the backend's copy
            // of the mesh silently drifts out of sync with what's on screen,
            // and later union/subtract/intersect calls would run against stale,
            // pre-drag geometry.
            const idsToCommit = scene.getSelectedObjectIds().length > 0
                ? scene.getSelectedObjectIds()
                : (scene.selectedObject ? [scene.selectedObject] : []);
            if (idsToCommit.length > 0) {
                this._commitTransforms(idsToCommit);
            }
        });

        // Wraps gizmo.setEnabled so the grid-snap controls show or hide with the gizmo's state
        const origSetEnabled = gizmo.setEnabled.bind(gizmo);
        gizmo.setEnabled = (enabled) => {
            origSetEnabled(enabled);
            if (!enabled) {
                ui.gridSnapControls.style.display = 'none';
            } else if (scene.selectedObject && this.gridSnapper.enabled) {
                ui.gridSnapControls.style.display = 'flex';
            }
        };

        // Wraps gizmo.attach so selecting an object reveals the grid-snap controls
        const origAttach = gizmo.attach.bind(gizmo);
        gizmo.attach = (object) => {
            origAttach(object);
            if (this.gridSnapper.enabled) {
                ui.gridSnapControls.style.display = 'flex';
            }
        };

        // Wraps gizmo.detach so detaching always hides the grid-snap controls
        const origDetach = gizmo.detach.bind(gizmo);
        gizmo.detach = () => {
            origDetach();
            ui.gridSnapControls.style.display = 'none';
        };

        // Wraps gizmo.setMode so the Move/Rotate/Scale buttons and value bar stay
        // in sync no matter where a mode change originates - selection, the
        // toolbar's interactive rotate, keyboard shortcuts, and so on.
        const origSetMode = gizmo.setMode.bind(gizmo);
        gizmo.setMode = (mode) => {
            origSetMode(mode);
            this._transformMode = mode === 'translate' ? 'move' : mode;
            ui.setTransformMode(this._transformMode);
            this.axisDrag._refreshTransformPanel();
        };

        // Wraps ui.updatePropertiesPanel so the Move/Rotate/Scale value bar is
        // re-synced on every properties refresh - covering all selection and
        // deselection call sites (viewport clicks, delete, cancel, select all,
        // context menu, ...) without having to touch each one individually.
        const origUpdatePropertiesPanel = ui.updatePropertiesPanel.bind(ui);
        ui.updatePropertiesPanel = (data) => {
            origUpdatePropertiesPanel(data);
            this.axisDrag._refreshTransformPanel();
            this.objectListPanel.syncSelection();
        };
    }

    /**
     * Infinite build plate - resizes the plate/grid so it extends well past whatever
     * objects are currently loaded; when disabled, it reverts to the default plate
     * size. It's cheap to call often and skips the actual resize (which rebuilds the
     * grid geometry) unless the target size changed meaningfully or `force` is passed.
     */
    _updateBuildPlateExtent(force = false) {
        const scene = this.sceneController;
        if (!scene || typeof scene.setBuildPlateSize !== 'function') return;

        let target;
        if (this.infinitePlateEnabled) {
            const box = scene.getBoundingBox ? scene.getBoundingBox() : null;
            if (box) {
                // Size of the combined footprint - translating an object does not change this.
                const footprint = Math.max(box.width, box.depth);
                // How far the content reaches from the origin in each horizontal direction;
                // moving a shape to a new location must grow the plate so it keeps covering it.
                const reachX = Math.max(Math.abs(box.minX), Math.abs(box.maxX));
                const reachZ = Math.max(Math.abs(box.minZ), Math.abs(box.maxZ));
                const reach = Math.max(reachX, reachZ);
                // Extends well past the loaded objects - 3x the largest footprint dimension,
                // large enough to span whatever distance the content now sits from the center,
                // but never smaller than the default plate size.
                target = Math.max(this._defaultPlateSize, footprint * 3, reach * 2 + this._defaultPlateSize);
            } else {
                target = this._defaultPlateSize;
            }
        } else {
            target = this._defaultPlateSize;
        }

        if (!force && Math.abs(target - this._lastPlateSize) < 0.5) return;

        this._lastPlateSize = target;
        scene.setBuildPlateSize(target);
        // setBuildPlateSize rebuilds the grid/plate meshes from scratch, so
        // re-apply the current visibility state.
        if (scene.setBuildPlateVisible) scene.setBuildPlateVisible(this.buildPlateVisible);
    }

    /**
     * Serialize all transform commits through a single promise chain so two
     * overlapping calls never both POST for the same backend object id. The
     * `transform-end` handler fires this without awaiting, and Union/Subtract/
     * Intersect/Split each await their own commit - if both run at once they
     * capture the same objectId, and since a successful transform replaces the
     * server-side object with a brand-new id (geometry.py deletes + re-saves),
     * the second request hits "Object ... not found" (400). Chaining also makes
     * later calls re-read the latest objectId after earlier commits swapped it.
     */
    _commitTransforms(frontendIds) {
        const prev = this._transformCommitChain || Promise.resolve();
        const p = prev.then(() => this._doCommitTransforms(frontendIds));
        // Keep the chain alive even if a commit rejects, so later commits don't hang.
        this._transformCommitChain = p.catch(() => {});
        return p;
    }

    /**
     * Commit the current client-side transform (position/rotation/scale) of
     * one or more objects to the backend, baking it into their stored
     * vertex data.
     *
     * This exists because the interactive gizmo and direct-manipulation
     * dragging (and the Move/Rotate/Scale value bar) only ever mutate the
     * Three.js object locally - the backend never otherwise learns that an
     * object moved. Left uncommitted, that means union/subtract/intersect
     * (and export) run against wherever the object was when it was
     * created/imported, not wherever it visually ended up, which can make
     * shapes that clearly overlap on screen fail with confusing errors
     * like "operation produced an empty mesh".
     *
     * Objects with an identity local matrix (nothing actually moved) are
     * skipped so this doesn't add a network round-trip on every selection
     * change or no-op drag.
     */
    async _doCommitTransforms(frontendIds) {
        const scene = this.sceneController;
        const IDENTITY = new THREE.Matrix4();

        const jobs = [];
        for (const id of frontendIds) {
            const obj = scene.objects.get(id);
            const backendInfo = this.backendIds.get(id);
            if (!obj || !backendInfo || !hasId(backendInfo.objectId)) continue;

            obj.updateMatrix();
            if (obj.matrix.equals(IDENTITY)) continue;

            // Preserve the object's current color across the reload below -
            // the backend's transform response doesn't carry vertex colors
            // for a solid-color object, so without this the object would be
            // assigned a brand-new color every time it's moved/rotated/scaled.
            const color = (obj.material && obj.material.color && !obj.material.vertexColors)
                ? obj.material.color.clone()
                : null;

            jobs.push({ id, backendInfo, matrix: Array.from(obj.matrix.elements), color });
        }

        if (jobs.length === 0) return;

        const wasSelected = new Set(scene.getSelectedObjectIds());
        if (scene.selectedObject) wasSelected.add(scene.selectedObject);
        const gizmoMode = this.transformGizmo.enabled ? this.transformGizmo.mode : null;

        let anySucceeded = false;
        let anyFailed = false;

        for (const job of jobs) {
            try {
                const result = await this.api.transformModel(
                    job.backendInfo.sessionId || this.sessionId,
                    job.backendInfo.objectId,
                    job.matrix
                );
                if (result && hasId(result.id)) {
                    anySucceeded = true;
                    const stillSelected = wasSelected.has(job.id);

                    scene.removeObject(job.id);
                    this.backendIds.delete(job.id);

                    const newFrontendId = this.meshSync.loadFromServer(result, { color: job.color });
                    this.backendIds.set(newFrontendId, {
                        sessionId: job.backendInfo.sessionId || this.sessionId,
                        objectId: result.id,
                    });

                    if (stillSelected) {
                        scene.addToSelection(newFrontendId);
                    }
                }
            } catch (err) {
                if (/not found/i.test(err.message || '')) {
                    // The backend no longer has this object id at all (e.g. an
                    // undo/redo or boolean op landed while this request was in
                    // flight). Drop the stale mapping so later operations show
                    // "no backend data" instead of 400-ing again; keep the mesh
                    // on screen so the user doesn't lose their work.
                    this.backendIds.delete(job.id);
                }
                // Leave this object exactly as the user positioned it
                // client-side rather than snapping it back - it stays out
                // of sync with the backend until the next successful
                // commit, but at least the user doesn't lose their work.
                console.error(`Failed to sync transform for ${job.id}:`, err);
                anyFailed = true;
            }
        }

        if (anyFailed) {
            this._showAlert('Some object transforms could not be saved to the server. ' +
                  'They may look right here, but operations like Union/Subtract/' +
                  'Intersect could behave unexpectedly until this is retried ' +
                  '(e.g. by dragging the object again).');
        }

        if (anySucceeded) {
            // Every transformed object above was just removed and rebuilt
            // as a brand-new mesh (_loadMeshFromServer), which always
            // starts out with plain "normal" material settings - that's
            // why dragging/rotating an object while in wireframe,
            // transparent, or wireframe-hybrid mode made it visually pop
            // back to the default look. Reapply the active view mode to
            // pick the new mesh(es) back up.
            if (scene.viewMode !== 'normal') {
                scene.setViewMode(scene.viewMode);
            }

            // Re-attach the gizmo to whatever the selection ended up being,
            // since every replaced mesh is a brand-new Three.js object.
            const selected = scene.getSelectedObjectIds();
            if (selected.length > 0) {
                scene.selectedObject = selected[selected.length - 1];
                if (gizmoMode) {
                    this.transformGizmo.setMode(gizmoMode);
                    this.transformGizmo.setEnabled(true);
                    const obj = scene.objects.get(scene.selectedObject);
                    if (obj) this.transformGizmo.attach(obj);
                }
            }
            this._updatePropertiesForSelected();
            this.axisDrag._refreshTransformPanel();
            this._updateStatusBar();
        }
    }

    /**
     * Next object color: hues advance by the golden angle (~137.5°) so
     * consecutively created, pasted, or imported shapes stay visually
     * distinct from one another. A band around the selection-highlight hue
     * is skipped so a freshly added shape is never mistaken for an already
     * selected one.
     */
    _nextObjectColor() {
        const selHsl = {};
        new THREE.Color(SELECTION_COLOR).getHSL(selHsl);
        const selHueDeg = selHsl.h * 360;

        this._colorIndex = (this._colorIndex || 0) + 1;
        const goldenAngle = 137.508;
        let hue = (this._colorIndex * goldenAngle) % 360;

        // Keep clear of the selection-highlight hue band.
        const hueDelta = Math.min(Math.abs(hue - selHueDeg), 360 - Math.abs(hue - selHueDeg));
        if (hueDelta < 20) {
            hue = (hue + 40) % 360;
        }

        const color = new THREE.Color();
        color.setHSL(hue / 360, 0.55, 0.55);
        return color;
    }

    /**
     * Sync the bottom-bar view-mode buttons' .active class with
     * sceneController.viewMode - the three modes are mutually exclusive.
     */
    _updateViewModeButtonStates() {
        const mode = this.sceneController.viewMode;
        const buttonsByMode = {
            wireframe: this.ui.elements['btn-wireframe-toggle'],
            transparent: this.ui.elements['btn-transparent-toggle'],
            'wireframe-hybrid': this.ui.elements['btn-wireframe-hybrid-toggle'],
        };
        Object.entries(buttonsByMode).forEach(([key, btn]) => {
            if (btn) btn.classList.toggle('active', mode === key);
        });
    }

    _snapToBuildPlate(mesh) {
        const box = new THREE.Box3().setFromObject(mesh);
        // Center the object horizontally (XZ) on the build plate's origin so it
        // spawns in the middle of the plate instead of wherever its own bounding
        // box happened to sit (primitives in particular come back with an offset
        // footprint - e.g. a cube anchored at a corner, a cylinder/cone with its
        // base on the z=0 plane). Shifting by the negative bbox center lands the
        // object's horizontal midpoint exactly on the plate origin.
        mesh.position.x -= (box.min.x + box.max.x) / 2;
        mesh.position.z -= (box.min.z + box.max.z) / 2;
        // Drop it until its lowest point rests on the build plate (y = 0).
        mesh.position.y -= box.min.y;
    }

    _snapSelectedToCenter() {
        if (!this.sceneController.selectedObject) return;
        const obj = this.sceneController.objects.get(this.sceneController.selectedObject);
        if (!obj) return;

        // Center the object on the XZ plane.
        const box = new THREE.Box3().setFromObject(obj);
        const centerX = (box.min.x + box.max.x) / 2;
        const centerZ = (box.min.z + box.max.z) / 2;
        obj.position.x -= centerX;
        obj.position.z -= centerZ;

        // Seat its base on the build plate.
        this._snapToBuildPlate(obj);

        window.dispatchEvent(new Event('transform-update'));
        window.dispatchEvent(new Event('transform-end'));
    }

    _updatePropertiesForSelected() {
        const scene = this.sceneController;
        const selectedIds = scene.getSelectedObjectIds();

        if (selectedIds.length === 0) {
            this.ui.updatePropertiesPanel({});
            return;
        }

        if (selectedIds.length === 1) {
            // One object selected - the panel shows its own properties.
            const id = selectedIds[0];
            const box = scene.getBoundingBox(id);
            const stats = scene.getMeshStats(id);

            if (box) {
                this.ui.updateDimensions(box.width, box.height, box.depth);
            }
            this.ui.updateMeshStats(stats.faces, stats.vertices);

            const obj = scene.objects.get(id);
            // Missing/undefined userData.isSolid is treated as solid - the
            // same default _warnIfNotSolid uses, since primitives, CSG
            // results, and pasted copies are never explicitly tested.
            const isSolid = !(obj && obj.userData && obj.userData.isSolid === false);

            const props = {
                'Object ID': id,
                'Width': `${box.width.toFixed(2)} mm`,
                'Height': `${box.height.toFixed(2)} mm`,
                'Depth': `${box.depth.toFixed(2)} mm`,
                'Faces': stats.faces.toLocaleString(),
                'Vertices': stats.vertices.toLocaleString(),
                'Solid': isSolid ? 'Yes' : 'No',
            };
            this.ui.updatePropertiesPanel(props);
        } else {
            // Multiple objects selected - the panel shows combined stats.
            const box = scene.getBoundingBox(null);
            const totalFaces = selectedIds.reduce((sum, id) => sum + scene.getMeshStats(id).faces, 0);
            const totalVertices = selectedIds.reduce((sum, id) => sum + scene.getMeshStats(id).vertices, 0);

            if (box) {
                this.ui.updateDimensions(box.width, box.height, box.depth);
            }
            this.ui.updateMeshStats(totalFaces, totalVertices);

            const props = {
                'Objects': `${selectedIds.length} selected`,
                'Total Faces': totalFaces.toLocaleString(),
                'Total Vertices': totalVertices.toLocaleString(),
            };
            this.ui.updatePropertiesPanel(props);
        }
    }

    _updateStatusBar() {
        const scene = this.sceneController;
        if (scene.objects.size === 0) return;

        // Report dimensions and mesh stats - for the current selection, or for all objects when nothing is selected.
        const selectedIds = scene.getSelectedObjectIds();
        let id = null;

        if (selectedIds.length > 0) {
            // Multiple selected - combine their stats.
            id = null;
        } else if (scene.selectedObject) {
            // Exactly one selected - report its own stats.
            id = scene.selectedObject;
        } else {
            // Nothing selected - fall back to the whole scene's combined stats.
            id = null;
        }

        const box = scene.getBoundingBox(id);
        const stats = scene.getMeshStats(id);

        if (box) {
            this.ui.updateDimensions(box.width, box.height, box.depth);
        }
        this.ui.updateMeshStats(stats.faces, stats.vertices);
    }

    _handleContextAction(item, pickedId, scene) {
        const gizmo = this.transformGizmo;

        if (item.label === 'Delete' && pickedId) {
            scene.removeObject(pickedId);
            this.backendIds.delete(pickedId);
            if (scene.selectedObjects.has(pickedId)) {
                scene.selectedObjects.delete(pickedId);
            }
            if (scene.selectedObject === pickedId) {
                const remaining = scene.getSelectedObjectIds();
                if (remaining.length > 0) {
                    scene.selectObject(remaining[0]);
                    const obj = scene.objects.get(remaining[0]);
                    if (obj) gizmo.attach(obj);
                } else {
                    scene.deselectAll();
                    gizmo.setEnabled(false);
                    gizmo.detach();
                    this.ui.updatePropertiesPanel({});
                }
            }
            return;
        }

        // "Delete" on empty space removes every currently selected object.
        if (item.label === 'Delete' && !pickedId && scene.getSelectionCount() > 0) {
            const selectedIds = scene.getSelectedObjectIds();
            for (const id of selectedIds) {
                scene.removeObject(id);
                this.backendIds.delete(id);
            }
            scene.deselectAll();
            gizmo.setEnabled(false);
            gizmo.detach();
            this.ui.updatePropertiesPanel({});
            return;
        }

        // Explicit "Delete Selected" entry - same removal path.
        if (item.label.startsWith('Delete Selected')) {
            const selectedIds = scene.getSelectedObjectIds();
            for (const id of selectedIds) {
                scene.removeObject(id);
                this.backendIds.delete(id);
            }
            scene.deselectAll();
            gizmo.setEnabled(false);
            gizmo.detach();
            this.ui.updatePropertiesPanel({});
            return;
        }

        if (item.label === 'Delete All') {
            for (const [frontendId] of this.backendIds.entries()) {
                scene.removeObject(frontendId);
            }
            this.backendIds.clear();
            scene.selectObject(null);
            gizmo.setEnabled(false);
            gizmo.detach();
            this.ui.updatePropertiesPanel({});
            return;
        }

        if (item.label === 'Select All') {
            const allIds = Array.from(this.backendIds.keys());
            if (allIds.length > 0) {
                scene.deselectAll();
                for (const id of allIds) {
                    scene.addToSelection(id);
                }
                this._updatePropertiesForSelected();
                const firstObj = scene.objects.get(allIds[0]);
                if (firstObj) {
                    gizmo.setMode('translate');
                    gizmo.setEnabled(true);
                    gizmo.attach(firstObj);
                }
            }
            return;
        }

        if (item.label === 'Select' && pickedId) {
            // With a multi-selection active, clicking toggles membership rather than replacing the selection.
            if (scene.getSelectionCount() > 0) {
                scene.toggleObjectSelection(pickedId);
            } else {
                scene.selectObject(pickedId);
            }
            this._updatePropertiesForSelected();
            gizmo.setMode('translate');
            const selected = scene.getSelectedObjectIds();
            if (selected.length > 0) {
                gizmo.setEnabled(true);
                const obj = scene.objects.get(selected[0]);
                if (obj) gizmo.attach(obj);
            } else {
                gizmo.setEnabled(false);
                gizmo.detach();
            }
            return;
        }

        if (item.label === 'Properties') {
            if (!pickedId && scene.selectedObject) {
                pickedId = scene.selectedObject;
            }
            if (pickedId) {
                this._updatePropertiesForSelected();
            }
            return;
        }

        // Rotation menu entries.
        const rotateMatch = item.label.match(/Rotate\s*([+-]?\d+)(?:\s*(.+))?/);
        if (rotateMatch && pickedId) {
            const angle = parseInt(rotateMatch[1]);
            const axisStr = rotateMatch[2] || 'z';
            this._serverRotate(pickedId, angle, axisStr);
            return;
        }

        if (item.label === 'Reset Rotation' && pickedId) {
            this._serverRotate(pickedId, 0, 'z');
            return;
        }

        if (item.label === 'Snap to Center' && pickedId) {
            const obj = scene.objects.get(pickedId);
            if (obj) {
                this._snapToBuildPlate(obj);
                // Then center it on the XZ plane.
                const box2 = new THREE.Box3().setFromObject(obj);
                const centerX = (box2.min.x + box2.max.x) / 2;
                const centerZ = (box2.min.z + box2.max.z) / 2;
                obj.position.x -= centerX;
                obj.position.z -= centerZ;
                window.dispatchEvent(new Event('transform-end'));
            }
            return;
        }
    }

    async _serverRotate(pickedId, angle, axis) {
        const backendInfo = this.backendIds.get(pickedId);
        if (!backendInfo || !hasId(backendInfo.objectId)) return;

        this.ui.showLoading('Rotating...');
        try {
            const result = await this.api.rotateModel(
                backendInfo.sessionId || this.sessionId,
                backendInfo.objectId, angle, axis.toLowerCase()
            );
            if (result && hasId(result.id)) {
                this.meshSync.replaceObject(pickedId, result);
            }
        } catch (err) {
            console.error('Rotate failed:', err);
        } finally {
            this.ui.hideLoading();
        }
    }

    async _undo() {
        if (!this.sessionId) return;

        try {
            const result = await this.api.undo(this.sessionId);
            if (result && result.objects) {
                const scene = this.sceneController;
                for (const [frontendId] of this.backendIds.entries()) {
                    scene.removeObject(frontendId);
                }
                this.backendIds.clear();

                for (const objData of result.objects) {
                    const frontendId = this.meshSync.loadFromServer(objData);
                    if (hasId(frontendId) && hasId(objData.id)) {
                        this.backendIds.set(frontendId, { sessionId: this.sessionId, objectId: objData.id });
                    }
                }
                scene.resetView();
            }
        } catch (err) {
            console.error('Undo failed:', err);
        }
    }

    async _redo() {
        if (!this.sessionId) return;

        try {
            const result = await this.api.redo(this.sessionId);
            if (result && result.objects) {
                const scene = this.sceneController;
                for (const [frontendId] of this.backendIds.entries()) {
                    scene.removeObject(frontendId);
                }
                this.backendIds.clear();

                for (const objData of result.objects) {
                    const frontendId = this.meshSync.loadFromServer(objData);
                    if (hasId(frontendId) && hasId(objData.id)) {
                        this.backendIds.set(frontendId, { sessionId: this.sessionId, objectId: objData.id });
                    }
                }
                scene.resetView();
            }
        } catch (err) {
            console.error('Redo failed:', err);
        }
    }
}

// --- Boot the app once the DOM is ready ---
document.addEventListener('DOMContentLoaded', async () => {
    // Fetch .config feature defaults from the backend; fall back to the built-in ones when unavailable
    let defaults = {};
    try {
        const resp = await fetch('/api/settings');
        if (resp.ok) defaults = await resp.json();
    } catch (err) {
        console.warn('Could not load default settings:', err);
    }
    new App(defaults);
});
