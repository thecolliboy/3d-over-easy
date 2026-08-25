import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';

// Single source of truth for the selection hue - main.js derives its
// highlight glow from it, so no module invents a competing color.
export const SELECTION_COLOR = 0x5390d9;

// Axis stub length as a fraction of the build-plate edge (0.3 at the default 10-unit plate)
const AXIS_LEN_RATIO = 0.3 / 10;

/**
 * ColliBoy - Owns the viewport's Three.js scene graph: WebGL renderer,
 * perspective camera, orbit controls, four-light rig, build-plate furniture,
 * object registry with multi-selection, view modes and LOD switching.
 */
export class SceneController {
    constructor(canvas, options = {}) {
        this.canvas = canvas;
        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(0x0d0d1a);

        // Perspective camera - 50° fov keeps part-scale geometry undistorted;
        // the far plane comes from .config (viewport.camera_far) so huge models
        // can be framed without their far side being clipped by it.
        this.camera = new THREE.PerspectiveCamera(
            50,
            this.getAspect(),
            0.01,
            options.cameraFar ?? 100000
        );
        this.camera.position.set(3, 2, 3);
        this.camera.lookAt(0, 0, 0);

        // WebGL renderer - antialiased canvas with the high-performance GPU hint
        this.renderer = new THREE.WebGLRenderer({
            canvas: canvas,
            antialias: true,
            alpha: false,
            powerPreference: 'high-performance',
            stencil: false,  // nothing here draws into the stencil buffer; skipping it saves VRAM
        });
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        this.renderer.shadowMap.enabled = true;
        this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
        this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
        this.renderer.toneMappingExposure = 1.2;
        this.setSize();

        // Orbit controls with damping enabled for smooth camera motion
        this.controls = new OrbitControls(this.camera, this.canvas);
        this.controls.enableDamping = true;
        this.controls.dampingFactor = 0.08;
        this.controls.minDistance = 0.1;
        this.controls.target.set(0, 0, 0);

        // Assemble the four-light rig
        this.setupLighting();

        // Simple-plate mode - when on, resizes stretch the existing plate
        // furniture instead of disposing and rebuilding it (cheaper for the
        // frequent auto-resizes the infinite build plate performs). Seeded
        // from .config via App.
        this.simplePlateMode = options.simplePlate ?? false;

        // Lay down the build-plate furniture (grid, surface, axes, border);
        // its initial edge length comes from .config via App
        this.setupBuildPlate(options.gridSize ?? 10);

        // Per-object bookkeeping (registry, selection counters)
        this.objects = new Map();  // objectId -> added object (Mesh or Group)
        this.selectedObject = null;
        this.selectedObjects = new Set();  // ids currently selected (multi-select set)
        this.objectIdCounter = 0;

        // Active view mode
        this.viewMode = 'normal'; // one of normal / wireframe / transparent / wireframe-hybrid

        // Shading style - tracked separately from viewMode above. Flat
        // (default) gives every triangle its own face normal, so adjoining
        // facets catch light differently and the model reads as raw solid
        // polygons; smooth (the old default) blends normals across shared
        // vertices for a rounded, bumpy look instead. Seeded from .config via App.
        this.smoothShading = options.smoothShading ?? false;

        // Level-of-detail system - each object may carry several detail levels
        this.lodEnabled = options.lodEnabled ?? true;   // on by default
        this.lodLevelsPerObject = new Map();  // objectId -> array of per-level mesh descriptors
        this.currentLodIndex = new Map();    // objectId -> active level index

        // Camera-distance thresholds (world units) that trigger each LOD level
        this._lodDistances = [0, 10, 25, 50];  // <=10 -> L0, >10 -> L1, >25 -> L2, >50 -> L3

        // Optional WebGL optimizer (injected via setOptimizer): geometry-creation
        // helper, material caching and render stats
        this.optimizer = null;

        // Keep renderer and camera sized to the container on window resize
        this.onResize = this.onResize.bind(this);
        window.addEventListener('resize', this.onResize);
    }

    getAspect() {
        const container = this.canvas.parentElement;
        return container.clientWidth / container.clientHeight;
    }

    setSize() {
        const container = this.canvas.parentElement;
        const width = container.clientWidth;
        const height = container.clientHeight;
        this.renderer.setSize(width, height);
        this.camera.aspect = width / height;
        this.camera.updateProjectionMatrix();
        // LineMaterial measures its screen-space pixel width against the canvas
        // size, so keep it in sync or the axis stubs' thickness drifts on resize
        this._syncAxisResolution();
    }

    onResize() {
        this.setSize();
    }

    setupLighting() {
        // Dim ambient fill so shadowed areas never go fully black
        const ambient = new THREE.AmbientLight(0x404060, 0.8);
        this.scene.add(ambient);

        // Hemisphere light - cooler sky tone above, darker ground bounce below
        const hemi = new THREE.HemisphereLight(0x8090b0, 0x303040, 0.6);
        this.scene.add(hemi);

        // Key "sun" directional light; the only one casting shadows
        const dirLight = new THREE.DirectionalLight(0xffffff, 1.5);
        dirLight.position.set(5, 8, 5);
        dirLight.castShadow = true;
        dirLight.shadow.mapSize.width = 2048;
        dirLight.shadow.mapSize.height = 2048;
        dirLight.shadow.camera.near = 0.5;
        dirLight.shadow.camera.far = 50;
        dirLight.shadow.camera.left = -10;
        dirLight.shadow.camera.right = 10;
        dirLight.shadow.camera.top = 10;
        dirLight.shadow.camera.bottom = -10;
        this.scene.add(dirLight);

        // Shadow-side fill to soften the key light's contrast
        const fillLight = new THREE.DirectionalLight(0x8090b0, 0.4);
        fillLight.position.set(-3, 4, -3);
        this.scene.add(fillLight);

        // Retain handles to all four lights and snapshot every tunable
        // (intensities, colors, exposure, background) for clean restoration.
        this._lights = { ambient, hemi, dirLight, fillLight };
        this._defaultLighting = {
            ambientIntensity: ambient.intensity,
            hemiIntensity: hemi.intensity,
            dirIntensity: dirLight.intensity,
            dirColor: dirLight.color.clone(),
            fillIntensity: fillLight.intensity,
            fillColor: fillLight.color.clone(),
            toneMappingExposure: this.renderer.toneMappingExposure,
            background: this.scene.background ? this.scene.background.clone() : null,
        };
    }

