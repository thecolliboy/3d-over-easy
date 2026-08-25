import * as THREE from 'three';

/**
 * ColliBoy - Snaps an object's position onto a configurable grid, so drags
 * land on clean whole-cell steps instead of arbitrary coordinates.
 */
export class GridSnapper {
    constructor(scene, options = {}) {
        this.scene = scene;
        this.snapSize = options.snapSize ?? 1.0; // default cell size in world units

        // Faint floor-grid overlay shown while snapping is active
        this.gridHelper = null;
        this._createGrid();

        // Marker sphere dropped on the cell where the current transform snaps to
        this.snapIndicator = null;
        this._createSnapIndicator();

        // Initial enabled state from .config via App; mirrors what a G-key toggle would do
        this.setEnabled(options.enabled ?? false);
    }

    /**
     * Build the faint two-tone floor grid used as a visual reference for snapping.
     */
    _createGrid() {
        const size = 100;
        const divisions = 100;
        this.gridHelper = new THREE.GridHelper(size, divisions, 0x444466, 0x2a2a3e);
        // Grid sits 1cm below the build plate so its lines never z-fight
        // against the plate surface at y = 0.
        this.gridHelper.position.y = -0.01;
        this.gridHelper.material.transparent = true;
        this.gridHelper.material.opacity = 0.3;
        this.gridHelper.visible = false;
        if (this.scene) {
            this.scene.add(this.gridHelper);
        }
    }

    /**
     * Build the marker sphere shown while grid snapping is on.
     */
    _createSnapIndicator() {
        const geometry = new THREE.SphereGeometry(0.15, 8, 6);
        const material = new THREE.MeshBasicMaterial({
            color: 0x44aaff,
            transparent: true,
            opacity: 0.6,
            depthWrite: false,
        });
        this.snapIndicator = new THREE.Mesh(geometry, material);
        this.snapIndicator.visible = false;
        if (this.scene) {
            this.scene.add(this.snapIndicator);
        }
    }

    /**
     * Turn grid snapping on or off, mirroring the state into the UI.
     */
    setEnabled(enabled) {
        this.enabled = enabled;
        if (this.gridHelper) {
            this.gridHelper.visible = enabled;
        }
        if (this.snapIndicator) {
            this.snapIndicator.visible = enabled;
        }
        // Toggle the matching toolbar control so the UI reflects the new state
        const gridSnapControls = document.getElementById('grid-snap-controls');
        if (gridSnapControls) {
            gridSnapControls.style.display = enabled ? 'flex' : 'none';
        }
    }

    /**
     * Flip the enabled flag and report the resulting state.
     */
    toggle() {
        this.setEnabled(!this.enabled);
        return this.enabled;
    }

    /**
     * Change the cell size; the floor grid is rebuilt to match it.
     */
    setSnapSize(size) {
        if (size <= 0) throw new Error('Snap size must be positive');
        this.snapSize = size;
        // Rebuild the helper so its line spacing tracks the new cell size
        if (this.gridHelper) {
            const parent = this.gridHelper.parent;
            parent?.remove(this.gridHelper);

            const gridSize = Math.max(10, this.snapSize * 20);
            const divisions = Math.round(gridSize / this.snapSize);
            this.gridHelper = new THREE.GridHelper(gridSize, divisions, 0x44aaff, 0x3355aa);
            this.gridHelper.position.y = -0.01;
            this.gridHelper.material.transparent = true;
            this.gridHelper.material.opacity = 0.4;
            // A fresh GridHelper defaults to visible, so mirror the enabled state explicitly
            this.gridHelper.visible = this.enabled;
            parent?.add(this.gridHelper);
        }
    }

    /**
     * Round a scalar onto the nearest grid line.
     */
    snap(value) {
        return Math.round(value / this.snapSize) * this.snapSize;
    }

    /**
     * Quantize every axis of an object's position to the grid; called while a
     * drag is in progress, so it must stay cheap.
     */
    snapPosition(object) {
        if (!this.enabled || !object.position) return;
        object.position.x = this.snap(object.position.x);
        object.position.y = this.snap(object.position.y);
        object.position.z = this.snap(object.position.z);

        // Move the marker onto the snapped position
        this._updateSnapIndicator(object);
    }

    /**
     * Park the marker on the snapped position and size it with the cell, so
     * the current snap target stays visible (ColliBoy).
     */
    _updateSnapIndicator(object) {
        if (!this.snapIndicator || !object.position) return;
        this.snapIndicator.position.copy(object.position);
        // Marker is sized to 30% of one grid cell so it reads as a footprint
        // of the current snap target without obscuring the object.
        const s = Math.max(0.1, this.snapSize * 0.3);
        this.snapIndicator.scale.set(s, s, s);
    }

}
