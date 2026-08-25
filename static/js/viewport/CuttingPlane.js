import * as THREE from 'three';

/**
 * ColliBoy - Visual representation of the cut tool's cutting plane. It owns
 * the surface mesh, axis presets, position/normal queries, and split-half
 * previews; pointer dragging itself is handled externally (main.js).
 */
export class CuttingPlane {
    constructor(scene) {
        this.scene = scene;
        // Y is the default axis - a horizontal slice matches how parts rest on the build plate
        this.axis = 'y';
        this.position = new THREE.Vector3(0, 0, 0);

        // The cut surface itself - kept translucent so geometry behind it stays readable
        const planeGeo = new THREE.PlaneGeometry(10, 10);
        const planeMat = new THREE.MeshBasicMaterial({
            color: 0xff6644,
            transparent: true,
            opacity: 0.25,
            side: THREE.DoubleSide,
            depthWrite: false,
        });
        this.planeMesh = new THREE.Mesh(planeGeo, planeMat);

        // Wireframe outline so the plane edge stays visible
        const edgesGeo = new THREE.EdgesGeometry(planeGeo);
        const edgesMat = new THREE.LineBasicMaterial({
            color: 0xff6644,
            linewidth: 1,
        });
        this.edgeLines = new THREE.LineSegments(edgesGeo, edgesMat);
        this.planeMesh.add(this.edgeLines);

        // Dashed crosshair guides mark which way the X and Z axes point on the face
        const axisMat = new THREE.LineDashedMaterial({
            color: 0xffffff,
            transparent: true,
            opacity: 0.4,
            dashSize: 0.1,
            gapSize: 0.05,
        });

        const xLineGeo = new THREE.BufferGeometry().setFromPoints([
            new THREE.Vector3(-5, 0, 0),
            new THREE.Vector3(5, 0, 0),
        ]);
        const zLineGeo = new THREE.BufferGeometry().setFromPoints([
            new THREE.Vector3(0, 0, -5),
            new THREE.Vector3(0, 0, 5),
        ]);

        this.xAxisLine = new THREE.Line(xLineGeo, axisMat);
        this.xAxisLine.computeLineDistances();
        this.planeMesh.add(this.xAxisLine);

        this.zAxisLine = new THREE.Line(zLineGeo, axisMat);
        this.zAxisLine.computeLineDistances();
        this.planeMesh.add(this.zAxisLine);

        // Small sphere at the center - drag affordance
        const handleGeo = new THREE.SphereGeometry(0.08, 16, 16);
        const handleMat = new THREE.MeshBasicMaterial({ color: 0xff6644 });
        this.handle = new THREE.Mesh(handleGeo, handleMat);
        this.planeMesh.add(this.handle);

        // Arrow marking the positive side of the normal
        const arrowHelper = new THREE.ArrowHelper(
            new THREE.Vector3(0, 1, 0),
            new THREE.Vector3(0, 0, 0),
            0.8,
            0x44ff44,
            0.2,
            0.1
        );
        this.normalArrow = arrowHelper;
        this.planeMesh.add(this.normalArrow);

        // Group holding the split-half previews while Split mode is active
        this.previewGroup = new THREE.Group();
        this.previewGroup.visible = false;
        this.scene.add(this.previewGroup);

        this.scene.add(this.planeMesh);
        this.setPosition(0, 0, 0);
        this.setVisible(false);
    }

    /**
     * Move the plane to (x, y, z), re-orienting it for the current axis.
     */
    setPosition(x, y, z) {
        this.position.set(x, y, z);
        this.planeMesh.position.copy(this.position);
        this._orientToAxis();
        this._updateNormalArrow();
    }

    // PlaneGeometry's local normal is +Z; these rotations map that canonical
    // normal onto the intended world-space direction for each preset axis,
    // which is what keeps getNormal() correct both at the presets and after
    // free rotation during Split mode.
    _orientToAxis() {
        switch (this.axis) {
            case 'x':
                this.planeMesh.rotation.set(0, Math.PI / 2, 0);
                break;
            case 'y':
                this.planeMesh.rotation.set(-Math.PI / 2, 0, 0);
                break;
            case 'z':
                this.planeMesh.rotation.set(0, 0, 0);
                break;
        }
    }

    _updateNormalArrow() {
        // The arrow rides as a child of planeMesh and inherits its rotation;
        // its local direction/position only need setting once.
        this.normalArrow.setDirection(new THREE.Vector3(0, 0, 1));
        this.normalArrow.position.set(0, 0, 0);
    }

    /**
     * Show or hide the plane surface (and its children).
     */
    setVisible(visible) {
        this.planeMesh.visible = visible;
    }

    /**
     * Set the cut axis to 'x', 'y', or 'z'; the plane surface and normal arrow are
     * re-oriented for the new preset.
     */
    setAxis(axis) {
        this.axis = axis;
        this._orientToAxis();
        this._updateNormalArrow();
    }