    /**
     * Aesthetic Mode's lighting treatment: dims the flat ambient and
     * hemisphere fills so shapes gain contrast, warms and boosts the main
     * directional "sun" for punchier highlights, shifts the fill light cool
     * for warm/cool separation, and nudges exposure up for a cinematic feel.
     * Passing false restores exactly what setupLighting() captured.
     */
    setDramaticLighting(enabled) {
        const lights = this._lights;
        const defaults = this._defaultLighting;
        if (!lights || !defaults) return;

        if (enabled) {
            lights.ambient.intensity = defaults.ambientIntensity * 0.35;
            lights.hemi.intensity = defaults.hemiIntensity * 0.5;

            lights.dirLight.intensity = defaults.dirIntensity * 1.6;
            lights.dirLight.color.set(0xfff1d6); // warm-shifted key

            lights.fillLight.intensity = defaults.fillIntensity * 1.3;
            lights.fillLight.color.set(0x5a6fff); // cool fill pushing warm/cool separation

            this.renderer.toneMappingExposure = defaults.toneMappingExposure * 1.15;
            this.scene.background = new THREE.Color(0x05050f);
        } else {
            lights.ambient.intensity = defaults.ambientIntensity;
            lights.hemi.intensity = defaults.hemiIntensity;
            lights.dirLight.intensity = defaults.dirIntensity;
            lights.dirLight.color.copy(defaults.dirColor);
            lights.fillLight.intensity = defaults.fillIntensity;
            lights.fillLight.color.copy(defaults.fillColor);
            this.renderer.toneMappingExposure = defaults.toneMappingExposure;
            if (defaults.background) this.scene.background = defaults.background.clone();
        }
    }

    /**
     * Even-lighting treatment: flattens the rig so every surface is lit about
     * equally - boosts the ambient and hemisphere fills and dims the shadow-
     * casting directional key to a whisper. Passing false restores exactly what
     * setupLighting() captured, re-applying dramatic lighting when aesthetic
     * mode is active (aestheticActive).
     */
    setEvenLighting(enabled, aestheticActive = false) {
        const lights = this._lights;
        const defaults = this._defaultLighting;
        if (!lights || !defaults) return;

        if (enabled) {
            lights.ambient.intensity = defaults.ambientIntensity * 2.5;
            lights.hemi.intensity = defaults.hemiIntensity * 1.8;
            lights.dirLight.intensity = defaults.dirIntensity * 0.1; // key dimmed to a whisper, shadows nearly vanish
        } else {
            lights.ambient.intensity = defaults.ambientIntensity;
            lights.hemi.intensity = defaults.hemiIntensity;
            lights.dirLight.intensity = defaults.dirIntensity;
            lights.dirLight.color.copy(defaults.dirColor);
            lights.fillLight.intensity = defaults.fillIntensity;
            lights.fillLight.color.copy(defaults.fillColor);
            this.renderer.toneMappingExposure = defaults.toneMappingExposure;
            if (defaults.background) this.scene.background = defaults.background.clone();
            if (aestheticActive) this.setDramaticLighting(true);
        }
    }

    setupBuildPlate(gridSize = 10) {
        // Native (unscaled) size of the plate furniture below; simple-plate
        // mode derives its stretch factor from this value.
        this._plateGeomSize = gridSize;

        // GridHelper marking out the initial build area with ~0.2-unit cells,
        // matching setBuildPlateSize's division formula
        const gridDivisions = Math.min(200, Math.max(10, Math.round(gridSize / 0.2)));
        this.grid = new THREE.GridHelper(gridSize, gridDivisions, 0x2a2a44, 0x1e1e36);
        this.grid.position.y = -0.001; // parked a hair under y=0 so bed geometry can't z-fight it
        this.scene.add(this.grid);

        // Translucent solid plate mesh beneath the grid; shadow receiver
        const plateGeo = new THREE.PlaneGeometry(gridSize, gridSize);
        const plateMat = new THREE.MeshStandardMaterial({
            color: 0x16213e,
            roughness: 0.9,
            metalness: 0.1,
            transparent: true,
            opacity: 0.5,
        });
        this.buildPlate = new THREE.Mesh(plateGeo, plateMat);
        this.buildPlate.rotation.x = -Math.PI / 2;
        this.buildPlate.position.y = -0.002;
        this.buildPlate.receiveShadow = true;
        this.buildPlate.name = 'buildPlate';
        this.scene.add(this.buildPlate);

        // X/Y/Z axis stubs in conventional red/green/blue at the origin; their
        // length tracks the plate edge so they stay proportional on resize
        this.axisLines = this._createAxisLines(gridSize * AXIS_LEN_RATIO);
        this.scene.add(this.axisLines);

        // Edge outline tracing the plate's perimeter
        const borderGeo = new THREE.EdgesGeometry(new THREE.PlaneGeometry(gridSize, gridSize));
        const borderMat = new THREE.LineBasicMaterial({ color: 0x3a3a5a });
        this.borderLine = new THREE.LineSegments(borderGeo, borderMat);
        this.borderLine.rotation.x = -Math.PI / 2;
        this.borderLine.position.y = -0.001;
        this.scene.add(this.borderLine);

        // Small cross at the bed center marking the origin
        const centerLen = 0.15;
        const cxMat = new THREE.LineBasicMaterial({ color: 0x6a6a82 });
        const cxGeoH = new THREE.BufferGeometry().setFromPoints([
            new THREE.Vector3(-centerLen, 0, 0),
            new THREE.Vector3(centerLen, 0, 0),
        ]);
        const cxGeoV = new THREE.BufferGeometry().setFromPoints([
            new THREE.Vector3(0, 0, -centerLen),
            new THREE.Vector3(0, 0, centerLen),
        ]);
        this.centerCrosshair = new THREE.Group();
        this.centerCrosshair.name = 'centerCrosshair';
        this.centerCrosshair.add(new THREE.Line(cxGeoH, cxMat));
        this.centerCrosshair.add(new THREE.Line(cxGeoV, cxMat));
        this.scene.add(this.centerCrosshair);
    }

