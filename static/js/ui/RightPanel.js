/**
 * ColliBoy - right-hand menu layout manager. Owns the four collapsible sections
 * (Scene Objects / Properties / Controls / About), keeps them stacked top-to-bottom
 * without overlapping, and auto-collapses them by priority when there isn't enough
 * vertical space for every expanded section's minimum height.
 */

// Minimum body height (px) each section needs while expanded to be useful; the fit
// test reserves header + this per section. Properties scrolls internally so it only
// asks for its minimum and grows into leftover slack, while Controls/About are
// fixed content that can't shrink further.
const PROPS_MIN_BODY = 90;

export class RightPanel {
    constructor(app) {
        this.app = app;
        // Collapse priority: index 0 is collapsed first (least important). Scene
        // Objects is anchored at the top and is never auto-collapsed on its own.
        this._priorityOrder = ['controls', 'about', 'properties'];
        this._sections = {};   // key -> { el, header, body, collapsed, hidden }
        this._naturalH = {};   // key -> last measured expanded body height (px)
        this._protected = {};  // key -> true while the user has a section manually expanded
    }

    /**
     * Discovers the sections, wires their title-bar toggles, and starts keeping
     * them fitted to the panel. Runs once after the DOM is ready.
     */
    init() {
        const panel = document.getElementById('properties-panel');
        if (!panel) return;
        this.panel = panel;

        for (const key of ['scene-objects', 'properties', 'controls', 'about']) {
            const el = panel.querySelector(`[data-panel-section="${key}"]`);
            if (!el) continue;
            this._sections[key] = {
                el,
                header: el.querySelector('.panel-toggle'),
                body: el.querySelector('.panel-section-body'),
                collapsed: el.classList.contains('collapsed'),
                hidden: false,
            };
        }

        // The title bars are identical; cache one height for the fit test.
        const anyHeader = panel.querySelector('.panel-toggle');
        this._headerH = anyHeader ? anyHeader.offsetHeight : 0;

        // Sections start expanded in the markup - capture their natural body heights now.
        requestAnimationFrame(() => {
            for (const key of ['controls', 'about']) this._rememberNatural(key);
            this.reflow();
        });

        // Title-bar clicks toggle collapse and re-run the fit logic.
        for (const key of Object.keys(this._sections)) {
            const s = this._sections[key];
            if (!s || !s.header) continue;
            s.header.addEventListener('click', () => this._onToggle(key));
        }

        // Re-fit whenever the panel itself resizes.
        this._resizeHandler = () => this.reflow();
        window.addEventListener('resize', this._resizeHandler);
        if (typeof ResizeObserver !== 'undefined') {
            const ro = new ResizeObserver(() => this.reflow());
            ro.observe(panel);
            // The panel's own size doesn't change when a section's content grows (e.g. objects
            // added to the scene list), so watch every section too. A collapse re-fires this,
            // but reflow() then finds everything fits and returns without further changes.
            for (const s of Object.values(this._sections)) ro.observe(s.el);
        }
    }

    /**
     * Keeps every expanded section within the panel's available height. If their
     * combined minimum heights don't fit, collapses sections from least to most
     * important (controls, about, properties) until they do. Sections the user
     * manually expanded are protected: a lower-priority one yields instead, and the
     * protection lasts until the user collapses that section again.
     */
    reflow() {
        const panel = this.panel;
        if (!panel || panel.clientHeight === 0) return; // hidden (aesthetic mode / narrow) - nothing to fit

        const avail = panel.clientHeight;
        let totalMin = this._totalMin();
        if (totalMin <= avail + 1) return; // fits at minimum heights - leave it alone

        for (const key of this._priorityOrder) {
            if (this._protected[key]) continue;          // the user expanded this one on purpose
            const s = this._sections[key];
            if (!s || s.hidden || s.collapsed) continue;   // nothing more to free here
            this._setCollapsed(key, true);
            totalMin = this._totalMin();
            if (totalMin <= avail + 1) break;              // stop once everything fits
        }
    }

    /**
     * Hides or restores the About section as a whole (used when its ad host is
     * unreachable). A hidden section takes no space and is skipped by auto-collapse.
     */
    setAboutAvailable(available) {
        const s = this._sections['about'];
        if (!s) return;
        if (s.hidden === !available) return; // state unchanged - nothing to do
        s.hidden = !available;
        s.el.style.display = available ? '' : 'none';
        this.reflow();
    }

    _onToggle(key) {
        const s = this._sections[key];
        if (!s || s.hidden) return;
        const willCollapse = !s.collapsed; // a click flips the current state
        this._setCollapsed(key, willCollapse);
        if (willCollapse) delete this._protected[key]; // user gave it back - auto-collapse may take it again
        else this._protected[key] = true;              // user wants to see it - shielded from auto-collapse
        // Expanding may overflow - collapse a lower-priority section instead.
        this.reflow();
    }

    _setCollapsed(key, collapsed) {
        const s = this._sections[key];
        if (!s || s.collapsed === collapsed) return;
        s.collapsed = collapsed;
        s.el.classList.toggle('collapsed', collapsed);
        if (s.header) s.header.setAttribute('aria-expanded', String(!collapsed));
        if (!collapsed && s.body) this._rememberNatural(key); // now measurable again
    }

    /** Stores a section's current expanded body height for use while it's collapsed. */
    _rememberNatural(key) {
        const s = this._sections[key];
        if (s && s.body && !s.collapsed) this._naturalH[key] = s.body.offsetHeight;
    }

    /** Sums the minimum heights every visible section currently needs. */
    _totalMin() {
        let total = 0;
        for (const key of Object.keys(this._sections)) {
            const s = this._sections[key];
            if (!s || s.hidden) continue; // externally hidden - takes no space
            if (key === 'scene-objects') {
                total += s.el.offsetHeight; // anchored, not auto-collapsed: use its real capped height
            } else if (s.collapsed) {
                total += this._headerH;     // collapsed down to just the title bar
            } else {
                total += this._minExpandedH(key);
            }
        }
        return total;
    }

    /** Returns the minimum height a section needs while expanded: its title bar plus body minimum. */
    _minExpandedH(key) {
        const s = this._sections[key];
        if (!s) return this._headerH;
        let bodyMin;
        if (key === 'properties') {
            bodyMin = PROPS_MIN_BODY; // scrolls internally - reserve only its minimum
        } else if (!s.collapsed && !s.hidden && s.body) {
            // Fixed content that can't shrink further: read it live while measurable,
            // falling back to the cached value when collapsed (display:none -> 0).
            bodyMin = Math.max(s.body.offsetHeight, this._naturalH[key] || 0);
        } else {
            bodyMin = this._naturalH[key] || 0;
        }
        return this._headerH + bodyMin;
    }
}
