/**
 * ColliBoy - Reusable modal dialog system for tool parameters; replaces
 * browser prompt()/confirm() calls with styled overlay dialogs.
 */

const Modal = (() => {
    function create(title, bodyHTML, buttons) {
        return new Promise((resolve) => {
            const overlay = document.createElement('div');
            overlay.className = 'modal-overlay';

            const dialog = document.createElement('div');
            dialog.className = 'modal-dialog';

            // Header row - title plus close button; closing resolves null
            const header = document.createElement('div');
            header.className = 'modal-header';

            const titleEl = document.createElement('span');
            titleEl.className = 'modal-title';
            titleEl.textContent = title;

            const closeBtn = document.createElement('button');
            closeBtn.className = 'modal-close';
            closeBtn.innerHTML = '&times;';
            closeBtn.addEventListener('click', () => {
                overlay.remove();
                resolve(null);
            });

            header.appendChild(titleEl);
            header.appendChild(closeBtn);

            // Body content - caller-supplied HTML, injected as-is
            const body = document.createElement('div');
            body.className = 'modal-body';
            body.innerHTML = bodyHTML;

            // Footer buttons built from the options array
            const footer = document.createElement('div');
            footer.className = 'modal-footer';

            for (const btn of buttons) {
                const el = document.createElement('button');
                el.className = btn.class === 'primary' ? 'btn-primary' : 'btn-secondary';
                el.textContent = btn.label;
                footer.appendChild(el);

                el.addEventListener('click', (e) => {
                    e.stopPropagation();
                    if (btn.action) {
                        const result = btn.action();
                        overlay.remove();
                        resolve(result);
                    } else {
                        overlay.remove();
                        resolve(null);
                    }
                });
            }

            dialog.appendChild(header);
            dialog.appendChild(body);
            dialog.appendChild(footer);
            overlay.appendChild(dialog);

            // Backdrop clicks dismiss without resolving a value
            overlay.addEventListener('click', (e) => {
                if (e.target === overlay) {
                    overlay.remove();
                    resolve(null);
                }
            });

            document.body.appendChild(overlay);

            // Move focus to the first field once the overlay is painted
            const firstInput = body.querySelector('input, select');
            if (firstInput) setTimeout(() => firstInput.focus(), 50);
        });
    }

    return { create };
})();


/**
 * Derive a default wall thickness for Hollow: 5% of the longest bounding-box
 * side, falling back to 2.0mm when dimensions are unavailable.
 */
function _defaultHollowThickness(dims) {
    if (!dims) return 2.0;
    const maxDim = Math.max(dims.width, dims.height, dims.depth);
    if (!isFinite(maxDim) || maxDim <= 0) return 2.0;
    const amount = maxDim * 0.05;
    const decimals = amount < 1 ? 3 : (amount < 10 ? 2 : 1);
    return Math.max(0.1, parseFloat(amount.toFixed(decimals)));
}

/**
 * Hollow tool modal: controls for wall thickness and opening size.
 *
 * @param {{width:number, height:number, depth:number}|null} dims
 *   Bounding box of the selected object; drives the smart default (5% of
 *   longest side) and the slider range.
 */
