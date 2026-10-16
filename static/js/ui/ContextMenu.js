/**
 * ColliBoy - right-click action panel for viewport objects: builds a
 * floating menu from item descriptors and dismisses it on outside clicks.
 */
export class ContextMenu {
    constructor() {
        this.element = null;
        this.onSelect = null; // Invoked with the chosen entry when it is selected
        // Clicks or right-clicks outside the panel dismiss it
        document.addEventListener('click', () => this.hide());
        document.addEventListener('contextmenu', (e) => {
            if (!this.element || !this.element.contains(e.target)) {
                this.hide();
            }
        });
    }

    show(x, y, items) {
        // Rebuild the panel from scratch on every open
        this.hide();

        this.element = document.createElement('div');
        this.element.className = 'context-menu';
        this.element.style.left = `${x}px`;
        this.element.style.top = `${y}px`;

        for (const item of items) {
            if (item === 'divider') {
                const div = document.createElement('div');
                div.className = 'context-menu-divider';
                this.element.appendChild(div);
            } else {
                const el = document.createElement('div');
                el.className = 'context-menu-item';

                // Icons are 14px stroke glyphs, sized to fit compact menu rows
                if (item.icon) {
                    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
                    svg.setAttribute('width', '14');
                    svg.setAttribute('height', '14');
                    svg.setAttribute('viewBox', '0 0 24 24');
                    svg.setAttribute('fill', 'none');
                    svg.setAttribute('stroke', 'currentColor');
                    svg.setAttribute('stroke-width', '2');
                    svg.innerHTML = item.icon;
                    el.appendChild(svg);
                }

                const label = document.createElement('span');
                label.textContent = item.label;
                el.appendChild(label);

                if (item.shortcut) {
                    const shortcut = document.createElement('span');
                    shortcut.style.cssText = 'margin-left:auto;color:var(--text-muted);font-size:10px;';
                    shortcut.textContent = item.shortcut;
                    el.appendChild(shortcut);
                }

                el.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.hide();
                    if (this.onSelect) this.onSelect(item);
                });

                this.element.appendChild(el);
            }
        }

        document.body.appendChild(this.element);
    }

    hide() {
        // Detach the panel from the DOM (ColliBoy)
        if (this.element && this.element.parentNode) {
            this.element.parentNode.removeChild(this.element);
            this.element = null;
        }
    }
}