    /**
     * Build the red/green/blue X/Y/Z axis stubs at the origin as thick lines:
     * Line2/LineMaterial, since plain THREE.Line can't be made thicker in WebGL.
     * Each stub is `length` units long; linewidth is a fixed screen-space pixel
     * count so the stubs stay readable no matter how far the camera zooms.
     */
    _createAxisLines(length) {
        const origin = new THREE.Vector3(0, 0, 0);
        const specs = [
            { color: 0xff4444, end: new THREE.Vector3(length, 0, 0) },   // X red
            { color: 0x44ff44, end: new THREE.Vector3(0, length, 0) },   // Y green
            { color: 0x4488ff, end: new THREE.Vector3(0, 0, length) },   // Z blue
        ];

        const group = new THREE.Group();
        group.name = 'axisLines';
        this._axisMaterials = [];

        specs.forEach(({ color, end }) => {
            const geo = new LineGeometry().setPositions([origin.x, origin.y, origin.z, end.x, end.y, end.z]);
            // Slightly thicker than the default 1px line WebGL would give us
            const mat = new LineMaterial({ color, linewidth: 2 });
            this._axisMaterials.push(mat);
            group.add(new Line2(geo, mat));
        });

        this._syncAxisResolution();
        return group;
    }

    /**
     * Dispose the current axis stubs (geometry + materials) so a resize can
     * rebuild them at the new plate-proportional length.
     */
    _disposeAxisLines() {
        if (!this.axisLines) return;
        this.scene.remove(this.axisLines);
        this.axisLines.traverse((child) => {
            if (child.geometry) child.geometry.dispose();
        });
        (this._axisMaterials || []).forEach((m) => m.dispose());
        this._axisMaterials = [];
        this.axisLines = null;
    }

    /**
     * Keep the axis stubs' screen-space linewidth correct for the current canvas
     * size - LineMaterial measures its pixel width against this resolution.
     */
    _syncAxisResolution() {
        if (!this._axisMaterials) return;
        const size = new THREE.Vector2();
        this.renderer.getSize(size);
        if (size.x > 0 && size.y > 0) {
            this._axisMaterials.forEach((m) => m.resolution.copy(size));
        }
    }

    /**
     * Resize the build plate: by default disposes the old grid/surface/border
     * and rebuilds all of them at the new size (the infinite-build-plate
     * feature calls this repeatedly as the bed grows). In simple-plate mode it
     * instead stretches the existing furniture in place - no geometry or
     * material is recreated, so these frequent resizes stay cheap.
     */
    setBuildPlateSize(size) {
        if (!Number.isFinite(size) || size <= 0) return;

        // Simple-plate mode: stretch the current meshes to the target instead of
        // rebuilding them. The scale is computed against the furniture's native
        // (unscaled) size, so it stays exact no matter how many times we've
        // stretched before. Each object stretches along its own world axes -
        // the grid lies flat in XZ natively, while the plate/border are rotated
        // to lie flat, so their local XY maps onto world X/Z.
        if (this.simplePlateMode) {
            const factor = size / this._plateGeomSize;
            if (!Number.isFinite(factor) || factor <= 0) return;
            if (this.grid) this.grid.scale.set(factor, 1, factor);
            if (this.buildPlate) this.buildPlate.scale.set(factor, factor, 1);
            if (this.borderLine) this.borderLine.scale.set(factor, factor, 1);
            // Axis stubs stretch uniformly so their length stays proportional to the plate edge
            if (this.axisLines) this.axisLines.scale.setScalar(factor);
            return;
        }

        // Tear down and dispose the previous grid/surface/border - this runs a
        // lot as the bed resizes, so leaked GPU buffers would add up fast.
        [this.grid, this.buildPlate, this.borderLine].forEach((obj) => {
            if (!obj) return;
            this.scene.remove(obj);
            if (obj.geometry) obj.geometry.dispose();
            if (obj.material) {
                if (Array.isArray(obj.material)) obj.material.forEach(m => m.dispose());
                else obj.material.dispose();
            }
        });

        // Axis stubs are rebuilt at the new plate-proportional length below
        this._disposeAxisLines();

        // Derive divisions from size (~0.2-unit cells) so line density stays
        // steady while the plate scales, clamped to a sane 10..200 range.
        const divisions = Math.min(200, Math.max(10, Math.round(size / 0.2)));
        this.grid = new THREE.GridHelper(size, divisions, 0x2a2a44, 0x1e1e36);
        this.grid.position.y = -0.001;
        this.scene.add(this.grid);

        // Rebuild the translucent plate mesh at the new size
        const plateGeo = new THREE.PlaneGeometry(size, size);
        const plateMat = new THREE.MeshStandardMaterial({
            color: 0x16213e,
            roughness: 0.9,
            metalness: 0.1,
            transparent: true,
            opacity: 0.5,
        });
        this.buildPlate = new THREE.Mesh(plateGeo, plateMat);
        this.buildPlate.rotation.x = -Math.PI / 2;
        this.buildPlate.position.y = -0.002;
        this.buildPlate.receiveShadow = true;
        this.scene.add(this.buildPlate);

        // Rebuild the axis stubs at the new plate-proportional length
        this.axisLines = this._createAxisLines(size * AXIS_LEN_RATIO);
        this.scene.add(this.axisLines);

        // Rebuild the perimeter outline
        const borderGeo = new THREE.EdgesGeometry(new THREE.PlaneGeometry(size, size));
        const borderMat = new THREE.LineBasicMaterial({ color: 0x3a3a5a });
        this.borderLine = new THREE.LineSegments(borderGeo, borderMat);
        this.borderLine.rotation.x = -Math.PI / 2;
        this.borderLine.position.y = -0.001;
        this.scene.add(this.borderLine);

        // The rebuilt furniture is native (unscaled) geometry at `size`, so the
        // simple-plate stretch factor below now measures against it.
        this._plateGeomSize = size;
    }