async function showHollowModal(dims = null) {
    const defaultThickness = _defaultHollowThickness(dims);
    const maxDim = dims ? Math.max(dims.width, dims.height, dims.depth) : null;
    // Slider stays usable at the object's real scale; the number input
    // accepts anything - the backend clamps oversized values.
    const thicknessSliderMax = maxDim ? Math.max(maxDim * 0.49, defaultThickness * 2) : 10;
    const thicknessSliderMaxDisplay = thicknessSliderMax.toFixed(thicknessSliderMax < 10 ? 2 : 1);
    const thicknessStep = Math.max(0.01, parseFloat((defaultThickness / 10).toFixed(3)));

    const bodyHTML = `
        <div class="form-group">
            <label class="form-label">Wall Thickness (mm)</label>
            <div class="form-row" style="align-items:center;gap:8px;">
                <input type="number" id="modal-wall-thickness-input" class="form-input" style="width:90px;flex:0 0 auto;" value="${defaultThickness}" step="${thicknessStep}" min="0.1">
                <input type="range" id="modal-wall-thickness" class="form-range" style="flex:1;" min="0.1" max="${thicknessSliderMax}" step="${thicknessStep}" value="${defaultThickness}">
            </div>
            <div style="display:flex;justify-content:space-between;margin-top:4px;">
                <span style="font-size:11px;color:var(--text-muted)">0.1mm</span>
                <span style="font-size:11px;color:var(--text-muted)">Default: 5% of longest dimension</span>
                <span style="font-size:11px;color:var(--text-muted)">${thicknessSliderMaxDisplay}mm</span>
            </div>
        </div>
        <div class="form-group">
            <label class="form-label">Opening Size (mm)</label>
            <div class="form-row" style="align-items:center;gap:8px;">
                <input type="number" id="modal-opening-size-input" class="form-input" style="width:90px;flex:0 0 auto;" value="10" step="1" min="5" max="50">
                <input type="range" id="modal-opening-size" class="form-range" style="flex:1;" min="5" max="50" step="1" value="10">
            </div>
            <div style="display:flex;justify-content:space-between;margin-top:4px;">
                <span style="font-size:11px;color:var(--text-muted)">5mm</span>
                <span style="font-size:11px;color:var(--text-muted)">50mm</span>
            </div>
        </div>
    `;

    // create() mounts the overlay synchronously and hands back a promise
    const promise = Modal.create('Hollow Model', bodyHTML, [
        { label: 'Cancel', class: 'secondary' },
        {
            label: 'Apply',
            class: 'primary',
            action: () => ({
                wallThickness: parseFloat(document.getElementById('modal-wall-thickness-input').value),
                openingSize: parseInt(document.getElementById('modal-opening-size-input').value),
            })
        }
    ]);

    // Pair each number input with its slider (overlay is already in the DOM)
    const thicknessInput = document.getElementById('modal-wall-thickness-input');
    const thicknessSlider = document.getElementById('modal-wall-thickness');
    if (thicknessInput && thicknessSlider) {
        _linkInputAndSlider(thicknessInput, thicknessSlider, { min: 0.1, decimals: 3 });
    }

    const openingInput = document.getElementById('modal-opening-size-input');
    const openingSlider = document.getElementById('modal-opening-size');
    if (openingInput && openingSlider) {
        _linkInputAndSlider(openingInput, openingSlider, { min: 5, decimals: 0 });
    }

    return await promise;
}


/**
 * Simplify Tool Modal - reduction-percentage slider plus a live face-count estimate.
 */
async function showSimplifyModal(currentFaces, onPreviewChange) {
    const originalFaces = currentFaces || 0;
    let estimatedFaces = originalFaces > 0 ? Math.round(originalFaces * (1 - 0.5)) : 0;

    const bodyHTML = `
        <div class="form-group">
            <label class="form-label">Polygon Reduction</label>
            <input type="range" id="modal-simplify-percent" class="form-range" min="10" max="90" step="5" value="50">
            <div style="display:flex;justify-content:space-between;margin-top:4px;">
                <span style="font-size:11px;color:var(--text-muted)">10%</span>
                <span id="modal-simplify-value" style="font-size:13px;font-weight:600;color:var(--accent)">50%</span>
                <span style="font-size:11px;color:var(--text-muted)">90%</span>
            </div>
        </div>
        <div class="form-group">
            <label class="form-label">Quality Preset</label>
            <select id="modal-simplify-quality" class="form-select">
                <option value="high">High - Preserve detail</option>
                <option value="medium" selected>Medium - Balanced</option>
                <option value="low">Low - Maximum reduction</option>
            </select>
        </div>
        ${originalFaces > 0 ? `
        <div style="border-top:1px solid var(--border-color);padding-top:12px;margin-top:8px;">
            <p style="font-size:11px;color:var(--text-secondary);margin-bottom:6px;text-transform:uppercase;letter-spacing:0.3px;">Estimated Polygon Count:</p>
            <div class="simplify-preview-row">
                <span class="simplify-original">${originalFaces.toLocaleString()} faces</span>
                <span style="color:var(--text-muted)">→</span>
                <span id="modal-simplify-estimated" class="simplify-estimated">${estimatedFaces.toLocaleString()} faces</span>
            </div>
        </div>` : ''}
    `;

    const promise = Modal.create('Simplify Mesh', bodyHTML, [
        { label: 'Cancel', class: 'secondary' },
        {
            label: 'Apply',
            class: 'primary',
            action: () => ({
                reductionPercent: parseInt(document.getElementById('modal-simplify-percent').value),
                quality: document.getElementById('modal-simplify-quality').value,
            })
        }
    ]);

    const slider = document.getElementById('modal-simplify-percent');
    if (slider) {
        slider.addEventListener('input', () => {
            const val = document.getElementById('modal-simplify-value');
            if (val) val.textContent = `${slider.value}%`;

            const reduction = parseInt(slider.value);
            if (originalFaces > 0 && !onPreviewChange) {
                const est = Math.round(originalFaces * (1 - reduction / 100));
                const estEl = document.getElementById('modal-simplify-estimated');
                if (estEl) estEl.textContent = `${est.toLocaleString()} faces`;
            }

            if (onPreviewChange) {
                onPreviewChange(parseInt(slider.value));
            }
        });
    }

    return await promise;
}


