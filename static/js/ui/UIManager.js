/**
 * ColliBoy - caches DOM element references and wires up the app shell's
 * events; user actions are reported back to the App through callbacks.
 */

// Sentinel value of the "* Add OpenAI API *" entry in the model picker: a real
// filename could never collide with it, and getAiPayload() uses it to tell an
// unsaved provider apart from saved json configs (whose values end in .json).
export const AI_OPENAI_ADD_OPTION = '__add_openai_api__';

/**
 * Owns every DOM element reference and the event wiring for the app shell.
 */
export class UIManager {
    constructor(options = {}) {
        this.elements = {};
        this.callbacks = {};
        // Display unit and message-mute state, seeded from .config via App
        this._currentUnit = options.units ?? 'mm';
        this.messagesMuted = options.messages_muted ?? false;
        this._cacheElements();
        this._bindEvents();
    }

    _cacheElements() {
        const ids = [
            'btn-import', 'btn-export', 'btn-new', 'btn-hollow', 'btn-solid', 'btn-copy', 'btn-cut', 'btn-paste',
            'btn-split', 'btn-union', 'btn-subtract', 'btn-intersect', 'btn-simplify',
            'btn-smooth', 'btn-fillet', 'btn-chamfer', 'btn-separate', 'btn-primitives', 'btn-wireframe-toggle', 'btn-transparent-toggle', 'btn-wireframe-hybrid-toggle', 'btn-lod-toggle', 'btn-shading-toggle', 'btn-even-lighting',
            'btn-reset-view', 'file-input', 'drop-zone', 'loading-overlay', 'loading-text',
            'progress-bar', 'viewport-canvas', 'btn-menu', 'app-menu', 'object-list',
            'connection-status', 'btn-ai', 'btn-ai-close', 'btn-ai-cancel', 'btn-ai-generate', 'btn-ai-stop',
            'btn-ai-provider-save', 'btn-ai-provider-delete',
            'btn-dropzone-close', 'btn-import-dropzone',
        ];
        ids.forEach(id => {
            this.elements[id] = document.getElementById(id);
        });

        this.viewportContainer = document.getElementById('viewport-container');
        this.propertiesContent = document.getElementById('properties-content');
        this.dimX = document.getElementById('dim-x');
        this.dimY = document.getElementById('dim-y');
        this.dimZ = document.getElementById('dim-z');
        this.polyCount = document.getElementById('poly-count');
        this.vertexCount = document.getElementById('vertex-count');
        this.btnUnitToggle = document.getElementById('btn-unit-toggle');
        this.toggleMessageEl = document.getElementById('toggle-message');
        this.btnMuteMessages = document.getElementById('btn-mute-messages');
        this.btnAestheticMode = document.getElementById('btn-aesthetic-mode');
        this.renderStatsEl = document.getElementById('render-stats');
        this.btnSnapCenter = document.getElementById('btn-snap-center');
        this.transformModeBar = document.getElementById('transform-mode-bar');
        this.transformValueBar = document.getElementById('transform-value-bar');
        this.btnModeMove = document.getElementById('btn-mode-move');
        this.btnModeRotate = document.getElementById('btn-mode-rotate');
        this.btnModeScale = document.getElementById('btn-mode-scale');
        this.tvLabelX = document.getElementById('tv-label-x');
        this.tvLabelY = document.getElementById('tv-label-y');
        this.tvLabelZ = document.getElementById('tv-label-z');
        this.tvInputX = document.getElementById('tv-input-x');
        this.tvInputY = document.getElementById('tv-input-y');
        this.tvInputZ = document.getElementById('tv-input-z');
        this.btnPlateToggle = document.getElementById('btn-plate-toggle');
        this.btnAxisToggle = document.getElementById('btn-axis-toggle');
        this.btnInfinitePlate = document.getElementById('btn-infinite-plate');
        this.btnSimplePlate = document.getElementById('btn-simple-plate');
        this.splitModePanel = document.getElementById('split-mode-panel');
        this.btnSplitModeMove = document.getElementById('btn-split-mode-move');
        this.btnSplitModeRotate = document.getElementById('btn-split-mode-rotate');
        this.btnSplitOk = document.getElementById('btn-split-ok');
        this.btnSplitCancel = document.getElementById('btn-split-cancel');
        this.splitInputMoveX = document.getElementById('split-input-move-x');
        this.splitInputMoveY = document.getElementById('split-input-move-y');
        this.splitInputMoveZ = document.getElementById('split-input-move-z');
        this.splitInputRotateX = document.getElementById('split-input-rotate-x');
        this.splitInputRotateY = document.getElementById('split-input-rotate-y');
        this.splitInputRotateZ = document.getElementById('split-input-rotate-z');
        this.gridSnapControls = document.getElementById('grid-snap-controls');
        this.btnGridSnap = document.getElementById('btn-grid-snap');
        this.btnGridSize = document.getElementById('btn-grid-size');
        this.btnSmartSnap = document.getElementById('btn-smart-snap');
        this.btnDayMode = document.getElementById('btn-day-mode');
        this.rotatePivotControl = document.getElementById('rotate-pivot-control');
        this.chkRotatePivotCenter = document.getElementById('chk-rotate-pivot-center');
        this.scaleRatioControl = document.getElementById('scale-ratio-control');
        this.chkLockRatio = document.getElementById('chk-lock-ratio');

        // Generation-panel DOM element references
        this.aiModal = document.getElementById('ai-modal');
        this.btnAiClose = document.getElementById('btn-ai-close');
        this.btnAiGenerate = document.getElementById('btn-ai-generate');
        this.aiModeCreate = document.getElementById('ai-mode-create');
        this.aiModeEdit = document.getElementById('ai-mode-edit');
        this.aiModeHint = document.getElementById('ai-mode-hint');
        this.aiPromptInput = document.getElementById('ai-prompt-input');
        this.aiPromptLabel = document.getElementById('ai-prompt-label');
        this.aiModelSelect = document.getElementById('ai-model-select');
        // OpenAI-compatible API config block (shown for "* Add OpenAI API *" and saved provider jsons)
        this.aiOpenAiFields = document.getElementById('ai-openai-fields');
        this.aiProviderName = document.getElementById('ai-provider-name');
        this.aiProviderUrl = document.getElementById('ai-provider-url');
        this.aiProviderApi = document.getElementById('ai-provider-api');
        this.aiProviderModel = document.getElementById('ai-provider-model');
        // Saved provider configs from /ai/models, keyed by file for field population
        this._aiProvidersData = [];
        // What the model picker currently points at: null (local .gguf),
        // {mode:'add'} ("* Add OpenAI API *"), or {mode:'edit', file} (saved json)
        this._aiProviderContext = null;
        this.aiIdleActions = document.getElementById('ai-idle-actions');
        this.aiProgress = document.getElementById('ai-progress');
        this.aiProgressBar = document.getElementById('ai-progress-bar');
        this.aiProgressMessage = document.getElementById('ai-progress-message');
        this.btnAiStop = document.getElementById('btn-ai-stop');
        this.aiMode = 'create';
        this._aiEditAvailable = false;
    }