    /**
     * Rotate by `angleRad` around a fixed WORLD axis ('x'|'y'|'z'), composed
     * on top of `fromQuaternion` (defaults to the mesh's current orientation).
     * Do not write `planeMesh.rotation[axis]` directly - Euler components only
     * equal independent world-axis rotations while the other two are zero,
     * which breaks once the plane carries any existing rotation. Quaternion
     * pre-multiplication keeps "rotate about a world axis" well-defined at
     * any orientation.
     */
    rotateAroundWorldAxis(axis, angleRad, fromQuaternion = null) {
        const axisVec = new THREE.Vector3();
        axisVec[axis] = 1;
        const deltaQuat = new THREE.Quaternion().setFromAxisAngle(axisVec, angleRad);
        const base = fromQuaternion || this.planeMesh.quaternion;
        this.planeMesh.quaternion.multiplyQuaternions(deltaQuat, base);
        this._updateNormalArrow();
    }

    /**
     * World-space normal of the plane.
     */
    getNormal() {
        // Transform the canonical local +Z normal by the mesh's actual current
        // quaternion - valid for both axis presets and free Split-mode rotations.
        return new THREE.Vector3(0, 0, 1).applyQuaternion(this.planeMesh.quaternion).normalize();
    }

    /**
     * Render preview meshes for the two split halves.
     */
    showPreview(pieceA, pieceB) {
        this.hidePreview();

        // Colors are keyed by piece index (first half blue, second orange)
        // rather than identity against an already-added child mesh - `data`
        // is a raw server object and can never === a THREE.Mesh, so that test
        // was always false.
        if (pieceA) {
            const mesh = this._createPreviewMesh(pieceA, 0x44aaff);
            if (mesh) this.previewGroup.add(mesh);
        }

        if (pieceB) {
            const mesh = this._createPreviewMesh(pieceB, 0xff8844);
            if (mesh) this.previewGroup.add(mesh);
        }

        this.previewGroup.visible = true;
    }

    _createPreviewMesh(data, color) {
        if (!data || !data.vertices || !data.indices) return null;

        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.Float32BufferAttribute(data.vertices, 3));

        if (data.indices) {
            // Uint32 indices: cut/CSG results can exceed 65,536 vertices,
            // where a 16-bit index silently wraps and corrupts the preview;
            // mirrors the fix already applied to real (non-preview) loads.
            geometry.setIndex(new THREE.Uint32BufferAttribute(data.indices, 1));
        }

        // Recompute vertex normals so lighting works on the rebuilt geometry
        geometry.computeVertexNormals();

        const material = new THREE.MeshPhongMaterial({
            color,
            transparent: true,
            opacity: 0.6,
            side: THREE.DoubleSide,
        });

        const mesh = new THREE.Mesh(geometry, material);
        return mesh;
    }

    hidePreview() {
        // Dispose each preview mesh as it is removed so GPU buffers are freed (ColliBoy)
        while (this.previewGroup.children.length > 0) {
            const child = this.previewGroup.children[0];
            this.previewGroup.remove(child);
            if (child.geometry) child.geometry.dispose();
            if (child.material) child.material.dispose();
        }
        this.previewGroup.visible = false;
    }

    /**
     * Enlarge the plane until it spans twice the largest bounding-box extent,
     * keeping the cut surface readable around the object being split.
     */
    fitToBoundingBox(bboxMin, bboxMax) {
        if (!bboxMin || !bboxMax || !isFinite(bboxMin.x) || !isFinite(bboxMin.y) || !isFinite(bboxMin.z) ||
            !isFinite(bboxMax.x) || !isFinite(bboxMax.y) || !isFinite(bboxMax.z)) {
            return;
        }

        const size = Math.max(
            bboxMax.x - bboxMin.x,
            bboxMax.y - bboxMin.y,
            bboxMax.z - bboxMin.z
        ) * 2;

        // Rebuild the surface geometry at the new size, disposing the old buffers first so GPU memory is not leaked
        this.planeMesh.geometry.dispose();
        this.planeMesh.geometry = new THREE.PlaneGeometry(size, size);

        this.edgeLines.geometry.dispose();
        this.edgeLines.geometry = new THREE.EdgesGeometry(this.planeMesh.geometry);

        // Regenerate the dashed X/Z guides so they span the resized face
        this.xAxisLine.geometry.dispose();
        this.zAxisLine.geometry.dispose();
        this.xAxisLine.geometry = new THREE.BufferGeometry().setFromPoints([
            new THREE.Vector3(-size / 2, 0, 0),
            new THREE.Vector3(size / 2, 0, 0),
        ]);
        this.xAxisLine.computeLineDistances();
        this.zAxisLine.geometry = new THREE.BufferGeometry().setFromPoints([
            new THREE.Vector3(0, 0, -size / 2),
            new THREE.Vector3(0, 0, size / 2),
        ]);
        this.zAxisLine.computeLineDistances();
    }

    dispose() {
        this.hidePreview();
        this.setVisible(false);
        this.scene.remove(this.planeMesh);
        this.scene.remove(this.previewGroup);
        this.planeMesh.geometry.dispose();
        this.planeMesh.material.dispose();
        this.edgeLines.geometry.dispose();
        this.edgeLines.material.dispose();
        // the X/Z guides share one LineDashedMaterial instance - dispose it once
        this.xAxisLine.geometry.dispose();
        this.zAxisLine.geometry.dispose();
        this.xAxisLine.material.dispose();
        this.normalArrow.line.geometry.dispose();
        this.normalArrow.line.material.dispose();
        this.normalArrow.cone.geometry.dispose();
        this.normalArrow.cone.material.dispose();
        this.handle.geometry.dispose();
        this.handle.material.dispose();
    }
}