/**
 * Smooth Tool Modal - smoothing pass count.
 */
async function showSmoothModal() {
    const bodyHTML = `
        <div class="form-group">
            <label class="form-label">Smoothing Iterations</label>
            <input type="range" id="modal-smooth-iterations" class="form-range" min="1" max="20" step="1" value="3">
            <div style="display:flex;justify-content:space-between;margin-top:4px;">
                <span style="font-size:11px;color:var(--text-muted)">1</span>
                <span id="modal-smooth-value" style="font-size:13px;font-weight:600;color:var(--accent)">3</span>
                <span style="font-size:11px;color:var(--text-muted)">20</span>
            </div>
        </div>
        <p style="font-size:11px;color:var(--text-secondary);margin-top:8px;">More iterations produce smoother results but may distort sharp features.</p>
    `;

    const promise = Modal.create('Smooth Mesh', bodyHTML, [
        { label: 'Cancel', class: 'secondary' },
        {
            label: 'Apply',
            class: 'primary',
            action: () => ({
                iterations: parseInt(document.getElementById('modal-smooth-iterations').value),
            })
        }
    ]);

    const slider = document.getElementById('modal-smooth-iterations');
    if (slider) {
        slider.addEventListener('input', () => {
            const val = document.getElementById('modal-smooth-value');
            if (val) val.textContent = slider.value;
        });
    }

    return await promise;
}


/**
 * Export Format Modal - preset chips, or a raw format selection.
 */
async function showExportModal() {
    return _showFormatModal('Export Model', 'Download');
}


// One-line description for each save format; shown on its card in the Save dialog.
const FORMAT_INFO = {
    stl: 'The 3D-printing standard - every slicer and print service accepts it. Stores geometry only, so colors and metadata are not included.',
    obj: 'Plain-text and easy to inspect or edit in other tools. Keeps smooth-shading normals but no color data, and files tend to run larger than STL or PLY.',
    ply: 'Keeps per-vertex colors and normals in a compact binary file. Slicers support it less widely than STL.',
    '3mf': 'Print-ready archive that keeps colors, materials, and every object of the scene in one file - accepted by most slicers.'
};


/**
 * Save dialog - one selectable card per format; always saves the entire
 * scene in a single file, never just the selected shape.
 */
