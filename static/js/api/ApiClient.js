/**
 * ColliBoy - fetch-based client for the Flask REST API, plus the shared
 * object-id presence check used to tell real backend ids apart.
 */

/**
 * Defined-and-non-empty check. The backend mints 0 as a valid object id,
 * which is falsy in JS - plain truthiness would treat the first-created
 * object as missing.
 */
export function hasId(value) {
    return value !== undefined && value !== null && value !== '';
}

/**
 * Fetch-based client for the Flask REST API.
 */
export class APIClient {
    constructor(baseURL = '/api') {
        this.baseURL = baseURL;
    }

    async get(endpoint) {
        const res = await fetch(`${this.baseURL}${endpoint}`);
        if (!res.ok) throw new Error(`API error: ${res.status}`);
        return res.json();
    }

    /**
     * Liveness probe behind the connection indicator. Any HTTP reply - error
     * statuses included - proves the server is reachable; only a network-level
     * failure (connection refused, timeout) means disconnected.
     */
    async checkHealth() {
        try {
            await fetch(`${this.baseURL}/health`, { method: 'GET', cache: 'no-store' });
            return true;
        } catch (err) {
            return false;
        }
    }

    async post(endpoint, data = null, files = null) {
        const opts = { method: 'POST' };
        if (files) {
            const formData = new FormData();
            for (const [key, value] of Object.entries(data || {})) {
                formData.append(key, value);
            }
            for (const file of files) {
                formData.append('file', file);
            }
            opts.body = formData;
        } else if (data) {
            opts.headers = { 'Content-Type': 'application/json' };
            opts.body = JSON.stringify(data);
        }
        const res = await fetch(`${this.baseURL}${endpoint}`, opts);
        if (!res.ok) {
            let errorText = `API error: ${res.status}`;
            try {
                const errData = await res.json();
                if (errData.error) {
                    errorText = errData.error;
                    if (errData.timeout) {
                        throw Object.assign(new Error(errorText), { timeout: true });
                    }
                }
            } catch {}
            throw new Error(errorText);
        }
        return res.json();
    }

    async uploadFile(file, extraData = {}) {
        const formData = new FormData();
        formData.append('file', file);
        for (const [key, value] of Object.entries(extraData)) {
            formData.append(key, value);
        }
        const res = await fetch(`${this.baseURL}/import`, { method: 'POST', body: formData });
        if (!res.ok) throw new Error(`Import failed: ${res.status}`);
        return res.json();
    }

    async exportModel(format, sessionId = null, objectId = null) {
        let url = `${this.baseURL}/export?format=${format}`;
        const params = [];
        if (sessionId) params.push(`session_id=${sessionId}`);
        if (objectId) params.push(`object_id=${objectId}`);
        if (params.length > 0) url += '&' + params.join('&');
        const res = await fetch(url);
        if (!res.ok) throw new Error(`Export failed: ${res.status}`);
        return res.blob();
    }