    /**
     * Switch between rebuilding the plate on every resize (false) and simply
     * stretching the existing furniture in place (true). The next call to
     * setBuildPlateSize picks up whichever mode is active.
     */
    setSimplePlateMode(enabled) {
        this.simplePlateMode = !!enabled;
    }

    /**
     * Dispose the current grid/surface/border and rebuild them all at `size`,
     * regardless of simple-plate mode - re-baselining the furniture so its native
     * (unscaled) size is exactly `size`. Used when entering simple-plate mode so
     * that stretching always starts from the default-size geometry (steady grid
     * density) instead of whatever larger, densely-divided plate happened to be
     * in place. The active mode is restored afterwards for future stretches.
     */
    rebuildBuildPlate(size) {
        if (!Number.isFinite(size) || size <= 0) return;
        const wasSimple = this.simplePlateMode;
        this.simplePlateMode = false;   // force the dispose-and-rebuild path below
        this.setBuildPlateSize(size);
        this.simplePlateMode = wasSimple;
    }

    /**
     * Show or hide all build-plate elements (grid, surface, border and center
     * crosshair) in one call.
     */
    setBuildPlateVisible(visible) {
        if (this.grid) this.grid.visible = visible;
        if (this.buildPlate) this.buildPlate.visible = visible;
        if (this.borderLine) this.borderLine.visible = visible;
        if (this.centerCrosshair) this.centerCrosshair.visible = visible;
    }

    /**
     * Show or hide just the red/green/blue axis stubs at the origin, leaving
     * the rest of the build plate untouched.
     */
    setAxisVisible(visible) {
        if (this.axisLines) this.axisLines.visible = visible;
    }

    /**
     * Create the per-mesh wireframe overlay: a full black wireframe
     * (hidden by default, shown only in 'wireframe-hybrid' mode). It's a
     * plain LineSegments - not THREE.Mesh - so it's automatically skipped
     * by raycasting/picking, view-mode material switching, and mesh stat
     * counting, which all filter on `child.isMesh`.
     */
    _addMeshOverlays(child) {
        if (!child.isMesh || !child.geometry) return;

        // The wireframe overlay below sits exactly on the mesh surface
        // (it's built from its own geometry), so without help the GPU depth
        // buffer can't reliably tell which one is "in front". Nudging the
        // solid surface's depth back very slightly (polygon offset) makes
        // the faces lose ties cleanly, so the overlay drawn on top always
        // wins instead of z-fighting.
        this._makeOutlineSafe(child.material);

        // Black full-edge overlay used by 'wireframe-hybrid': draws every
        // triangle edge over a fully visible solid surface.
        const wireGeo = new THREE.WireframeGeometry(child.geometry);
        const wireMat = new THREE.LineBasicMaterial({ color: 0x000000 });
        const wireOverlay = new THREE.LineSegments(wireGeo, wireMat);
        wireOverlay.visible = false;
        wireOverlay.userData.isOverlay = true;
        child.add(wireOverlay);
        child.userData._wireframeOverlay = wireOverlay;
    }

    /**
     * Nudge a solid-surface material's rasterized depth back slightly so
     * coincident overlay lines (outline, wireframe-hybrid) don't z-fight
     * with it. Safe to call on any material, including ones swapped in later.
     */
    _makeOutlineSafe(material) {
        if (!material) return;
        material.polygonOffset = true;
        material.polygonOffsetFactor = 1;
        material.polygonOffsetUnits = 1;
    }

    /**
     * Apply the current global shading style (flat by default, smooth when
     * toggled on) to a material. Safe to call on any material type -
     * silently no-ops on materials that don't support flatShading (e.g.
     * line/basic materials used for overlays).
     */
    _applyShadingMode(material) {
        if (!material) return;
        const mats = Array.isArray(material) ? material : [material];
        mats.forEach((mat) => {
            if (mat && 'flatShading' in mat) {
                mat.flatShading = !this.smoothShading;
                mat.needsUpdate = true;
            }
        });
    }

    /**
     * Toggle between flat (raw polygon facets, default) and smooth
     * (interpolated-normal, rounded/bumpy) shading for every object
     * currently in the scene. New objects added afterwards automatically
     * pick up whichever mode is active (see addObject/_switchLodLevel).
     */
    setSmoothShading(enabled) {
        this.smoothShading = enabled;
        this.objects.forEach((obj) => {
            obj.traverse((child) => {
                if (child.isMesh && child.material) {
                    this._applyShadingMode(child.material);
                }
            });
        });
    }