async function showSaveModal() {
    const cardsHTML = Object.keys(FORMAT_INFO).map((fmt, i) => `
        <div class="save-format-card${i === 0 ? ' active' : ''}" data-format="${fmt}">
            <span class="save-format-name">${fmt.toUpperCase()}</span>
            <span class="save-format-desc">${FORMAT_INFO[fmt]}</span>
        </div>`).join('');

    const bodyHTML = `
        <p style="font-size:12px;color:var(--text-secondary);margin-bottom:10px;">Choose a format:</p>
        <div class="save-formats">
            ${cardsHTML}
        </div>
    `;

    const promise = Modal.create('Save', bodyHTML, [
        { label: 'Cancel', class: 'secondary' },
        {
            label: 'Save',
            class: 'primary',
            action: () => ({
                preset: null,
                format: document.querySelector('.save-format-card.active')?.dataset.format || 'stl'
            })
        }
    ]);

    // Card clicks move the active marker within the group (radio behavior)
    document.querySelectorAll('.save-format-card').forEach(card => {
        card.addEventListener('click', () => {
            document.querySelectorAll('.save-format-card').forEach(c => c.classList.remove('active'));
            card.classList.add('active');
        });
    });

    return await promise;
}


async function _showFormatModal(title, actionLabel, showPresets = true) {
    const presetsHTML = showPresets ? `
        <p style="font-size:12px;color:var(--text-secondary);margin-bottom:10px;">Quick presets:</p>
        <div class="export-presets">
            <div class="preset-chip active" data-preset="print-ready" title="Repair mesh and export as binary STL - optimized for 3D printing">
                <span class="preset-icon">&#9731;</span> Print-Ready STL
            </div>
            <div class="preset-chip" data-preset="3mf" title="Preserves colors, metadata, and multiple objects">
                <span class="preset-icon">&#9670;</span> 3MF
            </div>
            <div class="preset-chip" data-preset="obj-texture" title="OBJ with generated UV texture coordinates">
                <span class="preset-icon">&#9671;</span> OBJ (Textured)
            </div>
        </div>
        <p style="font-size:12px;color:var(--text-secondary);margin:14px 0 10px;">Or choose format:</p>` : '';

    const bodyHTML = `
        ${presetsHTML}
        <div class="export-formats">
            <div class="format-chip active" data-format="stl">STL</div>
            <div class="format-chip" data-format="obj">OBJ</div>
            <div class="format-chip" data-format="ply">PLY</div>
            <div class="format-chip" data-format="3mf">3MF</div>
        </div>
    `;

    const promise = Modal.create(title, bodyHTML, [
        { label: 'Cancel', class: 'secondary' },
        {
            label: actionLabel,
            class: 'primary',
            action: () => ({
                preset: document.querySelector('.preset-chip.active')?.dataset.preset || null,
                format: document.querySelector('.format-chip.active')?.dataset.format || 'stl'
            })
        }
    ]);

    // Preset chip clicks move the active marker within the preset group
    document.querySelectorAll('.preset-chip').forEach(chip => {
        chip.addEventListener('click', () => {
            document.querySelectorAll('.preset-chip').forEach(c => c.classList.remove('active'));
            chip.classList.add('active');
        });
    });

    // Format chip clicks move the active marker within the format group
    document.querySelectorAll('.format-chip').forEach(chip => {
        chip.addEventListener('click', () => {
            document.querySelectorAll('.format-chip').forEach(c => c.classList.remove('active'));
            chip.classList.add('active');
        });
    });

    return await promise;
}


/**
 * Primitives Modal - type picker with parameter fields that follow the selection.
 */