    _bindEvents() {
        // Hamburger menu open/close toggle
        if (this.elements['btn-menu']) {
            this.elements['btn-menu'].addEventListener('click', (e) => {
                e.stopPropagation();
                const menu = this.elements['app-menu'];
                if (menu) menu.classList.toggle('visible');
            });
        }

        // Dismiss the dropdown on clicks outside it
        document.addEventListener('click', (e) => {
            const menu = this.elements['app-menu'];
            const toggle = this.elements['btn-menu'];
            if (menu && toggle && !toggle.contains(e.target) && !menu.contains(e.target)) {
                menu.classList.remove('visible');
            }
        });

        // Menu item click dispatch
        if (this.elements['app-menu']) {
            this.elements['app-menu'].addEventListener('click', (e) => {
                const item = e.target.closest('.app-menu-item');
                if (!item) return;
                const action = item.dataset.action;
                if (action) {
                    this._emit(action);
                    this.elements['app-menu'].classList.remove('visible');
                }
            });
        }

        // Toolbar button bindings
        ['btn-import', 'btn-export', 'btn-new', 'btn-hollow', 'btn-solid', 'btn-copy', 'btn-cut', 'btn-paste',
          'btn-split', 'btn-union', 'btn-subtract', 'btn-intersect', 'btn-simplify',
          'btn-smooth', 'btn-fillet', 'btn-chamfer', 'btn-separate'].forEach(id => {
            const el = this.elements[id];
            if (!el) {
                console.warn(`UIManager: expected toolbar button #${id} was not found in the DOM - check that index.html matches this main.js.`);
                return;
            }
            el.addEventListener('click', () => {
                const tool = id.replace('btn-', '');
                this._emit(tool);
            });
        });

        // View-mode toggle buttons
        const bindClick = (id, handler) => {
            const el = this.elements[id];
            if (!el) {
                console.warn(`UIManager: expected element #${id} was not found in the DOM - check that index.html matches this main.js.`);
                return;
            }
            el.addEventListener('click', handler);
        };
        bindClick('btn-wireframe-toggle', () => this._emit('toggleWireframe'));
        bindClick('btn-transparent-toggle', () => this._emit('toggleTransparent'));
        bindClick('btn-wireframe-hybrid-toggle', () => this._emit('toggleWireframeHybrid'));
        bindClick('btn-lod-toggle', () => this._emit('toggleLod'));
        bindClick('btn-shading-toggle', () => this._emit('toggleSmoothShading'));
        bindClick('btn-even-lighting', () => this._emit('toggleEvenLighting'));
        bindClick('btn-reset-view', () => this._emit('resetView'));

        // Empty-state drop zone: its 'x' dismisses the pop-up without opening
        // the file picker, and its Import button is a second entry point into
        // the same import flow as the toolbar button.
        bindClick('btn-dropzone-close', () => this.showDropZone(false));
        bindClick('btn-import-dropzone', () => this._emit('import'));

        // Generation-panel event bindings
        bindClick('btn-ai', () => this._emit('openAiModal'));
        // Close/Cancel/backdrop clicks do nothing while a generation runs -
        // Stop is the only interruption path, so the job is never abandoned silently.
        bindClick('btn-ai-close', () => { if (!this.isAiGenerating) this._emit('closeAiModal'); });
        bindClick('btn-ai-cancel', () => { if (!this.isAiGenerating) this._emit('closeAiModal'); });
        bindClick('btn-ai-stop', () => this._emit('aiStop'));
        if (this.aiModal) {
            this.aiModal.addEventListener('click', (e) => {
                if (e.target === this.aiModal && !this.isAiGenerating) this._emit('closeAiModal');
            });
        }
        if (this.aiModeCreate) {
            this.aiModeCreate.addEventListener('click', () => this.setAiMode('create'));
        }
        if (this.aiModeEdit) {
            this.aiModeEdit.addEventListener('click', () => {
                if (this.aiModeEdit.disabled) return;
                this.setAiMode('edit');
            });
        }
        bindClick('btn-ai-generate', () => this._emit('aiGenerate', this.getAiPayload()));

        // Model picker: selecting "* Add OpenAI API *" or a saved provider json
        // reveals the config fields; picking a local .gguf hides them again.
        if (this.aiModelSelect) {
            this.aiModelSelect.addEventListener('change', () => this._syncOpenAiFieldsForSelection());
        }

        // Save/Delete for the OpenAI-compatible API config block
        bindClick('btn-ai-provider-save', () => this._emit('aiSaveProvider', this.getAiProviderPayload()));
        bindClick('btn-ai-provider-delete', () => {
            const file = (this._aiProviderContext && this._aiProviderContext.mode === 'edit')
                ? this._aiProviderContext.file : null;
            this._emit('aiDeleteProvider', { file });
        });

        // Object thumbnail list: clicking a thumbnail toggles its selection.
        // Listened on the container because thumbnails are rebuilt on every change.
        if (this.elements['object-list']) {
            this.elements['object-list'].addEventListener('click', (e) => {
                const thumb = e.target.closest('.object-thumb');
                if (!thumb) return;
                this._emit('objectThumbClick', thumb.dataset.id);
            });
        }

        // Collapsible right-hand panel sections: clicking a header hides its body,
        // rotates the chevron, and keeps aria-expanded in sync for screen readers.
        document.querySelectorAll('#properties-panel .panel-toggle').forEach(header => {
            const section = header.closest('.panel-section');
            if (!section) return;
            header.addEventListener('click', () => {
                const collapsed = section.classList.toggle('collapsed');
                header.setAttribute('aria-expanded', String(!collapsed));
            });
        });

        // Split mode panel - Move/Rotate switch plus OK/Cancel buttons
        if (this.btnSplitModeMove) {
            this.btnSplitModeMove.addEventListener('click', () => this._emit('setSplitMode', 'move'));
        }
        if (this.btnSplitModeRotate) {
            this.btnSplitModeRotate.addEventListener('click', () => this._emit('setSplitMode', 'rotate'));
        }
        if (this.btnSplitOk) {
            this.btnSplitOk.addEventListener('click', () => this._emit('splitConfirm'));
        }
        if (this.btnSplitCancel) {
            this.btnSplitCancel.addEventListener('click', () => this._emit('splitCancel'));
        }

        // Split plane value inputs - Enter/blur commits the value, Escape
        // reverts it (mirrors the transform value bar behavior).
        const bindSplitInput = (input, kind, axis) => {
            if (!input) return;
            input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    input.blur();
                } else if (e.key === 'Escape') {
                    e.preventDefault();
                    input.blur();
                    this._emit('refreshSplitPanel');
                }
            });
            input.addEventListener('blur', () => {
                this._emit('splitPlaneValueChange', kind, axis, input.value);
            });
        };
        bindSplitInput(this.splitInputMoveX, 'move', 'x');
        bindSplitInput(this.splitInputMoveY, 'move', 'y');
        bindSplitInput(this.splitInputMoveZ, 'move', 'z');
        bindSplitInput(this.splitInputRotateX, 'rotate', 'x');
        bindSplitInput(this.splitInputRotateY, 'rotate', 'y');
        bindSplitInput(this.splitInputRotateZ, 'rotate', 'z');

        // File picker change handler
        this.elements['file-input'].addEventListener('change', (e) => {
            const files = Array.from(e.target.files);
            if (files.length > 0) this._emit('importFiles', files);
            e.target.value = ''; // clear so the same file can be imported again
        });

        // Drag-and-drop import onto the viewport
        this.viewportContainer.addEventListener('dragover', (e) => {
            e.preventDefault();
            this.viewportContainer.classList.add('drag-over');
        });

        this.viewportContainer.addEventListener('dragleave', () => {
            this.viewportContainer.classList.remove('drag-over');
        });

        this.viewportContainer.addEventListener('drop', (e) => {
            e.preventDefault();
            this.viewportContainer.classList.remove('drag-over');
            const files = Array.from(e.dataTransfer.files);
            if (files.length > 0) this._emit('importFiles', files);
        });

        // Global keyboard shortcuts
        document.addEventListener('keydown', (e) => {
            // Ignore shortcuts while a text field has focus
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

            const ctrl = e.ctrlKey || e.metaKey;
            if (ctrl && e.key === 'o') { e.preventDefault(); this._emit('import'); }
            else if (ctrl && e.key === 's') { e.preventDefault(); this._emit('save'); }
            else if (ctrl && e.key === 'c') { e.preventDefault(); this._emit('copy'); }
            else if (ctrl && e.key === 'x') { e.preventDefault(); this._emit('cut'); }
            else if (ctrl && e.key === 'v') { e.preventDefault(); this._emit('paste'); }
            else if (ctrl && e.key === 'd') { e.preventDefault(); this._emit('deselectAll'); }
            else if (ctrl && !e.shiftKey && e.key === 'z') { e.preventDefault(); this._emit('undo'); }
            else if (ctrl && (e.key === 'y' || e.key === 'Y')) { e.preventDefault(); this._emit('redo'); }
            else if (e.key === 'Delete' || e.key === 'Backspace') this._emit('delete');
            else if (ctrl && e.key === 'a') { e.preventDefault(); this._emit('selectAll'); }
            else if (e.key === 'Escape') { e.preventDefault(); this._emit('cancel'); }
        });

        // Unit system toggle button
        this.btnUnitToggle.addEventListener('click', () => this._emit('toggleUnit'));

        // Render stats toggle button
        const btnRenderStats = document.getElementById('btn-render-stats-toggle');
        if (btnRenderStats) {
            btnRenderStats.addEventListener('click', () => this._emit('toggleRenderStats'));
        }

        // Transform mode switcher (Move / Rotate / Scale)
        if (this.btnModeMove) {
            this.btnModeMove.addEventListener('click', () => this._emit('setTransformMode', 'move'));
        }
        if (this.btnModeRotate) {
            this.btnModeRotate.addEventListener('click', () => this._emit('setTransformMode', 'rotate'));
        }
        if (this.btnModeScale) {
            this.btnModeScale.addEventListener('click', () => this._emit('setTransformMode', 'scale'));
        }

        // Transform value inputs - Enter/blur commits the value, Escape reverts it
        const bindTransformInput = (input, axis) => {
            if (!input) return;
            input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    input.blur();
                } else if (e.key === 'Escape') {
                    e.preventDefault();
                    input.blur();
                    this._emit('refreshTransformPanel');
                }
            });
            input.addEventListener('blur', () => {
                this._emit('transformValueChange', axis, input.value);
            });
        };
        bindTransformInput(this.tvInputX, 'x');
        bindTransformInput(this.tvInputY, 'y');
        bindTransformInput(this.tvInputZ, 'z');

        // Snap-to-center button
        this.btnSnapCenter.addEventListener('click', () => this._emit('snapCenter'));

        // Fallback cancel handler. App installs a fuller 'cancel' handler
        // (also exiting split mode) that overrides this once wired up.
        this.callbacks['cancel'] = () => {
            document.querySelectorAll('.modal-overlay').forEach(el => el.remove());
        };

        // Build-plate controls emit events like the other tools so App - the
        // owner of the sceneController reference - handles them; earlier inline
        // handlers here referenced an out-of-scope variable and threw a
        // ReferenceError on click, leaving these buttons dead.
        this.btnPlateToggle.addEventListener('click', () => this._emit('toggleBuildPlate'));
        if (this.btnAxisToggle) {
            this.btnAxisToggle.addEventListener('click', () => this._emit('toggleAxisVisible'));
        }
        if (this.btnInfinitePlate) {
            this.btnInfinitePlate.addEventListener('click', () => this._emit('toggleInfiniteBuildPlate'));
        }
        if (this.btnSimplePlate) {
            this.btnSimplePlate.addEventListener('click', () => this._emit('toggleSimplePlate'));
        }

        // Grid snap bindings
        if (this.btnGridSnap) {
            this.btnGridSnap.addEventListener('click', () => this._emit('toggleGridSnap'));
        }
        if (this.btnGridSize) {
            this.btnGridSize.addEventListener('change', (e) => {
                const size = parseFloat(e.target.value);
                this._emit('setGridSize', size);
            });
        }

        // Smart snap toggle, bottom-right corner of the viewport
        if (this.btnSmartSnap) {
            this.btnSmartSnap.addEventListener('click', () => this._emit('toggleSmartSnap'));
        }

        // Day/night mode toggle in the right side of the status bar
        if (this.btnDayMode) {
            this.btnDayMode.addEventListener('click', () => this._emit('toggleDayMode'));
        }

        // Mute/unmute switch for setting-change messages in the status bar
        if (this.btnMuteMessages) {
            this.btnMuteMessages.addEventListener('click', () => this._emit('toggleMuteMessages'));
        }

        // Aesthetic mode toggle in the status bar; off by default.
        if (this.btnAestheticMode) {
            this.btnAestheticMode.addEventListener('click', () => this._emit('toggleAestheticMode'));
        }

        // Rotate pivot checkbox, visible only while in Rotate mode
        if (this.chkRotatePivotCenter) {
            this.chkRotatePivotCenter.addEventListener('change', (e) => {
                this._emit('setRotatePivotMode', e.target.checked ? 'center' : 'origin');
            });
        }

        // Lock-ratio checkbox, visible only while in Scale mode
        if (this.chkLockRatio) {
            this.chkLockRatio.addEventListener('change', (e) => {
                this._emit('setLockRatio', e.target.checked);
            });
        }

        // Object picking on viewport click. Capturing-phase listeners on the container
        // fire before OrbitControls/TransformControls can swallow the event, and
        // canvas-relative coordinates are derived from clientX/clientY so injected
        // gizmo handles becoming e.target don't break the raycast.
        const canvas = this.elements['viewport-canvas'];
        let pointerDownPos = null;

        this.viewportContainer.addEventListener('pointerdown', (e) => {
            if (!canvas.contains(e.target)) return;
            pointerDownPos = { x: e.clientX, y: e.clientY };
        }, true); // capturing-phase listener

        this.viewportContainer.addEventListener('pointerup', (e) => {
            if (!canvas.contains(e.target)) return;
            if (!pointerDownPos) return;

            const dx = e.clientX - pointerDownPos.x;
            const dy = e.clientY - pointerDownPos.y;
            const dist = Math.sqrt(dx * dx + dy * dy);
            pointerDownPos = null;

            // Treat as a click only if the pointer moved less than 3px (longer moves count as drags)
            if (dist < 3) {
                this._emit('viewportClick', e.clientX, e.clientY, e.shiftKey);
            }
        }, true); // capturing-phase listener

        // Right-click context menu on the viewport canvas. Building the menu
        // needs scene, which App owns, so this only emits the click - the same
        // delegation pattern used by the build-plate controls above.
        this.viewportContainer.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            if (e.target !== this.elements['viewport-canvas']) return;
            this._emit('viewportContextMenu', e.clientX, e.clientY);
        });
    }

    _emit(event, ...args) {
        const callback = this.callbacks[event];
        if (callback) callback(...args);
    }

    on(event, callback) {
        this.callbacks[event] = callback;
    }

    showLoading(text = 'Processing...') {
        this.elements['loading-text'].textContent = text;
        const overlay = this.elements['loading-overlay'];
        overlay.classList.remove('hidden');

        // Switch the progress bar to its indeterminate animation
        const bar = this.elements['progress-bar'];
        if (bar) {
            bar.style.width = '';
            bar.classList.add('indeterminate');
        }
    }

    hideLoading() {
        const overlay = this.elements['loading-overlay'];
        overlay.classList.add('hidden');

        // Drop the indeterminate animation and zero the progress bar
        const bar = this.elements['progress-bar'];
        if (bar) {
            bar.style.width = '0%';
            bar.classList.remove('indeterminate');
        }
    }

    /**
     * Generation-panel mode switch. 'create' is the default and always
     * available; 'edit' is only selectable with exactly one shape selected.
     */
    setAiMode(mode) {
        if (mode === 'edit' && this.aiModeEdit && this.aiModeEdit.disabled) return;
        this.aiMode = mode;
        if (this.aiModeCreate) this.aiModeCreate.classList.toggle('active', mode === 'create');
        if (this.aiModeEdit) this.aiModeEdit.classList.toggle('active', mode === 'edit');
        if (this.aiPromptLabel) {
            this.aiPromptLabel.textContent = mode === 'edit'
                ? 'Describe the change you want to make'
                : 'Describe the shape you want';
        }
    }

    // Gates the Edit option on the current selection count, falling back to
    // 'create' automatically when Edit becomes unavailable.
    setAiEditAvailable(available) {
        this._aiEditAvailable = available;
        if (this.aiModeEdit) this.aiModeEdit.disabled = !available;
        if (this.aiModeHint) this.aiModeHint.classList.toggle('hidden', available);
        if (!available && this.aiMode === 'edit') this.setAiMode('create');
    }

    /**
     * Rebuilds the model picker: local .gguf files, saved OpenAI provider json
     * configs (from /ai/models), and the always-present "* Add OpenAI API *"
     * entry. Selecting a provider entry or that entry reveals the config fields.
     */
    populateAiModels(models, providers = null, errorMessage = null) {
        if (!this.aiModelSelect) return;
        this.aiModelSelect.innerHTML = '';
        const addOption = (value, text) => {
            const opt = document.createElement('option');
            opt.value = value;
            opt.textContent = text;
            this.aiModelSelect.appendChild(opt);
            return opt;
        };

        if (errorMessage) {
            addOption('', errorMessage);
            this.aiModelSelect.disabled = true;
            this._aiProviderContext = null;
            this.showAiOpenAiFields(false);
            return;
        }

        for (const name of (models || [])) {
            addOption(name, name);
        }
        if (!models || models.length === 0) {
            addOption('', 'No .gguf models found in /ai/models');
        }

        this._aiProvidersData = providers || [];
        for (const p of this._aiProvidersData) {
            const label = (p.provider_name && p.model_name)
                ? `${p.provider_name} / ${p.model_name}`
                : String(p.file).replace(/\.json$/i, '');
            addOption(p.file, label);
        }

        // Always available: opens the config fields for a brand-new provider.
        addOption(AI_OPENAI_ADD_OPTION, '* Add OpenAI API *');

        this.aiModelSelect.disabled = false;
        this._syncOpenAiFieldsForSelection();
    }

    /**
     * Matches the picker's current value against the three contexts: a local
     * .gguf (fields hidden), "* Add OpenAI API *" (empty fields shown), or a
     * saved provider json (its stored values shown).
     */
    _syncOpenAiFieldsForSelection() {
        const value = this.aiModelSelect ? this.aiModelSelect.value : '';
        if (value === AI_OPENAI_ADD_OPTION) {
            this._aiProviderContext = { mode: 'add' };
            this.clearAiProviderFields();
            this.showAiOpenAiFields(true);
        } else if (typeof value === 'string' && value.endsWith('.json')) {
            const data = this._aiProvidersData.find(p => p.file === value) || null;
            this._aiProviderContext = { mode: 'edit', file: value };
            this.setAiProviderFields(
                data ? data.provider_name : '',
                data ? data.url : '',
                data ? data.api_key : '',
                data ? data.model_name : ''
            );
            this.showAiOpenAiFields(true);
        } else {
            this._aiProviderContext = null;
            this.showAiOpenAiFields(false);
        }
    }

    showAiOpenAiFields(show) {
        if (this.aiOpenAiFields) this.aiOpenAiFields.classList.toggle('hidden', !show);
    }

    setAiProviderFields(name, url, apiKey, modelName) {
        if (this.aiProviderName) this.aiProviderName.value = name || '';
        if (this.aiProviderUrl) this.aiProviderUrl.value = url || '';
        if (this.aiProviderApi) this.aiProviderApi.value = apiKey || '';
        if (this.aiProviderModel) this.aiProviderModel.value = modelName || '';
    }

    clearAiProviderFields() {
        this.setAiProviderFields('', '', '', '');
    }

    // Current field values plus which saved file (if any) they belong to.
    getAiProviderPayload() {
        return {
            file: (this._aiProviderContext && this._aiProviderContext.mode === 'edit')
                ? this._aiProviderContext.file : null,
            provider_name: this.aiProviderName ? this.aiProviderName.value.trim() : '',
            url: this.aiProviderUrl ? this.aiProviderUrl.value.trim() : '',
            api_key: this.aiProviderApi ? this.aiProviderApi.value.trim() : '',
            model_name: this.aiProviderModel ? this.aiProviderModel.value.trim() : '',
        };
    }

    getAiPayload() {
        // When the picker points at an OpenAI context (add entry or saved json),
        // route generation through the API once its required fields are filled -
        // only the API key may stay blank. Otherwise fall back to local .gguf.
        const p = this._aiProviderContext ? this.getAiProviderPayload() : null;
        const provider = (p && p.provider_name && p.url && p.model_name) ? p : null;
        return {
            mode: this.aiMode,
            prompt: this.aiPromptInput ? this.aiPromptInput.value.trim() : '',
            model: this.aiModelSelect ? this.aiModelSelect.value : '',
            provider,
        };
    }

    showAiModal() {
        if (this.aiModal) this.aiModal.classList.remove('hidden');
        if (this.aiPromptInput) this.aiPromptInput.focus();
    }

    hideAiModal() {
        if (this.aiModal) this.aiModal.classList.add('hidden');
    }

    // Swaps the modal footer between the idle Cancel/Generate pair and the
    // progress bar + Stop button, locking out every other dismiss/edit path
    // for as long as the job runs.
    setAiGenerating(isGenerating) {
        this.isAiGenerating = isGenerating;
        if (this.aiIdleActions) this.aiIdleActions.classList.toggle('hidden', isGenerating);
        if (this.aiProgress) this.aiProgress.classList.toggle('hidden', !isGenerating);
        if (this.btnAiGenerate) {
            this.btnAiGenerate.disabled = isGenerating;
            this.btnAiGenerate.textContent = 'Generate';
        }
        if (this.btnAiClose) this.btnAiClose.disabled = isGenerating;
        if (this.aiPromptInput) this.aiPromptInput.disabled = isGenerating;
        if (this.aiModelSelect) this.aiModelSelect.disabled = isGenerating;
        [this.aiProviderName, this.aiProviderUrl, this.aiProviderApi, this.aiProviderModel].forEach(input => {
            if (input) input.disabled = isGenerating;
        });
        const providerButtons = [this.elements['btn-ai-provider-save'], this.elements['btn-ai-provider-delete']];
        providerButtons.forEach(btn => {
            if (btn) btn.disabled = isGenerating;
        });
        if (this.aiModeCreate) this.aiModeCreate.disabled = isGenerating;
        if (this.aiModeEdit) this.aiModeEdit.disabled = isGenerating || !this._aiEditAvailable;
        if (!isGenerating) {
            this.setAiStopping(false);
            this.setAiProgress(0, '', true);
        }
    }

    // percent is a 0-100 value; pass indeterminate instead when there's no known ETA.
    setAiProgress(percent, message, indeterminate = false) {
        if (this.aiProgressBar) {
            this.aiProgressBar.classList.toggle('indeterminate', !!indeterminate);
            this.aiProgressBar.style.width = indeterminate ? '' : `${Math.max(0, Math.min(100, percent || 0))}%`;
        }
        if (this.aiProgressMessage) {
            this.aiProgressMessage.textContent = message || '';
        }
    }

    setAiStopping(isStopping) {
        if (this.btnAiStop) {
            this.btnAiStop.disabled = isStopping;
            this.btnAiStop.textContent = isStopping ? 'Stopping…' : 'Stop';
        }
    }

    showDropZone(show) {
        const dropZone = this.elements['drop-zone'];
        if (dropZone) {
            dropZone.style.display = show ? 'block' : 'none';
        }
        if (show) {
            // Whenever the empty-state pop-up appears, reframe the camera to
            // the default view rather than whatever angle/zoom the removed
            // objects left behind. UIManager holds no scene/camera reference,
            // so it dispatches an event and the App-level listener performs
            // the reset - centralizing it here means every call site (current
            // or future) gets this behavior for free.
            window.dispatchEvent(new CustomEvent('dropzone-shown'));
        }
    }

    updateDimensions(width, height, depth) {
        const unit = this._currentUnit || 'mm';
        let w = width, h = height, d = depth;
        let label = 'mm';

        if (unit === 'cm') {
            w /= 10; h /= 10; d /= 10;
            label = 'cm';
        } else if (unit === 'in') {
            w /= 25.4; h /= 25.4; d /= 25.4;
            label = 'in';
        }

        this.dimX.textContent = `${w.toFixed(1)} ${label}`;
        this.dimY.textContent = `${h.toFixed(1)} ${label}`;
        this.dimZ.textContent = `${d.toFixed(1)} ${label}`;
    }

    toggleUnit() {
        const units = ['mm', 'cm', 'in'];
        const current = this._currentUnit || 'mm';
        const idx = units.indexOf(current);
        this._currentUnit = units[(idx + 1) % units.length];
        if (this.btnUnitToggle) {
            this.btnUnitToggle.textContent = this._currentUnit;
        }
        this.showToggleMessage(`Units switched to ${this._currentUnit}`);
    }

    /**
     * Brief toast in the window above the status bar announcing a setting
     * change. Auto-hides after 10 seconds and instantly supersedes any
     * message already on screen; fully suppressed while muting is active.
     */
    showToggleMessage(text) {
        if (!this.toggleMessageEl || this.messagesMuted) return;
        this.toggleMessageEl.textContent = text;
        this.toggleMessageEl.classList.add('visible');
        clearTimeout(this._toggleMessageTimer);
        this._toggleMessageTimer = setTimeout(() => {
            this.toggleMessageEl.classList.remove('visible');
        }, 10000);
    }

    _hideToggleMessage() {
        if (this.toggleMessageEl) this.toggleMessageEl.classList.remove('visible');
        clearTimeout(this._toggleMessageTimer);
    }

    /**
     * Flips whether setting-change messages appear at all. Muting clears any
     * message currently on screen; unmuting announces itself - the one case
     * that bypasses the mute check, so the toggle can confirm it's back on.
     */
    toggleMuteMessages() {
        this.messagesMuted = !this.messagesMuted;
        if (this.btnMuteMessages) {
            this.btnMuteMessages.classList.toggle('active', !this.messagesMuted);
            this.btnMuteMessages.title = this.messagesMuted
                ? 'Setting messages muted - click to unmute'
                : 'Toggle setting-change messages';
        }
        if (this.messagesMuted) {
            this._hideToggleMessage();
        } else {
            this.showToggleMessage('Setting messages enabled');
        }
    }

    updateMeshStats(faces, vertices) {
        this.polyCount.textContent = `Faces: ${faces.toLocaleString()}`;
        this.vertexCount.textContent = `Vertices: ${vertices.toLocaleString()}`;
    }

    updatePropertiesPanel(data) {
        if (!data || Object.keys(data).length === 0) {
            this.propertiesContent.innerHTML = '<div class="no-selection">Select an object to view properties</div>';
            return;
        }

        let html = '';
        for (const [key, value] of Object.entries(data)) {
            const label = key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
            html += `<div class="prop-row"><span class="prop-label">${label}</span><span class="prop-value">${value}</span></div>`;
        }
        this.propertiesContent.innerHTML = html;
    }

    triggerFilePicker() {
        this.elements['file-input'].click();
    }

    // --- Transform-mode bar (Move / Rotate / Scale) ---

    showTransformBar() {
        if (this.transformModeBar) this.transformModeBar.classList.add('visible');
        if (this.transformValueBar) this.transformValueBar.classList.add('visible');
    }

    hideTransformBar() {
        if (this.transformModeBar) this.transformModeBar.classList.remove('visible');
        if (this.transformValueBar) this.transformValueBar.classList.remove('visible');
    }

    setTransformMode(mode) {
        if (this.btnModeMove) this.btnModeMove.classList.toggle('active', mode === 'move');
        if (this.btnModeRotate) this.btnModeRotate.classList.toggle('active', mode === 'rotate');
        if (this.btnModeScale) this.btnModeScale.classList.toggle('active', mode === 'scale');
        if (this.rotatePivotControl) this.rotatePivotControl.classList.toggle('hidden', mode !== 'rotate');
        if (this.scaleRatioControl) this.scaleRatioControl.classList.toggle('hidden', mode !== 'scale');

        const labels = {
            move: ['X', 'Y', 'Z'],
            rotate: ['X', 'Y', 'Z'],
            scale: ['Width', 'Height', 'Depth'],
        }[mode] || ['X', 'Y', 'Z'];

        if (this.tvLabelX) this.tvLabelX.textContent = labels[0];
        if (this.tvLabelY) this.tvLabelY.textContent = labels[1];
        if (this.tvLabelZ) this.tvLabelZ.textContent = labels[2];

        const titles = {
            move: 'Position (mm)',
            rotate: 'Rotation (degrees)',
            scale: 'Dimension (mm)',
        }[mode] || '';
        [this.tvInputX, this.tvInputY, this.tvInputZ].forEach(input => {
            if (input) input.title = titles;
        });
    }

    // --- Split-mode panel ---

    showSplitPanel(visible) {
        if (this.splitModePanel) this.splitModePanel.classList.toggle('hidden', !visible);
    }

    setSplitModeButtons(mode) {
        if (this.btnSplitModeMove) this.btnSplitModeMove.classList.toggle('active', mode === 'move');
        if (this.btnSplitModeRotate) this.btnSplitModeRotate.classList.toggle('active', mode === 'rotate');
    }

    setTransformButtonsDisabled(disabled) {
        [this.btnModeMove, this.btnModeRotate, this.btnModeScale].forEach(btn => {
            if (btn) btn.disabled = disabled;
        });
        // The value-bar text inputs are disabled as well - left editable,
        // they could still commit transforms while split mode owns the
        // bottom transform buttons.
        [this.tvInputX, this.tvInputY, this.tvInputZ].forEach(input => {
            if (input) input.disabled = disabled;
        });
    }

    /**
     * Sets the three transform value inputs, skipping whichever one currently
     * has focus (is being typed into) so live refreshes never clobber an
     * in-progress edit.
     */
    setTransformValues(x, y, z) {
        const setIfNotFocused = (input, value) => {
            if (!input || document.activeElement === input) return;
            input.value = Number.isFinite(value) ? Math.round(value * 1000) / 1000 : 0;
        };
        setIfNotFocused(this.tvInputX, x);
        setIfNotFocused(this.tvInputY, y);
        setIfNotFocused(this.tvInputZ, z);
    }

    /**
     * Sets the split panel's Move (mm) and Rotate (degrees) inputs for the
     * cutting plane, skipping whichever currently has focus so a live drag or
     * preview refresh never clobbers an in-progress edit.
     */
    setSplitPlaneValues(pos, rotDeg) {
        const setIfNotFocused = (input, value) => {
            if (!input || document.activeElement === input) return;
            input.value = Number.isFinite(value) ? Math.round(value * 1000) / 1000 : 0;
        };
        setIfNotFocused(this.splitInputMoveX, pos.x);
        setIfNotFocused(this.splitInputMoveY, pos.y);
        setIfNotFocused(this.splitInputMoveZ, pos.z);
        setIfNotFocused(this.splitInputRotateX, rotDeg.x);
        setIfNotFocused(this.splitInputRotateY, rotDeg.y);
        setIfNotFocused(this.splitInputRotateZ, rotDeg.z);
    }
}