    /**
     * Register a part with the scene graph and return its registry id. When no
     * explicit id is supplied a sequential obj_N key is assigned, which the UI
     * uses to track the part across save/load round-trips; every mesh beneath
     * it is then run through the optimizer and given the active shading style
     * so parts look consistent no matter where their material came from.
     * @param {THREE.Mesh|THREE.Group} object - The part to register (a single mesh or a group of meshes)
     * @param {string} [id] - Registry key; a sequential obj_N id is assigned when omitted
     * @returns {string} The registry id under which the part is stored
     */
    addObject(object, id = null) {
        if (!id) {
            this.objectIdCounter++;
            id = `obj_${this.objectIdCounter}`;
        }

        // Pin the part's name to its registry id so dispose() can look parts up by name, and enable shadows on every mesh beneath it.
        object.name = id;
        object.traverse((child) => {
            if (child.isMesh) {
                child.castShadow = true;
                child.receiveShadow = true;
                child.userData.objectId = id;
                // Apply WebGL optimizations to each mesh
                if (this.optimizer) {
                    this.optimizer.optimizeMesh(child);
                }
                // Apply the currently active shading style (flat by
                // default) so every object - regardless of where its
                // material was created (server load, primitive, paste,
                // transform-replace) - looks consistent without callers
                // needing to remember to set flatShading themselves.
                this._applyShadingMode(child.material);
                this._addMeshOverlays(child);
                // Apply the currently active view mode too, so a mesh created
                // while wireframe/transparent/wireframe-hybrid is on renders in
                // that style immediately instead of as plain opaque shading.
                // Must run after _addMeshOverlays so the hybrid overlay exists.
                this._applyViewModeToMesh(child);
            }
        });

        this.objects.set(id, object);
        this.scene.add(object);

        return id;
    }

    /**
     * Set the WebGL optimizer instance.
     */
    setOptimizer(optimizer) {
        this.optimizer = optimizer;
    }

    /**
     * Unregister and destroy a part. The whole subtree is disposed - geometry
     * and materials of every descendant, not just top-level meshes - so GPU
     * buffers are actually released and the outline/wireframe overlay
     * LineSegments go with them; the id's selection entry is dropped too so no
     * stale reference keeps a dead part alive.
     */
    removeObject(id) {
        const obj = this.objects.get(id);
        if (obj) {
            this.scene.remove(obj);
            // Dispose geometries and materials to free GPU memory. This
            // covers every descendant (not just isMesh children) so the
            // outline/wireframe overlay LineSegments are cleaned up too.
            obj.traverse((child) => {
                if (child.geometry) child.geometry.dispose();
                if (child.material) {
                    if (Array.isArray(child.material)) {
                        child.material.forEach(m => m.dispose());
                    } else {
                        child.material.dispose();
                    }
                }
            });
            this.objects.delete(id);
            this.selectedObjects.delete(id);

            if (this.selectedObject === id) {
                this.selectedObject = this.selectedObjects.size > 0 ? [...this.selectedObjects].pop() : null;
            }
        }
    }

    /**
     * Make this part the sole selection, replacing whatever was selected
     * before - mirroring how a plain click in the viewport replaces the current
     * pick (shift-click uses addToSelection instead). Previously selected parts
     * have their highlight reset as they are dropped.
     */
    selectObject(id) {
        this.selectedObjects.forEach(sid => {
            if (this.objects.has(sid)) {
                this._setSelectionColor(sid, null);
            }
        });
        this.selectedObjects.clear();
        this.selectedObject = id;

        if (id && this.objects.has(id)) {
            this.selectedObjects.add(id);
            this._setSelectionColor(id, SELECTION_COLOR);
        }
    }

    /**
     * Flip one part's membership in the multi-selection set - the shift-click
     * path: already-selected parts are dropped, unselected ones join. The
     * affected part's highlight is refreshed immediately so the viewport
     * reflects the change without waiting for the next frame.
     */
    toggleObjectSelection(id) {
        if (!id || !this.objects.has(id)) return;

        if (this.selectedObjects.has(id)) {
            this.selectedObjects.delete(id);
            this._setSelectionColor(id, null);
            if (this.selectedObject === id) {
                this.selectedObject = this.selectedObjects.size > 0 ? [...this.selectedObjects].pop() : null;
            }
        } else {
            this.selectedObjects.add(id);
            this._setSelectionColor(id, SELECTION_COLOR);
            if (!this.selectedObject) {
                this.selectedObject = id;
            }
        }
    }

    /**
     * Grow the multi-selection set with one more id, leaving existing members
     * untouched - again the shift-click path, as opposed to selectObject which
     * replaces the whole set. With an empty selection this degrades to a plain
     * single-select; adding an already-selected part is a no-op.
     */
    addToSelection(id) {
        if (!id || !this.objects.has(id)) return;

        if (this.selectedObjects.size === 0) {
            this.selectObject(id);
            return;
        }

        this.selectedObjects.add(id);
        this._setSelectionColor(id, SELECTION_COLOR);
    }

    /**
     * Empty the selection set and restore every part's material to its
     * pre-selection emissive state - triggered by Escape or a click on empty
     * space in the viewport.
     */
    deselectAll() {
        this.selectedObjects.forEach(sid => {
            if (this.objects.has(sid)) {
                this._setSelectionColor(sid, null);
            }
        });
        this.selectedObjects.clear();
        this.selectedObject = null;
    }

    /**
     * Return the ids of all currently selected parts as a plain array in
     * insertion order; the toolbar and inspector consume this to decide which
     * group actions are enabled.
     */
    getSelectedObjectIds() {
        return [...this.selectedObjects];
    }

    /**
     * Number of parts in the current selection; the status bar shows this next
     * to batch operations so their scope is visible at a glance.
     */
    getSelectionCount() {
        return this.selectedObjects.size;
    }

    _setSelectionColor(id, color) {
        const obj = this.objects.get(id);
        if (!obj) return;

        obj.traverse((child) => {
            if (child.isMesh && child.material) {
                if (color) {
                    if (!child.userData._origEmissive) {
                        child.userData._origEmissive = child.material.emissive ? child.material.emissive.getHex() : 0;
                        child.userData._origEmissiveIntensity = child.material.emissiveIntensity || 0;
                    }
                    child.material.emissive = new THREE.Color(color);
                    child.material.emissiveIntensity = 0.3;
                } else {
                    if (child.userData._origEmissive !== undefined) {
                        child.material.emissive = new THREE.Color(child.userData._origEmissive);
                        child.material.emissiveIntensity = child.userData._origEmissiveIntensity;
                    }
                }
            }
        });
    }