async function showPrimitiveModal(preselectedType = null) {
    const bodyHTML = `
        <div class="form-group">
            <label class="form-label">Primitive Type</label>
            <select id="modal-primitive-type" class="form-select">
                <option value="cube">Cube</option>
                <option value="sphere">Sphere</option>
                <option value="cylinder">Cylinder</option>
                <option value="cone">Cone</option>
                <option value="torus">Torus</option>
                <option value="egg">Egg</option>
            </select>
        </div>
        <div id="modal-primitive-params"></div>
    `;

    const promise = Modal.create('Add Primitive', bodyHTML, [
        { label: 'Cancel', class: 'secondary' },
        {
            label: 'Create',
            class: 'primary',
            action: () => {
                const type = document.getElementById('modal-primitive-type').value;
                const params = { type };

                if (type === 'cube') {
                    params.size = parseFloat(document.getElementById('prim-size')?.value) || 50;
                } else if (type === 'sphere') {
                    params.radius = parseFloat(document.getElementById('prim-radius')?.value) || 25;
                    params.segments = parseInt(document.getElementById('prim-segments')?.value) || 16;
                } else if (type === 'cylinder') {
                    params.radius = parseFloat(document.getElementById('prim-radius')?.value) || 25;
                    params.height = parseFloat(document.getElementById('prim-height')?.value) || 50;
                    params.segments = parseInt(document.getElementById('prim-segments')?.value) || 24;
                } else if (type === 'cone') {
                    params.radius = parseFloat(document.getElementById('prim-radius')?.value) || 25;
                    params.height = parseFloat(document.getElementById('prim-height')?.value) || 50;
                    params.segments = parseInt(document.getElementById('prim-segments')?.value) || 24;
                } else if (type === 'torus') {
                    params.radius = parseFloat(document.getElementById('prim-radius')?.value) || 25;
                    params.tube = parseFloat(document.getElementById('prim-tube')?.value) || 8;
                    params.segments = parseInt(document.getElementById('prim-segments')?.value) || 16;
                } else if (type === 'egg') {
                    params.radius = parseFloat(document.getElementById('prim-radius')?.value) || 25;
                    params.height = parseFloat(document.getElementById('prim-height')?.value) || 60;
                    params.segments = parseInt(document.getElementById('prim-segments')?.value) || 24;
                }

                return params;
            }
        }
    ]);

    // Parameter fields re-render to match the chosen type
    const typeSelect = document.getElementById('modal-primitive-type');
    const paramsDiv = document.getElementById('modal-primitive-params');

    function renderParams() {
        const type = typeSelect.value;
        let html = '';

        if (type === 'cube') {
            html = `
                <div class="form-group">
                    <label class="form-label">Size (mm)</label>
                    <input type="number" id="prim-size" class="form-input" value="50" min="1">
                </div>`;
        } else if (['sphere', 'cylinder', 'cone', 'egg'].includes(type)) {
            html = `
                <div class="form-row">
                    <div class="form-group">
                        <label class="form-label">Radius (mm)</label>
                        <input type="number" id="prim-radius" class="form-input" value="25" min="1">
                    </div>
                    ${type !== 'sphere' ? `
                    <div class="form-group">
                        <label class="form-label">Height (mm)</label>
                        <input type="number" id="prim-height" class="form-input" value="${type === 'egg' ? 60 : 50}" min="1">
                    </div>` : ''}
                </div>
                <div class="form-group">
                    <label class="form-label">Segments</label>
                    <input type="number" id="prim-segments" class="form-input" value="${type === 'sphere' ? 16 : 24}" min="3" max="64">
                </div>`;
        } else if (type === 'torus') {
            html = `
                <div class="form-row">
                    <div class="form-group">
                        <label class="form-label">Major Radius (mm)</label>
                        <input type="number" id="prim-radius" class="form-input" value="25" min="1">
                    </div>
                    <div class="form-group">
                        <label class="form-label">Tube Radius (mm)</label>
                        <input type="number" id="prim-tube" class="form-input" value="8" min="1">
                    </div>
                </div>
                <div class="form-group">
                    <label class="form-label">Segments</label>
                    <input type="number" id="prim-segments" class="form-input" value="16" min="3" max="64">
                </div>`;
        }

        paramsDiv.innerHTML = html;
    }

    // First render plus change handler - overlay is already in the DOM
    if (typeSelect && paramsDiv) {
        typeSelect.addEventListener('change', renderParams);
        if (preselectedType) {
            typeSelect.value = preselectedType;
        }
        renderParams();
    }

    return await promise;
}


/**
 * Derive a default fillet/chamfer amount: 5% of the smallest bounding-box
 * dimension, falling back to 1.0mm when dimensions are unavailable.
 */
