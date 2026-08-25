import * as THREE from 'three';

/**
 * ColliBoy - Rendering optimizations for large scenes with many objects.
 *
 * Material caching lets identical parameter sets share one instance, per-mesh
 * optimization pins culling flags on every mesh, and live stats track draws,
 * triangles, and an estimated GPU memory footprint surfaced in the status bar.
 */
export class WebGLOptimizer {
    constructor(sceneController) {
        this.sceneController = sceneController;

        // Parameter-keyed material cache so identical params share one instance
        this._materialCache = new Map();  // param signature -> cached material

        // Live counters surfaced in the status bar
        this._stats = {
            drawCalls: 0,
            triangles: 0,
            estimatedGpuMemoryBytes: 0,
        };

        // Culling is on by default; set explicitly so nothing downstream can leave it off
        this.sceneController.objects.forEach((obj) => {
            obj.frustumCulled = true;
        });
    }

    /**
     * Build a BufferGeometry from flat coordinate arrays; absent inputs are skipped.
     */
    getOrCreateGeometry(vertices, indices, normals) {
        const geometry = new THREE.BufferGeometry();

        if (vertices && vertices.length > 0) {
            const posArray = new Float32Array(vertices);
            geometry.setAttribute('position', new THREE.Float32BufferAttribute(posArray, 3));
        }

        if (indices && indices.length > 0) {
            const idxArray = new Uint16Array(indices);
            geometry.setIndex(new THREE.BufferAttribute(idxArray, 1));
        }

        if (normals && normals.length > 0) {
            const normArray = new Float32Array(normals);
            geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normArray, 3));
        }

        geometry.computeBoundingSphere();
        return geometry;
    }

    /**
     * Resolve a material for the given parameter set, reusing the cached instance when one exists.
     */
    getMaterial(params) {
        const key = this._materialKey(params);

        if (this._materialCache.has(key)) {
            return this._materialCache.get(key);
        }

        let material;
        if (params.vertexColors) {
            material = new THREE.MeshPhongMaterial({
                vertexColors: true,
                shininess: params.shininess || 15,
                flatShading: params.flatShading || false,
            });
        } else {
            material = new THREE.MeshStandardMaterial({
                color: params.color || 0x8899aa,
                roughness: params.roughness ?? 0.7,
                metalness: params.metalness ?? 0.1,
                wireframe: params.wireframe || false,
                transparent: params.transparent || false,
                opacity: params.opacity ?? 1.0,
                side: params.doubleSide ? THREE.DoubleSide : THREE.FrontSide,
            });
        }

        this._materialCache.set(key, material);
        return material;
    }

    /**
     * Collapse a material parameter set into a compact cache signature.
     */
    _materialKey(params) {
        const parts = [
            params.vertexColors ? 'vc' : 'sc',
            params.color?.toString(16) || '8899aa',
            params.wireframe ? 'wf' : 'sw',
            params.transparent ? 'tr' : 'ot',
            params.opacity ?? 1.0,
        ];
        return parts.join('|');
    }

    /**
     * Pull per-frame counters out of renderer.info and refresh the stored stats.
     */
    updateStats(renderer) {
        const info = renderer.info;

        this._stats.drawCalls = info.render.calls || 0;
        this._stats.triangles = info.render.triangles || 0;

        // Rough GPU-memory estimate: sum of attribute and index buffer sizes across meshes
        let estimatedBytes = 0;
        this.sceneController.objects.forEach((obj) => {
            obj.traverse((child) => {
                if (child.isMesh && child.geometry) {
                    const geo = child.geometry;
                    if (geo.attributes.position) {
                        estimatedBytes += geo.attributes.position.array.byteLength;
                    }
                    if (geo.attributes.normal) {
                        estimatedBytes += geo.attributes.normal.array.byteLength;
                    }
                    if (geo.index) {
                        estimatedBytes += geo.index.array.byteLength;
                    }
                }
            });
        });

        this._stats.estimatedGpuMemoryBytes = estimatedBytes;
    }

    /**
     * Format the stored counters into a single-line status-bar string.
     */
    getStatsString() {
        const memMB = (this._stats.estimatedGpuMemoryBytes / (1024 * 1024)).toFixed(1);
        return `Draws: ${this._stats.drawCalls} | Triangles: ${(this._stats.triangles / 1000).toFixed(1)}k | GPU: ${memMB}MB`;
    }

    /**
     * Pin a mesh's frustum-culling flag so culling stays on no matter what upstream set.
     */
    optimizeMesh(mesh) {
        if (!mesh || !mesh.isMesh) return;
        mesh.frustumCulled = true;
    }

    /**
     * Dispose every cached material so its GPU programs are freed; run before
     * tearing down a scene or on shutdown.
     */
    dispose() {
        this._materialCache.forEach((mat) => mat.dispose());
        this._materialCache.clear();
    }
}
