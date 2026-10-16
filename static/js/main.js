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
import { ArrowKeys } from './viewport/ArrowKeys.js';
import { ViewCube } from './viewport/ViewCube.js';
import { MeshSync } from './viewport/MeshSync.js';
import { ContextMenu } from './ui/ContextMenu.js';
import { ObjectListPanel } from './ui/ObjectListPanel.js';
import { RightPanel } from './ui/RightPanel.js';
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
        const importDefaults = defaults.import || {};

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

        // Tip mode - a persistent box (top-right) describing whichever button is
        // hovered over; seeded from .config (ui.tip_mode), off by default, and
        // toggled from the status-bar switch.
        this.tipModeEnabled = uiDefaults.tip_mode ?? false;

        // View cube - orientation indicator docked at the top-left of the viewport;
        // seeded from .config (ui.view_cube_visible), on by default, and toggled
        // from the status-bar switch. Always hidden while aesthetic mode is active.
        this.viewCubeEnabled = uiDefaults.view_cube_visible ?? true;

        // Import separation - freshly imported shapes are shifted along X/Z until
        // their bounding box sits at least importMinGapMm clear of every existing
        // shape's bounding box. Driven by .config ([import] separation_enabled /
        // min_gap_mm).
        this.importSeparationEnabled = importDefaults.separation_enabled ?? true;
        this.importMinGapMm = importDefaults.min_gap_mm ?? 5.0;

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
        this.arrowKeys = new ArrowKeys(this);
        this.objectListPanel = new ObjectListPanel(this);
        this.rightPanel = new RightPanel(this);
        this.meshSync = new MeshSync(this);

        this._initViewport();
        this._applyInitialSettings();
        this._bindUIEvents();
        this.axisDrag.init();
        this.arrowKeys.init();

        // Orientation indicator in the top-left corner of the viewport; its
        // seeded visibility (and button state) come from .config. Aesthetic mode,
        // if seeded on above, hides it via CSS regardless of this switch.
        this.viewCube = new ViewCube(this);
        this._setViewCubeEnabled(this.viewCubeEnabled);
        this.splitMode.init();
        this.rightPanel.init();
        this._initConnectionStatus();
        this._initAdBanner();
    }

    /**
     * Drives the About section (the ColliBoy ad iframe) at the bottom of the
     * right-hand menu: probes the host with a no-cors fetch so it works without
     * CORS headers, and hides the whole section while the host is unreachable.
     */
    _initAdBanner() {
        if (!document.querySelector('[data-panel-section="about"]')) return;

        const BANNER_URL = 'https://ads.colliboy.com';
        const CHECK_INTERVAL_MS = 20000;
        let lastReachable = null; // unknown until the first probe lands

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

            if (reachable === lastReachable) return; // state unchanged - nothing to do
            lastReachable = reachable;
            this.rightPanel.setAboutAvailable(reachable);
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
     * Drives the connection indicator - the leftmost dot in the status bar;
     * checks health every 20s while the tab is visible and on refocus.
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
     * Themed stand-in for alert(): a modal matching the app's dialog styling;
     * dismiss via OK, close button, outside click, or Escape/Enter. Fire-and-
     * forget - callers need not await it.
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
     * Save flow shared by Ctrl-S and the menu "Save" item: opens the Save dialog,
     * then saves the entire scene in one file (never just the selection), shipping
     * every object at its on-screen position to /api/export/scene.
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

            const format = (config.format || 'stl').toLowerCase();

            // Merge-based formats bake every model into one body, so the scene must
            // be all-solid first - open/hollow shapes would print as broken shells.
            if (format !== '3mf' && this._warnIfNotSolid(
                [...this.sceneController.objects.keys()], 'save', 'the shapes in the scene'
            )) {
                return;
            }

            blob = await this.api.exportScene(format, this._buildWorldSpaceMeshes(format));
            downloadName = `project.${format}`;

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
     * Snapshot every visible object as a mesh descriptor for saving: 3MF ships local-space
     * geometry plus a per-mesh world transform (models stay separate); other formats bake
     * position/rotation/scale into the vertices. Uses each top-level mesh's own geometry -
     * LOD children are display approximations and must not replace the real model.
     */
    _buildWorldSpaceMeshes(format) {
        const keepSeparate = String(format || '').toLowerCase() === '3mf';
        const meshes = [];

        for (const [id, obj] of this.sceneController.objects) {
            // Every registered object is a Mesh; fall back to its first mesh child
            // if one ever gets wrapped in a group.
            let source = null;
            if (obj.isMesh && obj.geometry) {
                source = obj;
            } else {
                obj.traverse((child) => {
                    if (!source && child.isMesh && child.geometry) source = child;
                });
            }
            if (!source || !source.geometry.getAttribute('position')) continue;

            source.updateMatrixWorld(true);
            const matrix = source.matrixWorld;
            const normalMatrix = new THREE.Matrix3().getNormalMatrix(matrix);
            const posAttr = source.geometry.getAttribute('position');
            const index = source.geometry.getIndex();
            const normalAttr = source.geometry.getAttribute('normal');
            const colorAttr = source.geometry.getAttribute('color');

            const vertices = [];
            if (keepSeparate) {
                // local-space coordinates; the item transform carries the placement
                for (let i = 0; i < posAttr.count; i++) {
                    vertices.push(posAttr.getX(i), posAttr.getY(i), posAttr.getZ(i));
                }
            } else {
                const v = new THREE.Vector3();
                for (let i = 0; i < posAttr.count; i++) {
                    v.set(posAttr.getX(i), posAttr.getY(i), posAttr.getZ(i)).applyMatrix4(matrix);
                    vertices.push(v.x, v.y, v.z);
                }
            }

            const mesh = { name: obj.name || id, vertices };
            if (keepSeparate) mesh.transform = matrix.elements.slice();

            if (index) mesh.indices = Array.from(index.array);

            if (normalAttr && normalAttr.count === posAttr.count) {
                const normals = [];
                for (let i = 0; i < normalAttr.count; i++) {
                    if (keepSeparate) {
                        // local-space normals; the item transform applies to them too
                        normals.push(normalAttr.getX(i), normalAttr.getY(i), normalAttr.getZ(i));
                    } else {
                        const n = new THREE.Vector3();
                        n.set(normalAttr.getX(i), normalAttr.getY(i), normalAttr.getZ(i))
                            .applyMatrix3(normalMatrix).normalize();
                        normals.push(n.x, n.y, n.z);
                    }
                }
                mesh.normals = normals;
            }

            if (colorAttr && colorAttr.count === posAttr.count) {
                const colors = [];
                for (let i = 0; i < colorAttr.count; i++) {
                    colors.push(colorAttr.getX(i), colorAttr.getY(i), colorAttr.getZ(i));
                }
                mesh.colors = colors;
            }

            meshes.push(mesh);
        }

        return meshes;
    }

    /**
     * Guard for boolean ops and whole-scene saves: warns (returns true) if any given
     * object is marked not solid - open surface/holes, as shown by "Solid: No". Missing
     * userData.isSolid counts as solid. `scope` phrases which shapes are being checked.
     */
    _warnIfNotSolid(ids, opLabel, scope = 'the selected shapes') {
        const scene = this.sceneController;
        const notSolidIds = ids.filter((id) => {
            const obj = scene.objects.get(id);
            return !!(obj && obj.userData && obj.userData.isSolid === false);
        });
        if (notSolidIds.length === 0) return false;

        const plural = notSolidIds.length > 1;
        this._showAlert(
            `${plural ? `${notSolidIds.length} of ${scope} are` : `One of ${scope} is`} ` +
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

        this.transformGizmo = new TransformGizmo(this.sceneController.camera, canvas, this.sceneController.scene);
        if (this.transformGizmo.setPivotMode) this.transformGizmo.setPivotMode(this._rotatePivotMode);
        if (this.transformGizmo.setRatioLock) this.transformGizmo.setRatioLock(this._lockRatioEnabled);

        // While a gizmo handle is being dragged, OrbitControls must not also
        // rotate the camera from the same pointer gesture - disable it for the
        // duration of every gizmo drag.
        this.transformGizmo.control.addEventListener('dragging-changed', (event) => {
            this.sceneController.controls.enabled = !event.value;
        });
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

        // Tip mode - apply its seeded state (shows/hides the box and starts/stops hover tracking).
        this._setTipMode(this.tipModeEnabled);
    }

    /**
     * Sets tip mode on/off. When on, a persistent box at the top-right of the
     * viewport shows the description of whichever button is hovered; when off it
     * hides and detaches its hover tracking. Seeded from .config (ui.tip_mode),
     * toggled from the status-bar switch.
     */
    _setTipMode(enabled) {
        this.tipModeEnabled = !!enabled;
        const btn = this.ui.btnTipMode;
        if (btn) btn.classList.toggle('active', this.tipModeEnabled);

        if (this.tipModeEnabled) {
            this._enableTipTracking();
        } else {
            this._disableTipTracking();
        }
    }

    /**
     * Sets the orientation indicator on/off. Seeded from .config (ui.view_cube_visible),
     * toggled from the status-bar switch. Aesthetic mode hides it independently via CSS
     * (body.aesthetic-mode .view-cube), so this only tracks the user's own preference.
     */
    _setViewCubeEnabled(enabled) {
        this.viewCubeEnabled = !!enabled;
        const btn = this.ui.btnViewCube;
        if (btn) btn.classList.toggle('active', this.viewCubeEnabled);
        if (this.viewCube) this.viewCube.setVisible(this.viewCubeEnabled);
    }

    /**
     * Shows the tip box and starts tracking button hovers. The box keeps the
     * last-hovered button's description on screen (persistent), starting from a
     * placeholder until the first hover lands.
     */
    _enableTipTracking() {
        const box = this.ui.tipBox;
        if (!box) return;

        box.classList.remove('hidden');
        this._setTipPlaceholder();

        if (this._tipMouseOverHandler) return; // already tracking
        this._tipMouseOverHandler = (e) => {
            const target = e.target;
            const btn = (target && typeof target.closest === 'function') ? target.closest('button') : null;
            if (!btn) return;
            this._showTipFor(btn);
        };
        document.addEventListener('mouseover', this._tipMouseOverHandler);
    }

    /** Hides the tip box and stops tracking button hovers. */
    _disableTipTracking() {
        const box = this.ui.tipBox;
        if (box) box.classList.add('hidden');

        if (this._tipMouseOverHandler) {
            document.removeEventListener('mouseover', this._tipMouseOverHandler);
            this._tipMouseOverHandler = null;
        }
    }

    /** Default content shown before any button has been hovered yet. */
    _setTipPlaceholder() {
        if (!this.ui.tipBoxTitle || !this.ui.tipBoxDesc) return;
        this.ui.tipBoxTitle.textContent = 'Tips';
        this.ui.tipBoxDesc.textContent = 'Hover over any button to see what it does.';
    }

    /**
     * Fills the tip box from a hovered element. The description comes from its
     * title attribute (the richest source, present on most buttons); the heading
     * is the visible label, or the short form of the title for icon-only buttons.
     */
    _showTipFor(el) {
        if (!this.ui.tipBoxTitle || !this.ui.tipBoxDesc) return;

        const label = (el.textContent || '').trim();
        const title = el.getAttribute('title') || '';

        let heading = label;
        if (!heading && title) {
            // Icon-only button: use the part of the title before " - " as its name.
            const dashIdx = title.indexOf(' - ');
            heading = (dashIdx > 0 ? title.slice(0, dashIdx) : title).trim();
        }

        const desc = title || 'No description available.';

        // Avoid a redundant heading that just repeats the description verbatim.
        this.ui.tipBoxTitle.textContent =
            (heading && heading.toLowerCase() !== desc.toLowerCase()) ? heading : '';
        this.ui.tipBoxDesc.textContent = desc;
    }

    /**
     * Opens the .config editor popup. Fetches every setting from /api/config,
     * renders one editable field per key grouped by section, and lets the user
     * Save (POSTs back to /api/config) or Cancel. On save, the purely-frontend
     * ui.* values are re-applied to the live session so they take effect right
     * away; everything else persists to .config and applies on next load.
     */
    async _showSettingsPopup() {
        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay';

        const dialog = document.createElement('div');
        dialog.className = 'modal-dialog settings-dialog';

        // Header row with title and a close button (dismisses without saving).
        const header = document.createElement('div');
        header.className = 'modal-header';
        const titleEl = document.createElement('span');
        titleEl.className = 'modal-title';
        titleEl.textContent = 'Settings';
        const closeBtn = document.createElement('button');
        closeBtn.className = 'modal-close';
        closeBtn.innerHTML = '&times;';
        header.appendChild(titleEl);
        header.appendChild(closeBtn);

        // Body is filled with the section groups once /api/config responds.
        const body = document.createElement('div');
        body.className = 'modal-body settings-body';

        // Footer: an error line (hidden until a save fails) plus Cancel/Save.
        const footer = document.createElement('div');
        footer.className = 'modal-footer settings-footer';
        const errorEl = document.createElement('div');
        errorEl.className = 'settings-error hidden';
        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'btn-secondary';
        cancelBtn.textContent = 'Cancel';
        const saveBtn = document.createElement('button');
        saveBtn.className = 'btn-primary';
        saveBtn.textContent = 'Save';

        dialog.appendChild(header);
        dialog.appendChild(body);
        footer.appendChild(errorEl);
        footer.appendChild(cancelBtn);
        footer.appendChild(saveBtn);
        dialog.appendChild(footer);
        overlay.appendChild(dialog);
        document.body.appendChild(overlay);

        const close = () => overlay.remove();
        closeBtn.addEventListener('click', close);
        cancelBtn.addEventListener('click', close);
        overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

        // Load the current config; abort cleanly if it cannot be fetched.
        let config;
        try {
            const resp = await fetch('/api/config');
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            config = await resp.json();
        } catch (err) {
            this._showAlert('Could not load settings: ' + err.message, 'Settings');
            close();
            return;
        }

        // Per-key help text from the .config comments; shown under each option.
        // Non-fatal - without it the popup still works, just without descriptions.
        let descriptions = {};
        try {
            const descResp = await fetch('/api/config/descriptions');
            if (descResp.ok) descriptions = await descResp.json();
        } catch (_) {}

        // Build one field per key. Each entry records its section/key/type so
        // Save can read and coerce the control back to a value for the backend.
        const fields = [];
        for (const [section, values] of Object.entries(config)) {
            const group = document.createElement('div');
            group.className = 'settings-section';
            const heading = document.createElement('h3');
            heading.className = 'settings-section-title';
            heading.textContent = section.replace(/_/g, ' ');
            group.appendChild(heading);

            for (const [key, value] of Object.entries(values)) {
                const row = document.createElement('div');
                row.className = 'settings-row';
                const label = document.createElement('label');
                label.className = 'settings-label';
                label.textContent = key.replace(/_/g, ' ');

                let input;
                if (typeof value === 'boolean') {
                    input = document.createElement('input');
                    input.type = 'checkbox';
                    input.checked = value;
                    fields.push({ section, key, type: 'bool', el: input });
                } else if (typeof value === 'number') {
                    input = document.createElement('input');
                    input.type = 'number';
                    input.value = value;
                    if (!Number.isInteger(value)) input.step = '0.1';
                    fields.push({ section, key, type: 'number', el: input });
                } else {
                    input = document.createElement('input');
                    input.type = 'text';
                    input.value = value;
                    fields.push({ section, key, type: 'string', el: input });
                }

                const description = (descriptions[section] || {})[key];

                row.appendChild(label);
                row.appendChild(input);
                if (description) {
                    const descEl = document.createElement('div');
                    descEl.className = 'settings-desc';
                    descEl.textContent = description;
                    row.appendChild(descEl);
                }
                group.appendChild(row);
            }
            body.appendChild(group);
        }

        // Save: read every control back into a {section:{key:value}} payload and POST it.
        saveBtn.addEventListener('click', async () => {
            const payload = {};
            for (const f of fields) {
                if (!payload[f.section]) payload[f.section] = {};
                let v;
                if (f.type === 'bool') {
                    v = f.el.checked;
                } else if (f.type === 'number') {
                    const num = parseFloat(f.el.value);
                    if (Number.isNaN(num)) {
                        errorEl.textContent = `Please enter a valid number for "${f.key.replace(/_/g, ' ')}".`;
                        errorEl.classList.remove('hidden');
                        return;
                    }
                    v = num;
                } else {
                    v = f.el.value;
                }
                payload[f.section][f.key] = v;
            }

            saveBtn.disabled = true;
            try {
                const resp = await fetch('/api/config', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload),
                });
                if (!resp.ok) {
                    let msg = `Save failed (HTTP ${resp.status})`;
                    try { const j = await resp.json(); if (j.error) msg = j.error; } catch (_) {}
                    errorEl.textContent = msg;
                    errorEl.classList.remove('hidden');
                    return; // keep the popup open so the user can fix the value
                }
                const saved = await resp.json();
                close();
                this._applySavedUiSettings(saved.ui || {});
                this.ui.showToggleMessage('Settings saved');
            } catch (err) {
                errorEl.textContent = 'Could not save settings: ' + err.message;
                errorEl.classList.remove('hidden');
            } finally {
                saveBtn.disabled = false;
            }
        });

        // Move focus to the first field once the overlay is painted.
        const firstInput = body.querySelector('input, select');
        if (firstInput) setTimeout(() => firstInput.focus(), 50);
    }

    /**
     * Re-applies the frontend-facing ui.* settings that were just saved so they
     * take effect in the live session without a reload. Only touches pure UI
     * state (theme, units, tip mode, message-mute) - scene parameters persist to
     * .config and apply on next load.
     */
    _applySavedUiSettings(uiValues) {
        const ui = this.ui;

        // Theme: "day" flips to the light UI; anything else is night (dark).
        const night = (uiValues.theme ?? 'night') !== 'day';
        if (this.nightModeEnabled !== night) {
            this.nightModeEnabled = night;
            document.body.classList.toggle('light-mode', !night);
            if (ui.btnDayMode) ui.btnDayMode.classList.toggle('active', night);
        }

        // Units: shown in the status-bar unit toggle.
        if (['mm', 'cm', 'in'].includes(uiValues.units) && ui._currentUnit !== uiValues.units) {
            ui._currentUnit = uiValues.units;
            if (ui.btnUnitToggle) ui.btnUnitToggle.textContent = uiValues.units;
        }

        // Tip mode: flips the persistent hover-description box.
        const tip = !!uiValues.tip_mode;
        if (this.tipModeEnabled !== tip) this._setTipMode(tip);

        // View cube: flips the top-left orientation indicator.
        const cube = !!uiValues.view_cube_visible;
        if (this.viewCubeEnabled !== cube) this._setViewCubeEnabled(cube);

        // Message mute: suppresses setting-change toasts.
        const muted = !!uiValues.messages_muted;
        if (ui.messagesMuted !== muted) {
            ui.messagesMuted = muted;
            if (ui.btnMuteMessages) {
                ui.btnMuteMessages.classList.toggle('active', !muted);
                ui.btnMuteMessages.title = muted
                    ? 'Setting messages muted - click to unmute'
                    : 'Toggle setting-change messages';
            }
        }
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
                        // A multi-object archive (e.g. a saved 3MF) already carries the layout its
                        // objects were placed at - snapping each piece to the plate individually
                        // would destroy it, so only single-object imports get centered and dropped.
                        const snapToFloor = result.objects.length === 1;
                        // Import separation (.config [import]) applies under the same condition:
                        // multi-piece archives keep their internal layout intact.
                        const separate = snapToFloor && this.importSeparationEnabled;
                        for (const objData of result.objects) {
                            const frontendId = this.meshSync.loadFromServer(objData, { snapToFloor, separate, testHollow: true });
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
                } else if (scene.objects.size > 1) {
                    // Whole-scene combined export: snapshot every object client-side at its
                    // current position instead of pulling one backend session's worth.
                    if (format !== '3mf' && this._warnIfNotSolid(
                        [...scene.objects.keys()], 'export', 'the shapes in the scene'
                    )) return;
                    blob = await this.api.exportScene(format, this._buildWorldSpaceMeshes(format));
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
                    const result = await this.api.solidifyMesh(backendInfo.sessionId || this.sessionId, backendInfo.objectId);
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
                    // A selected source carries the highlight tint in `emissive`; zeroing it here keeps pasted copies from baking
                    // that in - the fresh mesh has no _origEmissive backup yet to restore from.
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
                    // copy keeps full support for solid, boolean ops, and export.
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
                            console.warn('Backend duplicate failed - pasted copy will need re-importing before solid/boolean ops/export will work:', err.message);
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

        // Separate - for each selected object, splits physically disconnected pieces of geometry (e.g. a sphere and a cube
        // that aren't touching) into their own models. Purely topological, so it runs client-side with no backend round trip;
        // single-piece objects are untouched.
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
            // Generation runs as a background job the modal doesn't own - require Stop first so an in-flight job can't
            // disappear with no way back to its Stop button. (setAiGenerating(true) already disables close/backdrop-click
            // for the same reason; this is a backstop.)
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

            let pickedId = scene.pickObject(clientX, clientY);

            if (!pickedId) {
                // A click that lands on no visible surface still counts when it
                // falls inside a selected shape's slightly enlarged invisible
                // hitbox - the box is part of the shape's clickable region.
                pickedId = scene.pickSelectedByHitbox ? scene.pickSelectedByHitbox(clientX, clientY) : null;
                if (!pickedId) {
                    // A click that lands on no model is ignored.
                    return;
                }
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

        // Aesthetic mode toggle - off by default; hides every menu/toolbar/panel except the status bar and switches on
        // dramatic viewport lighting (all CSS, see .aesthetic-mode in app.css, except the lighting itself).
        ui.on('toggleAestheticMode', () => {
            this.aestheticModeEnabled = !this.aestheticModeEnabled;
            document.body.classList.toggle('aesthetic-mode', this.aestheticModeEnabled);
            if (ui.btnAestheticMode) {
                ui.btnAestheticMode.classList.toggle('active', this.aestheticModeEnabled);
            }
            if (scene.setDramaticLighting) {
                scene.setDramaticLighting(this.aestheticModeEnabled);
            }
            // Toggling menus/panels resizes #viewport-container via CSS reflow only - no 'resize' event fires on its own,
            // so dispatch one manually after the new layout paints (double rAF) for SceneController's renderer/camera sizing.
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

        // Settings button (bottom-right) - opens the .config editor popup.
        ui.on('openSettings', () => this._showSettingsPopup());

        // Tip-mode toggle - flips the persistent hover-description box on/off.
        ui.on('toggleTipMode', () => {
            this._setTipMode(!this.tipModeEnabled);
            ui.showToggleMessage(this.tipModeEnabled ? 'Tip mode enabled' : 'Tip mode disabled');
        });

        // Orientation-indicator toggle - flips the top-left axis gizmo on/off.
        ui.on('toggleViewCube', () => {
            this._setViewCubeEnabled(!this.viewCubeEnabled);
            ui.showToggleMessage(this.viewCubeEnabled ? 'Orientation indicator enabled' : 'Orientation indicator disabled');
        });



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

            // Commit the just-finished move/rotate/scale to the backend - drags only update the local Three.js object, so
            // without this the backend's copy drifts and later boolean ops would run on stale, pre-drag geometry.
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
     * Serializes transform commits through one promise chain so overlapping calls never both POST for the same backend object id -
     * a successful commit swaps in a new id, so a second stale request would 400; later calls re-read the latest objectId.
     */
    _commitTransforms(frontendIds) {
        const prev = this._transformCommitChain || Promise.resolve();
        const p = prev.then(() => this._doCommitTransforms(frontendIds));
        // Keep the chain alive even if a commit rejects, so later commits don't hang.
        this._transformCommitChain = p.catch(() => {});
        return p;
    }

    /**
     * Commits each object's current client-side transform to the backend, baking it into its stored vertices - drags only mutate the
     * Three.js object locally, so uncommitted moves leave later ops on stale geometry. Identity-matrix objects are skipped.
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
            // Transformed objects were just rebuilt as brand-new meshes with plain "normal" materials, so reapply the active
            // view mode to keep wireframe/transparent/hybrid looking right.
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
        // Center the object horizontally (XZ) on the build plate's origin - primitives in particular come back with an offset
        // footprint, so shift by the negative bbox center to land its midpoint exactly there.
        mesh.position.x -= (box.min.x + box.max.x) / 2;
        mesh.position.z -= (box.min.z + box.max.z) / 2;
        // Drop it until its lowest point rests on the build plate (y = 0).
        mesh.position.y -= box.min.y;
    }

    /**
     * Import separation (.config [import]): shifts a freshly imported mesh along X/Z so its bounding box ends up at least
     * importMinGapMm clear of every other object's box; runs after _snapToBuildPlate, so the shape stays seated on the plate.
     * Sweeps all four directions and applies the cheapest escape (zero distance = no movement).
     */
    _applyImportSeparation(mesh) {
        const scene = this.sceneController;
        if (scene.objects.size === 0) return;

        const gap = this.importMinGapMm;
        const box = new THREE.Box3().setFromObject(mesh);
        if (box.isEmpty()) return;

        // Every other object's world-space bounding box.
        const others = [];
        for (const id of scene.objects.keys()) {
            const obj = scene.objects.get(id);
            if (!obj || obj === mesh) continue;
            const b = new THREE.Box3().setFromObject(obj);
            if (!b.isEmpty() && isFinite(b.min.x) && isFinite(b.max.z)) others.push(b);
        }

        // Two boxes are clear of each other once separated by at least `gap` on X or Z.
        const zClear = (a, b) => a.min.z >= b.max.z + gap || a.max.z <= b.min.z - gap;
        const xClear = (a, b) => a.min.x >= b.max.x + gap || a.max.x <= b.min.x - gap;

        // Sweep the box's footprint out of every other box along one horizontal axis.
        // Returns how far it would travel (0 = already clear of everything). The sweep
        // only ever moves in the given direction, jumping past offending boxes until
        // none remain - guaranteed to settle since each jump lands further along.
        const sweepDistance = (axis, dir) => {
            let lo = axis === 'x' ? box.min.x : box.min.z;
            let hi = axis === 'x' ? box.max.x : box.max.z;
            const start = lo;

            for (let iter = 0; iter <= others.length + 1; iter++) {
                // Offenders: not clear on the static axis and closer than `gap` on this one.
                let target = dir > 0 ? -Infinity : Infinity;
                for (const e of others) {
                    const eLo = axis === 'x' ? e.min.x : e.min.z;
                    const eHi = axis === 'x' ? e.max.x : e.max.z;
                    if (axis === 'x' ? zClear(box, e) : xClear(box, e)) continue;
                    if (eHi <= lo - gap || hi <= eLo - gap) continue; // already separated on this axis
                    target = dir > 0 ? Math.max(target, eHi + gap) : Math.min(target, eLo - gap);
                }
                if (!isFinite(target)) return Math.abs(start - lo); // nothing left to clear
                // Jump so the leading edge lands on `target`: +dir moves lo up, -dir moves hi down.
                const delta = dir > 0 ? target - lo : hi - target;
                lo += dir * delta;
                hi += dir * delta;
            }

            return Math.abs(start - lo);
        };

        const candidates = [
            { axis: 'x', dir: 1, dist: sweepDistance('x', 1) },
            { axis: 'x', dir: -1, dist: sweepDistance('x', -1) },
            { axis: 'z', dir: 1, dist: sweepDistance('z', 1) },
            { axis: 'z', dir: -1, dist: sweepDistance('z', -1) },
        ];

        // Take the cheapest escape; no movement at all when everything is already clear.
        let best = null;
        for (const c of candidates) {
            if (c.dist > 0 && (!best || c.dist < best.dist)) best = c;
        }
        if (!best) return;

        mesh.position[best.axis] += best.dir * best.dist;
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