    /**
     * Switch every part between the normal / wireframe / transparent shading
     * styles. Each material's needsUpdate flag is set so the change takes
     * effect on the very next frame instead of waiting for a shader recompile.
     */
    setViewMode(mode) {
        this.viewMode = mode;

        this.objects.forEach((obj) => {
            obj.traverse((child) => {
                if (child.isMesh && child.material) {
                    this._applyViewModeToMesh(child);
                }
            });
        });
    }

    /**
     * Apply the currently active view mode (normal / wireframe / transparent /
     * wireframe-hybrid) to a single mesh's material and overlay. Factored out of
     * setViewMode so meshes created after the fact - fresh imports, pasted
     * copies, LOD level swaps - pick up whichever style is already active instead
     * of defaulting to plain opaque shading (the reason an object imported while
     * in wireframe mode rendered as a solid until the next view-mode toggle).
     */
    _applyViewModeToMesh(child) {
        if (!child || !child.material) return;
        switch (this.viewMode) {
            case 'wireframe':
                child.material.wireframe = true;
                child.material.transparent = false;
                child.material.opacity = 1.0;
                break;
            case 'transparent':
                child.material.wireframe = false;
                child.material.transparent = true;
                child.material.opacity = 0.5;
                break;
            case 'wireframe-hybrid':
                // Solid surface stays fully opaque and visible; a separate black
                // wireframe overlay (toggled below) is drawn on top of it.
                child.material.wireframe = false;
                child.material.transparent = false;
                child.material.opacity = 1.0;
                break;
            default: // 'normal' - plain opaque shading (ColliBoy)
                child.material.wireframe = false;
                child.material.transparent = false;
                child.material.opacity = 1.0;
                break;
        }

        // Three.js only recompiles a material's shader/blending setup when
        // needsUpdate is set - toggling `transparent` in place (as above)
        // silently has no visual effect without this, which is why Transparent
        // mode looked like it did nothing.
        child.material.needsUpdate = true;

        // Show the full black wireframe overlay only in wireframe-hybrid mode;
        // keep it hidden otherwise.
        if (child.userData._wireframeOverlay) {
            child.userData._wireframeOverlay.visible = (this.viewMode === 'wireframe-hybrid');
        }
    }

    /**
     * Store LOD (Level of Detail) data for an object.
     */
    setLodLevels(objectId, lodLevels) {
        this.lodLevelsPerObject.set(objectId, lodLevels);
        if (!this.currentLodIndex.has(objectId)) {
            this.currentLodIndex.set(objectId, 0);
        }
    }

    /**
     * Update LOD for all objects based on camera distance.
     */
    updateLod() {
        if (!this.lodEnabled) return;

        const camPos = this.camera.position;

        this.objects.forEach((obj, objectId) => {
            const lodLevels = this.lodLevelsPerObject.get(objectId);
            if (!lodLevels || lodLevels.length <= 1) return;

            // Calculate distance from camera to object center
            const box = new THREE.Box3().setFromObject(obj);
            const center = box.getCenter(new THREE.Vector3());
            const dist = camPos.distanceTo(center);

            // Determine appropriate LOD level based on distance
            let targetLevel = 0;
            for (let i = this._lodDistances.length - 1; i >= 0; i--) {
                if (dist > this._lodDistances[i]) {
                    targetLevel = i;
                    break;
                }
            }
            // Clamp to available levels
            targetLevel = Math.min(targetLevel, lodLevels.length - 1);

            const currentLevel = this.currentLodIndex.get(objectId) || 0;
            if (targetLevel !== currentLevel) {
                this._switchLodLevel(objectId, targetLevel);
            }
        });
    }

    /**
     * Switch an object to a specific LOD level.
     */
    _switchLodLevel(objectId, level) {
        const lodLevels = this.lodLevelsPerObject.get(objectId);
        if (!lodLevels || !lodLevels[level]) return;

        const obj = this.objects.get(objectId);
        if (!obj) return;

        // Remove all child meshes from current object, disposing every
        // descendant (including outline/wireframe overlay LineSegments) so
        // nothing leaks on the GPU.
        while (obj.children.length > 0) {
            const child = obj.children[0];
            obj.remove(child);
            child.traverse((sub) => {
                if (sub.geometry) sub.geometry.dispose();
                if (sub.material) {
                    if (Array.isArray(sub.material)) {
                        sub.material.forEach(m => m.dispose());
                    } else {
                        sub.material.dispose();
                    }
                }
            });
        }

        // Create mesh from LOD level data
        const lodData = lodLevels[level];
        
        // Use optimizer for geometry creation
        let geometry;
        if (this.optimizer) {
            geometry = this.optimizer.getOrCreateGeometry(
                lodData.vertices,
                lodData.indices,
                null
            );
        } else {
            geometry = new THREE.BufferGeometry();
            const vertices = new Float32Array(lodData.vertices);
            geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));