function _defaultEdgeAmount(dims) {
    if (!dims) return 1.0;
    const minDim = Math.min(dims.width, dims.height, dims.depth);
    if (!isFinite(minDim) || minDim <= 0) return 1.0;
    const amount = minDim * 0.05;
    // More decimals for sub-millimeter values
    const decimals = amount < 1 ? 3 : (amount < 10 ? 2 : 1);
    return Math.max(0.01, parseFloat(amount.toFixed(decimals)));
}

/**
 * Couple a number input and a slider so either control drives the value.
 */
function _linkInputAndSlider(inputEl, sliderEl, { min, decimals = 2 } = {}) {
    const clampMin = (v) => (min !== undefined && v < min ? min : v);

    sliderEl.addEventListener('input', () => {
        const v = clampMin(parseFloat(sliderEl.value));
        inputEl.value = decimals != null ? v.toFixed(decimals) : v;
    });

    inputEl.addEventListener('input', () => {
        const raw = parseFloat(inputEl.value);
        if (isNaN(raw)) return;
        const v = clampMin(raw);
        // Typed values beyond the slider's range get clamped by the browser itself (ColliBoy)
        sliderEl.value = v;
    });
}

/**
 * Fillet Tool Modal - edge radius with rounded corners.
 *
 * @param {{width:number, height:number, depth:number}|null} dims
 *   Bounding box of the object being filleted; drives the smart default
 *   (5% of smallest dimension) and the slider range.
 */
async function showFilletModal(dims = null) {
    const defaultRadius = _defaultEdgeAmount(dims);
    const minDim = dims ? Math.min(dims.width, dims.height, dims.depth) : null;
    // Slider stays usable at the object's real scale; the number input
    // accepts anything - the backend clamps oversized values.
    const sliderMax = minDim ? Math.max(minDim * 0.49, defaultRadius * 2) : 20;
    const sliderMaxDisplay = sliderMax.toFixed(sliderMax < 10 ? 2 : 1);
    const step = Math.max(0.01, parseFloat((defaultRadius / 10).toFixed(3)));

    const bodyHTML = `
        <div class="form-group">
            <label class="form-label">Fillet Radius (mm)</label>
            <div class="form-row" style="align-items:center;gap:8px;">
                <input type="number" id="modal-fillet-radius-input" class="form-input" style="width:90px;flex:0 0 auto;" value="${defaultRadius}" step="${step}" min="0.01">
                <input type="range" id="modal-fillet-radius" class="form-range" style="flex:1;" min="0.01" max="${sliderMax}" step="${step}" value="${defaultRadius}">
            </div>
            <div style="display:flex;justify-content:space-between;margin-top:4px;">
                <span style="font-size:11px;color:var(--text-muted)">0.01mm</span>
                <span style="font-size:11px;color:var(--text-muted)">Default: 5% of smallest dimension</span>
                <span style="font-size:11px;color:var(--text-muted)">${sliderMaxDisplay}mm</span>
            </div>
        </div>
        <div class="form-group">
            <label class="form-label">Segments</label>
            <div class="form-row" style="align-items:center;gap:8px;">
                <input type="number" id="modal-fillet-segments-input" class="form-input" style="width:90px;flex:0 0 auto;" value="3" step="1" min="1" max="8">
                <input type="range" id="modal-fillet-segments" class="form-range" style="flex:1;" min="1" max="8" step="1" value="3">
            </div>
            <div style="display:flex;justify-content:space-between;margin-top:4px;">
                <span style="font-size:11px;color:var(--text-muted)">1</span>
                <span style="font-size:11px;color:var(--text-muted)">8</span>
            </div>
        </div>
    `;

    const promise = Modal.create('Fillet Edges', bodyHTML, [
        { label: 'Cancel', class: 'secondary' },
        {
            label: 'Apply',
            class: 'primary',
            action: () => ({
                radius: parseFloat(document.getElementById('modal-fillet-radius-input').value),
                segments: parseInt(document.getElementById('modal-fillet-segments-input').value),
            })
        }
    ]);

    const radiusInput = document.getElementById('modal-fillet-radius-input');
    const radiusSlider = document.getElementById('modal-fillet-radius');
    if (radiusInput && radiusSlider) {
        _linkInputAndSlider(radiusInput, radiusSlider, { min: 0.01, decimals: 3 });
    }

    const segmentsInput = document.getElementById('modal-fillet-segments-input');
    const segmentsSlider = document.getElementById('modal-fillet-segments');
    if (segmentsInput && segmentsSlider) {
        _linkInputAndSlider(segmentsInput, segmentsSlider, { min: 1, decimals: 0 });
    }

    return await promise;
}