    async exportAll(format, sessionId) {
        let url = `${this.baseURL}/export/all?format=${format}&session_id=${sessionId}`;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`Export failed: ${res.status}`);
        return res.blob();
    }

    async exportPreset(preset, sessionId = null, objectId = null) {
        let url = `${this.baseURL}/export/preset?preset=${preset}`;
        const params = [];
        if (sessionId) params.push(`session_id=${sessionId}`);
        if (objectId) params.push(`object_id=${objectId}`);
        if (params.length > 0) url += '&' + params.join('&');
        const res = await fetch(url);
        if (!res.ok) throw new Error(`Export preset failed: ${res.status}`);
        return res.blob();
    }

    // Mesh geometry endpoints (each call takes session_id + object_id)
    async repairMesh(sessionId, objectId) {
        return this.post('/geometry/repair', { session_id: sessionId, object_id: objectId });
    }

    async rotateModel(sessionId, objectId, angle, axis = 'z') {
        return this.post('/geometry/rotate', { session_id: sessionId, object_id: objectId, angle, axis });
    }

    // Bakes a column-major 4x4 matrix (Matrix4.elements) into the backend's
    // vertex copy - this is how gizmo drags and value-bar edits get committed,
    // since those otherwise only move the client-side object.
    async transformModel(sessionId, objectId, matrixElements) {
        return this.post('/geometry/transform', { session_id: sessionId, object_id: objectId, matrix: matrixElements });
    }

    async simplifyMesh(sessionId, objectId, reductionPercent = 50) {
        return this.post('/geometry/simplify', { session_id: sessionId, object_id: objectId, reduction_percent: reductionPercent });
    }

    async previewSimplify(sessionId, objectId, reductionPercent = 50) {
        return this.post('/geometry/simplify-preview', { session_id: sessionId, object_id: objectId, reduction_percent: reductionPercent });
    }

    async smoothMesh(sessionId, objectId, iterations = 1) {
        return this.post('/geometry/smooth', { session_id: sessionId, object_id: objectId, iterations });
    }

    async filletMesh(sessionId, objectId, radius, segments = 3) {
        return this.post('/geometry/fillet', { session_id: sessionId, object_id: objectId, radius, segments });
    }

    async chamferMesh(sessionId, objectId, distance, segments = 1) {
        return this.post('/geometry/chamfer', { session_id: sessionId, object_id: objectId, distance, segments });
    }

    async computeLod(sessionId, objectId, numLevels = 3) {
        return this.post('/geometry/lod', { session_id: sessionId, object_id: objectId, num_levels: numLevels });
    }

    // Boolean (CSG) operations
    async unionObjects(sessionId, objectIds) {
        return this.post('/csg/union', { session_id: sessionId, object_ids: objectIds });
    }

    async subtractObjects(sessionId, targetIds, toolIds) {
        // Every tool is cut out of each target.
        return this.post('/csg/subtract', { session_id: sessionId, target_ids: targetIds, tool_ids: toolIds });
    }

    async intersectObjects(sessionId, objectIds) {
        return this.post('/csg/intersect', { session_id: sessionId, object_ids: objectIds });
    }

    // Primitives; passing a session_id persists the result into that live session
    async createPrimitive(sessionId, type, params = {}) {
        // The client keeps no session state, so callers pass the app's current
        // session id explicitly to place primitives in the right session.
        return this.post('/primitives/create', { session_id: sessionId, type, ...params });
    }

    // Prompt-based generation - 'create' builds a new shape from text;
    // 'edit' modifies an already-selected object.
    async getAiModels() {
        return this.get('/ai/models');
    }

    // Sweeps residual job scratch dirs from ai/input + ai/output (leftovers from
    // a generation whose server died mid-run). Called once when AI mode is first opened.
    async cleanupAi() {
        return this.post('/ai/cleanup');
    }

    // OpenAI-compatible API configs, stored as json files in ai/models by the backend.
    async saveAiProvider(data) {
        return this.post('/ai/provider', data);
    }

    async deleteAiProvider(file) {
        const res = await fetch(`${this.baseURL}/ai/provider/${encodeURIComponent(file)}`, { method: 'DELETE' });
        if (!res.ok) {
            let errorText = `API error: ${res.status}`;
            try {
                const errData = await res.json();
                if (errData.error) errorText = errData.error;
            } catch {}
            throw new Error(errorText);
        }
        return res.json();
    }

    async generateAi({ mode, prompt, model, provider, sessionId, objectId }) {
        return this.post('/ai/generate', {
            mode,
            prompt,
            model,
            provider: provider || null,
            session_id: sessionId,
            object_id: objectId || null,
        });
    }

    // Background-job polling: the generate call returns a job id immediately and
    // main.js polls this until the runner finishes, errors, or is cancelled.
    async getAiStatus(jobId) {
        return this.get(`/ai/status/${jobId}`);
    }

    async cancelAi(jobId) {
        return this.post(`/ai/cancel/${jobId}`);
    }

    // Expects a '/objects/duplicate' backend route that clones the object
    // server-side (same pattern as the CSG calls above) and returns the clone's
    // mesh data + id. That route must be added on the backend for pasted
    // objects to fully support repair/boolean/export.
    async duplicateObject(sessionId, objectId) {
        return this.post('/objects/duplicate', { session_id: sessionId, object_id: objectId });
    }

    // Undo and redo
    async undo(sessionId) {
        return this.post('/history/undo', { session_id: sessionId });
    }

    async redo(sessionId) {
        return this.post('/history/redo', { session_id: sessionId });
    }

}