            if (lodData.indices && lodData.indices.length > 0) {
                const indices = new Uint16Array(lodData.indices);
                geometry.setIndex(new THREE.BufferAttribute(indices, 1));
            }
        }

        // Add vertex colors if present
        if (lodData.vertex_colors && lodData.vertex_colors.length > 0) {
            const colorArray = new Float32Array(lodData.vertex_colors);
            geometry.setAttribute('color', new THREE.Float32BufferAttribute(colorArray, 3));
        }

        // Use optimizer for material caching to avoid duplicate allocations
        let material;
        if (this.optimizer) {
            const hasVertexColors = lodData.vertex_colors && lodData.vertex_colors.length > 0;
            material = this.optimizer.getMaterial({
                vertexColors: hasVertexColors,
                color: 0x8899aa,
                shininess: 15,
            });
        } else {
            if (lodData.vertex_colors && lodData.vertex_colors.length > 0) {
                material = new THREE.MeshPhongMaterial({
                    vertexColors: true,
                    shininess: 15,
                });
            } else {
                material = new THREE.MeshPhongMaterial({
                    color: 0x8899aa,
                    shininess: 15,
                });
            }
        }

        // LOD meshes are added directly to the existing object group
        // (not via addObject), so the active shading style and view mode both
        // have to be applied here explicitly, or switching LOD levels would
        // silently revert a flat-shaded / wireframed model back to smooth solid.
        this._applyShadingMode(material);

        const mesh = new THREE.Mesh(geometry, material);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.userData.objectId = objectId;
        this._addMeshOverlays(mesh);
        // Must run after _addMeshOverlays so the hybrid overlay exists.
        this._applyViewModeToMesh(mesh);
        obj.add(mesh);

        this.currentLodIndex.set(objectId, level);
    }

    /**
     * Toggle LOD system on/off.
     */
    toggleLod(enabled) {
        this.lodEnabled = enabled;
        if (!enabled) {
            // Reset all objects to LOD 0 (highest detail)
            this.objects.forEach((obj, objectId) => {
                const lodLevels = this.lodLevelsPerObject.get(objectId);
                if (lodLevels && lodLevels[0]) {
                    this._switchLodLevel(objectId, 0);
                }
            });
        }
    }

    /**
     * Report the axis-aligned bounds of one part, or of everything in the
     * scene when no id is given (the combined-box path unions per-object boxes
     * without reparenting anything - see _getCombinedBox), so this stays cheap
     * enough to run on demand from the toolbar. Returns null for an empty
     * scene or an unknown id.
     */
    getBoundingBox(id) {
        if (id) {
            const obj = this.objects.get(id);
            if (!obj) return null;
            return this._boxToInfo(new THREE.Box3().setFromObject(obj));
        }

        const box = this._getCombinedBox();
        if (!box) return null;
        return this._boxToInfo(box);
    }

    /**
     * Compute the union bounding box across all objects, without reparenting
     * them (Object3D.add() would move objects out of the live scene graph).
     */
    _getCombinedBox() {
        if (this.objects.size === 0) return null;

        const box = new THREE.Box3();
        let first = true;
        this.objects.forEach((obj) => {
            const objBox = new THREE.Box3().setFromObject(obj);
            if (!isFinite(objBox.min.x) || !isFinite(objBox.min.y) || !isFinite(objBox.min.z) ||
                !isFinite(objBox.max.x) || !isFinite(objBox.max.y) || !isFinite(objBox.max.z)) {
                return;
            }
            if (first) {
                box.copy(objBox);
                first = false;
            } else {
                box.union(objBox);
            }
        });
        return box;
    }

    _boxToInfo(box) {
        const size = box.getSize(new THREE.Vector3());
        const center = box.getCenter(new THREE.Vector3());

        return {
            minX: box.min.x, minY: box.min.y, minZ: box.min.z,
            maxX: box.max.x, maxY: box.max.y, maxZ: box.max.z,
            width: size.x, height: size.y, depth: size.z,
            centerX: center.x, centerY: center.y, centerZ: center.z,
        };
    }

    /**
     * Count triangles and vertices across one part or the whole scene by
     * walking each mesh's geometry; indexed meshes contribute index.count/3
     * faces, non-indexed ones fall back to position.count/3. The status bar
     * uses this to show how heavy a model is.
     */
    getMeshStats(id) {
        const targets = id ? [this.objects.get(id)] : [...this.objects.values()];
        if (id && !targets[0]) return { faces: 0, vertices: 0 };

        let faces = 0;
        let vertices = 0;

        targets.forEach((obj) => {
            if (!obj) return;
            obj.traverse((child) => {
                if (child.isMesh && child.geometry) {
                    const geo = child.geometry;
                    vertices += geo.attributes.position ? geo.attributes.position.count : 0;
                    faces += geo.index ? geo.index.count / 3 : (geo.attributes.position ? geo.attributes.position.count / 3 : 0);
                }
            });
        });

        return { faces: Math.round(faces), vertices };
    }

    /**
     * Reframe the viewport so the whole build sits centered in view: the
     * controls target moves to the combined bounding-box center and the camera
     * is pulled back along a fixed elevated 3/4 direction by a distance derived
     * from the box's largest dimension and the lens FOV. With an empty scene it
     * falls back to the default home position instead.
     */
    resetView() {
        const box = this.getBoundingBox();
        if (!box) {
            // No objects - reset to default. Must call controls.update()
            // here same as the populated-scene path below, or OrbitControls
            // never picks up the new camera/target and the viewport keeps
            // showing the old framing - this is what made "New Project"
            // (which empties the scene, always hitting this branch) look
            // like it wasn't resetting the view at all, even though the
            // reset-view button - usually clicked with objects still in
            // the scene - appeared to work fine.
            this.camera.position.set(3, 2, 3);
            this.controls.target.set(0, 0, 0);
            this.controls.update();
            return;
        }

        const center = new THREE.Vector3(box.centerX, box.centerY, box.centerZ);
        const maxDim = Math.max(box.width, box.height, box.depth);
        const fov = this.camera.fov * (Math.PI / 180);
        let distance = maxDim / (2 * Math.tan(fov / 2));
        distance *= 1.5; // leave headroom so parts sit comfortably inside the viewport rather than on its edges

        this.controls.target.copy(center);
        this.camera.position.set(
            center.x + distance * 0.6,
            center.y + distance * 0.4,
            center.z + distance * 0.7
        );
        this.controls.update();
    }

    /**
     * Determine whether a geometry is "hollow" in this app's sense: not a
     * closed/watertight surface, i.e. it has open boundary edges (holes)
     * that would make CSG operations (union/subtract/intersect) fail until
     * the model is repaired - the same failure mode the "Solid" button
     * fixes by calling the mesh-repair endpoint. This is only meant to be
     * run on freshly imported/opened models; primitives and CSG results
     * are assumed already-solid and should never be passed in.
     *
     * Method: weld coincident vertices, then count how many triangles use
     * each undirected edge. In a closed manifold surface every edge is
     * shared by exactly two triangles; any edge used by only one triangle
     * is a boundary edge - a hole in the surface. (An earlier version of
     * this check instead looked for a shell nested inside another shell,
     * which is a different and much rarer situation - a single shell with
     * a hole, like a thin eggshell missing a patch, has only one shell and
     * was always reported as "not hollow" even though it can't be merged
     * without repair first. Edge-sharing is the right test for that.)
     * Best-effort heuristic - on any failure this safely reports
     * "not hollow" rather than throwing.
     */
    detectHollow(geometry) {
        try {
            const posAttr = geometry.attributes.position;
            if (!posAttr) return false;

            const index = geometry.index
                ? geometry.index.array
                : Uint32Array.from({ length: posAttr.count }, (_, i) => i);
            const triCount = index.length / 3;
            if (triCount === 0) return false;

            // Weld vertices sharing (approximately) the same position so
            // edge-sharing is detected even when a mesh has duplicated
            // vertices per face (e.g. flat-shaded imports).
            const precision = 1e4; // ~0.0001 unit merge tolerance
            const keyToId = new Map();
            const vertOf = new Array(posAttr.count);

            for (let i = 0; i < posAttr.count; i++) {
                const key = `${Math.round(posAttr.getX(i) * precision)}_${Math.round(posAttr.getY(i) * precision)}_${Math.round(posAttr.getZ(i) * precision)}`;
                let id = keyToId.get(key);
                if (id === undefined) {
                    id = keyToId.size;
                    keyToId.set(key, id);
                }
                vertOf[i] = id;
            }

            // Count triangle usage per undirected edge (welded vertex ids).
            const edgeCount = new Map();
            const addEdge = (a, b) => {
                const key = a < b ? `${a}_${b}` : `${b}_${a}`;
                edgeCount.set(key, (edgeCount.get(key) || 0) + 1);
            };

            for (let t = 0; t < triCount; t++) {
                const a = vertOf[index[t * 3]];
                const b = vertOf[index[t * 3 + 1]];
                const c = vertOf[index[t * 3 + 2]];
                addEdge(a, b);
                addEdge(b, c);
                addEdge(c, a);
            }

            // Any edge shared by only one triangle is a boundary edge -
            // the surface has a hole there and isn't watertight.
            for (const count of edgeCount.values()) {
                if (count === 1) return true;
            }
            return false;
        } catch (err) {
            console.warn('Hollow detection failed:', err);
            return false;
        }
    }

    /**
     * Get raw mesh data (vertices + indices) from a scene object's geometry.
     * Returns null if the object has no valid geometry.
     */
    getObjectMesh(objectId) {
        const obj = this.objects.get(objectId);
        if (!obj) return null;

        let vertices = null;
        let indices = null;

        obj.traverse((child) => {
            if (child.isMesh && child.geometry) {
                const geo = child.geometry;
                const posAttr = geo.attributes.position;
                if (posAttr) {
                    vertices = posAttr.array; // Float32Array
                }
                if (geo.index) {
                    indices = geo.index.array; // Uint16Array or similar
                }
            }
        });

        if (!vertices) return null;

        return {
            vertices: Array.from(vertices),
            indices: indices ? Array.from(indices) : null,
        };
    }

    /**
     * Translate a screen-space click into the id of the part under it: client
     * coordinates are mapped to NDC, a ray is cast from the camera, and the
     * first mesh hit wins - its userData.objectId (stamped when the object was
     * added) identifies which registered part owns that mesh. Returns null when
     * the click lands on empty space or the build plate.
     */
    pickObject(clientX, clientY) {
        const rect = this.canvas.getBoundingClientRect();
        const mouse = new THREE.Vector2(
            ((clientX - rect.left) / rect.width) * 2 - 1,
            -((clientY - rect.top) / rect.height) * 2 + 1
        );

        const raycaster = new THREE.Raycaster();
        raycaster.setFromCamera(mouse, this.camera);

        const meshes = [];
        this.objects.forEach((obj) => {
            obj.traverse((child) => {
                if (child.isMesh) meshes.push(child);
            });
        });

        const intersects = raycaster.intersectObjects(meshes, false);
        if (intersects.length > 0) {
            return intersects[0].object.userData.objectId || null;
        }
        return null;
    }

    /**
     * Per-frame tick: re-schedules itself, lets OrbitControls finish any
     * inertia/damping, refreshes LOD assignments from the current camera
     * distance when LOD is enabled, then renders.
     */
    animate() {
        requestAnimationFrame(() => this.animate());
        this.controls.update();

        // Update LOD based on camera distance
        if (this.lodEnabled) {
            this.updateLod();
        }

        this.renderer.render(this.scene, this.camera);
    }

    start() {
        this.animate();
    }

    /**
     * Tear everything down when the viewport is destroyed: detach the resize
     * listener, remove and dispose every registered part (keyed by name - which
     * is why addObject pins each part's name to its registry id), release the
     * optimizer's cached resources, and finally dispose the renderer so no GPU
     * resource outlives this controller.
     */
    dispose() {
        window.removeEventListener('resize', this.onResize);
        this.objects.forEach((obj) => this.removeObject(obj.name));
        
        // Clean up optimizer resources
        if (this.optimizer) {
            this.optimizer.dispose();
            this.optimizer = null;
        }

        this.renderer.dispose();
    }
}