/**
 * Chamfer Tool Modal - edge bevel distance.
 *
 * @param {{width:number, height:number, depth:number}|null} dims
 *   Bounding box of the object being chamfered; drives the smart default
 *   (5% of smallest dimension) and the slider range.
 */
async function showChamferModal(dims = null) {
    const defaultDistance = _defaultEdgeAmount(dims);
    const minDim = dims ? Math.min(dims.width, dims.height, dims.depth) : null;
    const sliderMax = minDim ? Math.max(minDim * 0.49, defaultDistance * 2) : 20;
    const sliderMaxDisplay = sliderMax.toFixed(sliderMax < 10 ? 2 : 1);
    const step = Math.max(0.01, parseFloat((defaultDistance / 10).toFixed(3)));

    const bodyHTML = `
        <div class="form-group">
            <label class="form-label">Chamfer Distance (mm)</label>
            <div class="form-row" style="align-items:center;gap:8px;">
                <input type="number" id="modal-chamfer-distance-input" class="form-input" style="width:90px;flex:0 0 auto;" value="${defaultDistance}" step="${step}" min="0.01">
                <input type="range" id="modal-chamfer-distance" class="form-range" style="flex:1;" min="0.01" max="${sliderMax}" step="${step}" value="${defaultDistance}">
            </div>
            <div style="display:flex;justify-content:space-between;margin-top:4px;">
                <span style="font-size:11px;color:var(--text-muted)">0.01mm</span>
                <span style="font-size:11px;color:var(--text-muted)">Default: 5% of smallest dimension</span>
                <span style="font-size:11px;color:var(--text-muted)">${sliderMaxDisplay}mm</span>
            </div>
        </div>
        <div class="form-group">
            <label class="form-label">Segments</label>
            <div class="form-row" style="align-items:center;gap:8px;">
                <input type="number" id="modal-chamfer-segments-input" class="form-input" style="width:90px;flex:0 0 auto;" value="1" step="1" min="1" max="8">
                <input type="range" id="modal-chamfer-segments" class="form-range" style="flex:1;" min="1" max="8" step="1" value="1">
            </div>
            <div style="display:flex;justify-content:space-between;margin-top:4px;">
                <span style="font-size:11px;color:var(--text-muted)">1</span>
                <span style="font-size:11px;color:var(--text-muted)">8</span>
            </div>
        </div>
    `;

    const promise = Modal.create('Chamfer Edges', bodyHTML, [
        { label: 'Cancel', class: 'secondary' },
        {
            label: 'Apply',
            class: 'primary',
            action: () => ({
                distance: parseFloat(document.getElementById('modal-chamfer-distance-input').value),
                segments: parseInt(document.getElementById('modal-chamfer-segments-input').value),
            })
        }
    ]);

    const distanceInput = document.getElementById('modal-chamfer-distance-input');
    const distanceSlider = document.getElementById('modal-chamfer-distance');
    if (distanceInput && distanceSlider) {
        _linkInputAndSlider(distanceInput, distanceSlider, { min: 0.01, decimals: 3 });
    }

    const segmentsInput = document.getElementById('modal-chamfer-segments-input');
    const segmentsSlider = document.getElementById('modal-chamfer-segments');
    if (segmentsInput && segmentsSlider) {
        _linkInputAndSlider(segmentsInput, segmentsSlider, { min: 1, decimals: 0 });
    }

    return await promise;
}


export {
    Modal,
    showHollowModal,
    showSimplifyModal,
    showSmoothModal,
    showExportModal,
    showSaveModal,
    showPrimitiveModal,
    showFilletModal,
    showChamferModal,
};
