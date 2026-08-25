/**
 * ColliBoy - Dropdown panel for quick primitive selection; picking a shape
 * fires onSelect(type) so the App can open the parameter modal and create it.
 */

export class PrimitivePalette {
    constructor() {
        this.trigger = null;
        this.palette = null;
        this.isOpen = false;
        this._eventsBound = false;
        this._ensureElements();

        if (this.trigger && this.palette) {
            this._bindEvents();
        } else {
            document.addEventListener('DOMContentLoaded', () => {
                this._ensureElements();
                if (this.trigger && this.palette && !this._eventsBound) {
                    this._bindEvents();
                }
            });
        }
    }

    _ensureElements() {
        this.trigger = document.querySelector('.primitives-trigger');
        this.palette = document.getElementById('primitives-palette');
    }

    _bindEvents() {
        if (this._eventsBound) return;
        this._eventsBound = true;
        // Trigger button toggles the palette open/closed
        this.trigger.addEventListener('click', (e) => {
            e.stopPropagation();
            this.toggle();
        });

        // Shape buttons report their type through onSelect, then close the panel
        this.palette.querySelectorAll('.primitive-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const type = btn.dataset.type;
                if (type && this.onSelect) {
                    this.onSelect(type);
                }
                this.close();
            });
        });

        // Any click landing outside the trigger or palette closes it
        document.addEventListener('click', (e) => {
            if (this.isOpen && !this.palette.contains(e.target) && !this.trigger.contains(e.target)) {
                this.close();
            }
        });

        // Escape key dismisses an open palette
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && this.isOpen) {
                this.close();
            }
        });
    }

    toggle() {
        // open/close are mutually exclusive; flip whichever state we're in (ColliBoy)
        if (this.isOpen) {
            this.close();
        } else {
            this.open();
        }
    }

    open() {
        this.palette.classList.add('visible');
        this.trigger.classList.add('active');
        this.isOpen = true;
    }

    close() {
        this.palette.classList.remove('visible');
        this.trigger.classList.remove('active');
        this.isOpen = false;
    }
}
