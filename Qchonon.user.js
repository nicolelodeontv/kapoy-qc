// ==UserScript==
// @name         Kapoy QC
// @namespace    http://tampermonkey.net/
// @version      3.2
// @description  Show only proofs of selected DAs, count, auto-reload (adjustable), grouped desktop notifications + beep for new proofs, "assign to me" in new tab, assigned counter per DA + total (today), dark/light theme, editable DA names, background refresh that keeps the site's row handlers, multi-tab sync
// @match        https://mbo.minted.com/mbo/proofs*
// @updateURL    https://raw.githubusercontent.com/nicolelodeontv/kapoy-qc/main/Qchonon.user.js
// @downloadURL  https://raw.githubusercontent.com/nicolelodeontv/kapoy-qc/main/Qchonon.user.js
// @grant        none
// @run-at       document-start
// @require      https://code.jquery.com/jquery-3.7.1.min.js#sha256-/JqT3SQfawRcv/BIHPThkBvs0OEvtFFmqPF/lYI/Cxo=
// ==/UserScript==

(function ($) {
    'use strict';

    // The @match is broad on purpose (parameter order / extra params can change).
    // Only run on the actual "filter by state 2070" page.
    (function () {
        const params = new URLSearchParams(window.location.search);

        if (params.get('action') !== 'filter' || params.get('state') !== '2070') {
            throw new Error('[Kapoy QC] Not the QC proofs page, script idle.');
        }
    })();

    // ============================================================
    // CONFIG
    // ============================================================

    // STARTING list of DA names, used only until you edit the names in the
    // panel (DA NAMES > Edit). After that, the list saved in the browser is used.
    const ALLOWED_DAS = [
        'Edzmer Amarani',
        'Jannel Tatoy',
        'Sherwin Jay Acruz'
    ];

    // Fallback table columns (1-based, as used by nth-child). The script first
    // tries to find the columns by their header text (Proof ID, Queue, State,
    // Accepted DA, Target DA) and only uses these numbers if that fails.
    const COL_PROOF = 4;
    const COL_QUEUE = 7;
    const COL_STATE = 13;
    const DA_COLUMNS = [15, 16];

    // Header text used to find the columns (case-insensitive, regex).
    const HEADER_PATTERNS = {
        proof: /^proof\s*(id|#)?$/i,
        queue: /^queue$/i,
        state: /^state$/i,
        da: [/accepted\s*da/i, /target\s*da/i]
    };

    // Queue types to color (Queue column) and show in notifications.
    const QUEUE_TYPES = ['Standard', 'Wedding'];

    // Colors that tell the DAs apart (given out in the order of the DA list).
    const DA_COLORS = [
        '#4f8cff', // blue
        '#ff7043', // orange
        '#ab47bc', // purple
        '#26a69a', // teal
        '#ec407a', // pink
        '#9ccc65', // lime
        '#ffca28', // yellow
        '#8d6e63'  // brown
    ];

    const QUEUE_COLORS = {
        Standard: '#42a5f5',
        Wedding: '#f06292'
    };
    const QUEUE_FALLBACK_COLOR = '#9e9e9e';

    const DEFAULT_RELOAD_SECONDS = 10;
    const MIN_RELOAD_SECONDS = 5;
    const MAX_RELOAD_SECONDS = 3600;

    const DEFAULT_THEME = 'dark';

    // true = skip a refresh while any row checkbox is ticked.
    const SKIP_RELOAD_IF_CHECKED = true;

    const NOTIFICATION_TAG = 'kapoyqc-new-proofs';
    const NOTIFICATION_SECONDS = 6;
    const NOTIFICATION_STAYS_UNTIL_DISMISSED = false;

    const NOTIFICATION_SOUND = true;
    const NOTIFICATION_SOUND_VOLUME = 0.2;

    // true  = refresh the table in the background (no page reload).
    // false = full page reload.
    const USE_BACKGROUND_REFRESH = true;
    const REFRESH_TIMEOUT_MS = 20000;

    // Forget "already notified" proofs not on the page for this many days.
    const SEEN_MAX_DAYS = 7;

    // Storage: everything except the two fast-changing lists lives in ONE
    // settings object.
    const SETTINGS_KEY = 'KapoyQC_Settings';
    const SEEN_KEY = 'KapoyQC_Seen';
    const ASSIGNED_KEY = 'KapoyQC_Assigned';

    const LEGACY_KEYS = {
        seen: 'Qchonon_Seen_Proofs',
        seenInit: 'Qchonon_Seen_Initialized',
        position: 'Qchonon_Panel_Position',
        theme: 'Qchonon_Theme',
        collapsed: 'Qchonon_Panel_Collapsed',
        reload: 'Qchonon_Reload_Seconds',
        auto: 'Qchonon_Auto_Reload',
        assigned: 'Qchonon_Assigned_Today',
        allTime: 'Qchonon_Assigned_AllTime',
        das: 'Qchonon_DA_Names',
        oldHistory: 'Qchonon_Assigned_History'
    };

    const LEVELS = [
        {
            name: 'low',
            min: 0,
            max: 3,
            color: '#2e7d32',
            darkColor: '#66bb6a',
            message: (n) => n === 0
                ? 'Showing 0 Proof. Clear na tanan, kape sa ta!'
                : `Showing ${n} ${n === 1 ? 'Proof' : 'Proofs'}. Gamay ra ni, kaya na!`
        },
        {
            name: 'medium',
            min: 4,
            max: 9,
            color: '#e08a00',
            darkColor: '#ffb74d',
            message: (n) => `Showing ${n} Proofs. Padayon lang, naa na tay ritmo!`
        },
        {
            name: 'high',
            min: 10,
            max: Infinity,
            color: '#c62828',
            darkColor: '#ef5350',
            message: (n) => `Showing ${n} Proofs. Daghan kaayo, kusog-kusog!`
        }
    ];

    // ============================================================
    // STORAGE + SETTINGS (one object, old Qchonon_* keys migrated once)
    // ============================================================

    function readStorage(key) {
        try {
            return localStorage.getItem(key);
        } catch (error) {
            return null;
        }
    }

    function writeStorage(key, value) {
        try {
            localStorage.setItem(key, value);
        } catch (error) {
            console.error('[Kapoy QC] Failed to save:', key, error);
        }
    }

    function removeStorage(key) {
        try {
            localStorage.removeItem(key);
        } catch (error) {
            // ignore
        }
    }

    function parseJSON(text) {
        try {
            return JSON.parse(text);
        } catch (error) {
            return null;
        }
    }

    function clampSeconds(value) {
        const n = parseInt(value, 10);

        if (Number.isNaN(n)) {
            return DEFAULT_RELOAD_SECONDS;
        }

        return Math.max(MIN_RELOAD_SECONDS, Math.min(MAX_RELOAD_SECONDS, n));
    }

    function defaultSettings() {
        return {
            theme: DEFAULT_THEME,
            reloadSeconds: DEFAULT_RELOAD_SECONDS,
            auto: true,
            collapsed: false,
            position: null,
            daNames: null,
            seenInit: false
        };
    }

    // One-time move from the old separate keys to the new ones.
    function migrateLegacy() {
        if (readStorage(SETTINGS_KEY) !== null) {
            return;
        }

        const hasLegacy = Object.keys(LEGACY_KEYS)
            .some((name) => readStorage(LEGACY_KEYS[name]) !== null);

        if (!hasLegacy) {
            return;
        }

        const s = defaultSettings();
        const theme = readStorage(LEGACY_KEYS.theme);
        const reload = readStorage(LEGACY_KEYS.reload);
        const position = parseJSON(readStorage(LEGACY_KEYS.position));
        const das = parseJSON(readStorage(LEGACY_KEYS.das));

        if (theme === 'light' || theme === 'dark') {
            s.theme = theme;
        }

        if (reload) {
            s.reloadSeconds = clampSeconds(reload);
        }

        s.auto = readStorage(LEGACY_KEYS.auto) !== 'off';
        s.collapsed = readStorage(LEGACY_KEYS.collapsed) === 'yes';
        s.seenInit = readStorage(LEGACY_KEYS.seenInit) === 'yes';

        if (position && typeof position.left === 'number' && typeof position.top === 'number') {
            s.position = { left: position.left, top: position.top };
        }

        if (Array.isArray(das) && das.length) {
            s.daNames = das;
        }

        writeStorage(SETTINGS_KEY, JSON.stringify(s));

        const seen = readStorage(LEGACY_KEYS.seen);
        const assignedOld = readStorage(LEGACY_KEYS.assigned);

        if (seen !== null && readStorage(SEEN_KEY) === null) {
            writeStorage(SEEN_KEY, seen);
        }

        if (assignedOld !== null && readStorage(ASSIGNED_KEY) === null) {
            writeStorage(ASSIGNED_KEY, assignedOld);
        }

        Object.keys(LEGACY_KEYS).forEach((name) => removeStorage(LEGACY_KEYS[name]));
    }

    function loadSettings() {
        const parsed = parseJSON(readStorage(SETTINGS_KEY));
        const s = defaultSettings();

        if (parsed && typeof parsed === 'object') {
            if (parsed.theme === 'light' || parsed.theme === 'dark') {
                s.theme = parsed.theme;
            }

            if (parsed.reloadSeconds) {
                s.reloadSeconds = clampSeconds(parsed.reloadSeconds);
            }

            s.auto = parsed.auto !== false;
            s.collapsed = parsed.collapsed === true;
            s.seenInit = parsed.seenInit === true;

            if (parsed.position && typeof parsed.position.left === 'number' &&
                typeof parsed.position.top === 'number') {
                s.position = parsed.position;
            }

            if (Array.isArray(parsed.daNames) && parsed.daNames.length) {
                s.daNames = parsed.daNames;
            }
        }

        return s;
    }

    migrateLegacy();

    const settings = loadSettings();

    function saveSettings() {
        writeStorage(SETTINGS_KEY, JSON.stringify(settings));
    }

    // ============================================================
    // THEME (page + panel styles, injected immediately to avoid flashing)
    // ============================================================

    const FONT_STACK = "'Segoe UI Variable Text', 'Segoe UI', system-ui, -apple-system, Roboto, 'Helvetica Neue', Arial, sans-serif";

    // Page rules only apply to the page, never to the Kapoy QC panel.
    const PAGE = 'html.q-dark body > :not(#kqc-panel)';

    function within(list) {
        return list.map((s) => `${PAGE} ${s}`).join(',\n');
    }

    // Like within(), but for BOTH themes (used for the unified controls)
    const ANY = 'html:root body > :not(#kqc-panel)';

    function ui(list) {
        return list.map((s) => `${ANY} ${s}`).join(',\n');
    }

    function buildCss() {
        const transparentBg = [
            'html.q-dark body > div:not(#kqc-panel)',
            within(['div', 'form', 'fieldset', 'section', 'footer'])
        ].join(',\n');

        const textTags = within([
            'div:not(.warning)', 'span', 'td', 'th', 'label', 'p',
            'h1', 'h2', 'h3', 'h4', 'li', 'b', 'strong', 'font'
        ]);

        const fields = within([
            'input[type="text"]', 'input[type="number"]', 'input[type="search"]',
            'input:not([type])', 'textarea', 'select'
        ]);

        const buttons = within([
            'input[type="submit"]', 'input[type="button"]', 'button'
        ]);

        return `
/* ---------- PAGE: dark theme ---------- */
html.q-dark { color-scheme: dark; }
html.q-dark,
html.q-dark body { background: #121212 !important; color: #e6e6e6 !important; }

${transparentBg} { background: transparent !important; }

${textTags} { color: #e6e6e6 !important; }

${within(['a', 'a:visited'])} { color: #6db3ff !important; }

${within(['div', 'form', 'fieldset', 'table', 'td', 'th'])} { border-color: #444 !important; }

${fields} {
    background: #232323 !important;
    color: #e6e6e6 !important;
    border: 1px solid #555 !important;
}

${buttons} {
    background: #333 !important;
    color: #e6e6e6 !important;
    border: 1px solid #555 !important;
}

${within(['img'])} { filter: invert(1) hue-rotate(180deg); }
/* Proof thumbnails/artwork in the results keep their real colors */
html.q-dark #resultTable img { filter: none !important; }

/* Rows stay hidden until the DA filter has run (no flash of other DAs) */
html.q-pending #resultTable tbody tr { visibility: hidden !important; }

html.q-dark #resultTable tbody tr,
html.q-dark #resultTable tbody tr td { background: #1b1b1b !important; }
html.q-dark #resultTable tbody tr td { border-bottom: 1px solid #2e2e2e !important; }
html.q-dark #resultTable tbody tr:hover,
html.q-dark #resultTable tbody tr:hover td { background: #272727 !important; }

/* ---------- FONTS (both themes, scoped to the table, forms, nav, message) ---------- */
html:root body { font-family: ${FONT_STACK} !important; }
html:root #resultTable, html:root #resultTable *,
html:root form, html:root form *,
html:root #nav, html:root #nav *,
html:root div.warning {
    font-family: ${FONT_STACK} !important;
    -webkit-font-smoothing: antialiased;
    text-rendering: optimizeLegibility;
}
html:root #resultTable tbody td { line-height: 1.4; }
html:root #resultTable th { font-weight: 600; letter-spacing: 0.1px; }
html:root div.warning { font-weight: 600; }

/* ---------- LINK BUTTONS (both themes) ---------- */
html {
    --ql-fg: #1a5fd0; --ql-bg: #eaf2ff; --ql-border: #bfd5fa; --ql-hover-bg: #d7e6ff;
    --ql-primary-bg: #1a6ef0; --ql-primary-hover: #0f58cc; --ql-primary-fg: #ffffff;
}
html.q-dark {
    --ql-fg: #8cc2ff; --ql-bg: #1d2a40; --ql-border: #2f4466; --ql-hover-bg: #28395a;
    --ql-primary-bg: #2f7df6; --ql-primary-hover: #4a90ff; --ql-primary-fg: #ffffff;
}
html:root #resultTable tbody td a,
html:root #resultTable tbody td a:visited {
    display: inline-block;
    padding: 3px 9px;
    border: 1px solid var(--ql-border) !important;
    border-radius: 6px;
    background: var(--ql-bg) !important;
    color: var(--ql-fg) !important;
    text-decoration: none !important;
    font-weight: 500;
    line-height: 1.4;
    white-space: nowrap;
    cursor: pointer;
    transition: background 0.15s, border-color 0.15s, transform 0.05s;
}
html:root #resultTable tbody td a:hover { background: var(--ql-hover-bg) !important; }
html:root #resultTable tbody td a:active { transform: translateY(1px); }

/* "assign to me" = primary button */
html:root #resultTable tbody td a.q-assign,
html:root #resultTable tbody td a.q-assign:visited {
    background: var(--ql-primary-bg) !important;
    border-color: var(--ql-primary-bg) !important;
    color: var(--ql-primary-fg) !important;
    font-weight: 600;
    padding: 4px 12px;
}
html:root #resultTable tbody td a.q-assign:hover {
    background: var(--ql-primary-hover) !important;
    border-color: var(--ql-primary-hover) !important;
}

/* Row you already clicked "assign to me" on (this page session) */
html:root #resultTable tbody tr.q-clicked { opacity: 0.55; }
html:root #resultTable tbody tr.q-clicked:hover { opacity: 0.85; }

/* ---------- DA / QUEUE COLORS ---------- */
html:root #resultTable tbody tr.q-colored td:first-child {
    box-shadow: inset 5px 0 0 var(--q-da);
}
html:root #resultTable tbody tr.q-colored td {
    background-image: linear-gradient(0deg, color-mix(in srgb, var(--q-da) 10%, transparent), color-mix(in srgb, var(--q-da) 10%, transparent)) !important;
}
html:root #resultTable tbody tr.q-colored:hover td {
    background-image: linear-gradient(0deg, color-mix(in srgb, var(--q-da) 20%, transparent), color-mix(in srgb, var(--q-da) 20%, transparent)) !important;
}
html:root #resultTable tbody td.q-queue-cell {
    font-weight: 600;
    color: var(--q-queue) !important;
}

/* ---------- PANEL ---------- */
#kqc-panel {
    --q-bg: #171717; --q-head: #202020; --q-text: #f5f5f5; --q-muted: #999;
    --q-border: #333; --q-row: #292929; --q-green: #8ee09b; --q-amber: #f2c66d;
    --q-chip-bg: #473b24; --q-chip-zero-bg: #2a2a2a; --q-chip-zero: #888;
    --q-input-bg: #101010; --q-input-border: #444; --q-shadow: rgba(0,0,0,0.45);
    color-scheme: dark;
    position: fixed;
    top: 80px;
    right: 25px;
    width: 290px;
    z-index: 999999;
    background: var(--q-bg);
    color: var(--q-text);
    border: 1px solid var(--q-border);
    border-radius: 10px;
    box-shadow: 0 8px 30px var(--q-shadow);
    font-family: ${FONT_STACK};
    font-size: 12px;
    overflow: hidden;
}
#kqc-panel.q-light {
    --q-bg: #ffffff; --q-head: #f1f1f1; --q-text: #1b1b1b; --q-muted: #666;
    --q-border: #d6d6d6; --q-row: #eeeeee; --q-green: #2e7d32; --q-amber: #b26a00;
    --q-chip-bg: #fff0cf; --q-chip-zero-bg: #eeeeee; --q-chip-zero: #888;
    --q-input-bg: #ffffff; --q-input-border: #bbb; --q-shadow: rgba(0,0,0,0.2);
    color-scheme: light;
}
#kqc-panel .q-head {
    padding: 10px 12px;
    background: var(--q-head);
    border-bottom: 1px solid var(--q-border);
    font-size: 14px;
    font-weight: 700;
    display: flex;
    justify-content: space-between;
    align-items: center;
    cursor: move;
    user-select: none;
    touch-action: none;
}
#kqc-panel .q-grip { color: var(--q-muted); font-size: 18px; letter-spacing: -3px; }
#kqc-panel .q-tools { display: inline-flex; align-items: center; gap: 8px; }
#kqc-panel button#q-collapse,
#kqc-panel button#q-settings-btn {
    width: 22px;
    height: 22px;
    padding: 0;
    background: transparent;
    color: var(--q-muted);
    border: 1px solid var(--q-border);
    border-radius: 5px;
    font-size: 12px;
    line-height: 1;
    cursor: pointer;
}
#kqc-panel button#q-collapse:hover,
#kqc-panel button#q-settings-btn:hover { color: var(--q-text); border-color: var(--q-muted); }
#kqc-panel button#q-settings-btn.q-on { color: var(--q-text); border-color: var(--q-amber); }
#kqc-panel.q-collapsed .q-body { display: none; }
#kqc-panel.q-collapsed .q-head { border-bottom: none; }
#kqc-panel .q-body { padding: 10px 12px 12px; }
#kqc-panel .q-label {
    margin: 0 0 6px;
    color: var(--q-muted);
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.8px;
}
#kqc-panel .q-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 4px 0;
}
#kqc-panel .q-reload strong { font-size: 15px; color: var(--q-green); }
#kqc-panel .q-reload strong.paused { color: var(--q-amber); font-size: 12px; }
#kqc-panel .q-last { color: var(--q-muted); font-size: 11px; padding-bottom: 8px; }
#kqc-panel .q-divider { height: 1px; margin: 6px 0 10px; background: var(--q-border); }
#kqc-panel .q-da {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 6px 0 6px 8px;
    border-bottom: 1px solid var(--q-row);
    border-left: 3px solid var(--q-rowcolor, transparent);
}
#kqc-panel .q-da:last-child { border-bottom: none; }
#kqc-panel .q-da > span:first-child,
#kqc-panel .q-da > strong {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
}
#kqc-panel .q-chips { flex: 0 0 auto; margin-left: 8px; }
#kqc-panel .q-label,
#kqc-panel .q-label-row span,
#kqc-panel .q-row,
#kqc-panel .q-last,
#kqc-panel .q-foot { white-space: nowrap; }
#kqc-panel .q-da > span:first-child::before,
#kqc-panel .q-da > strong::before {
    content: '';
    display: inline-block;
    width: 8px;
    height: 8px;
    margin-right: 7px;
    border-radius: 50%;
    background: var(--q-rowcolor, transparent);
}
#kqc-panel .q-count {
    min-width: 22px;
    padding: 2px 7px;
    border-radius: 4px;
    background: var(--q-chip-bg);
    color: var(--q-amber);
    font-weight: 700;
    text-align: center;
}
#kqc-panel .q-count.zero { background: var(--q-chip-zero-bg); color: var(--q-chip-zero); }
#kqc-panel .q-chips { display: inline-flex; align-items: center; gap: 6px; }
#kqc-panel .q-count.q-assigned,
#kqc-panel .q-count.q-tot {
    background: color-mix(in srgb, var(--q-green) 18%, transparent);
    color: var(--q-green);
}
#kqc-panel .q-count.q-assigned.zero,
#kqc-panel .q-count.q-tot.zero { background: var(--q-chip-zero-bg); color: var(--q-chip-zero); }
#kqc-panel .q-da .q-count.q-show:not(.zero),
#kqc-panel .q-da .q-count.q-assigned:not(.zero) {
    background: color-mix(in srgb, var(--q-rowcolor) 22%, transparent);
    color: var(--q-rowcolor);
}
#kqc-panel .q-label-row { display: flex; justify-content: space-between; align-items: center; }
#kqc-panel .q-label-row span:last-child { font-size: 9px; letter-spacing: 0.4px; }
#kqc-panel .q-foot {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-top: 8px;
    padding-top: 8px;
    border-top: 1px solid var(--q-border);
    color: var(--q-muted);
    font-size: 11px;
}
#kqc-panel .q-foot-btns { display: inline-flex; gap: 6px; }
#kqc-panel button.q-btn {
    padding: 2px 9px;
    background: transparent;
    color: var(--q-muted);
    border: 1px solid var(--q-border);
    border-radius: 5px;
    font-size: 11px;
    cursor: pointer;
}
#kqc-panel button.q-btn:hover { color: var(--q-text); border-color: var(--q-muted); }
#kqc-panel button.q-btn.q-danger:hover { color: #ef5350; border-color: #ef5350; }

#kqc-panel [hidden] { display: none !important; }
#kqc-panel button.q-mini { margin-left: 6px; padding: 0 7px; font-size: 10px; letter-spacing: 0; }
#kqc-panel button.q-save { color: var(--q-green); border-color: var(--q-green); }
#kqc-panel textarea {
    box-sizing: border-box;
    width: 100%;
    padding: 6px 8px;
    background: var(--q-input-bg);
    color: var(--q-text);
    border: 1px solid var(--q-input-border);
    border-radius: 5px;
    font-family: inherit;
    font-size: 12px;
    line-height: 1.5;
    resize: vertical;
}
#kqc-panel textarea:focus { outline: none; border-color: var(--q-amber); }
#kqc-panel .q-note { margin: 4px 0 6px; color: var(--q-muted); font-size: 10px; }
#kqc-panel .q-editor-btns { justify-content: flex-end; width: 100%; }

#kqc-panel input,
#kqc-panel button { font-family: inherit; }
#kqc-panel .q-count,
#kqc-panel #q-countdown,
#kqc-panel input.q-number { font-variant-numeric: tabular-nums; }
#kqc-panel .q-interval {
    display: inline-flex;
    align-items: center;
    gap: 5px;
}
#kqc-panel input.q-number {
    box-sizing: border-box;
    width: 58px;
    height: 24px;
    padding: 2px 6px;
    background: var(--q-input-bg);
    color: var(--q-text);
    border: 1px solid var(--q-input-border);
    border-radius: 5px;
    font-size: 12px;
    text-align: center;
}
#kqc-panel input.q-number:focus { outline: none; border-color: var(--q-amber); }

#kqc-panel .q-switch { position: relative; display: inline-block; width: 38px; height: 20px; margin: 0; }
#kqc-panel .q-switch input { opacity: 0; width: 0; height: 0; position: absolute; }
#kqc-panel .q-slider {
    position: absolute;
    inset: 0;
    background: #b5b5b5;
    border-radius: 20px;
    cursor: pointer;
    transition: background 0.2s;
}
#kqc-panel .q-slider::before {
    content: '';
    position: absolute;
    width: 14px;
    height: 14px;
    left: 3px;
    top: 3px;
    background: #fff;
    border-radius: 50%;
    transition: transform 0.2s;
}
#kqc-panel .q-switch input:checked + .q-slider { background: #4f8cff; }
#kqc-panel .q-switch input:checked + .q-slider::before { transform: translateX(18px); }

/* ---------- UNIFIED CONTROLS (both themes) ---------- */
html {
    --qf-bg: #ffffff; --qf-fg: #1b1b1b; --qf-muted: #6b7280;
    --qf-arrow: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 12 8'%3E%3Cpath d='M1 1l5 5 5-5' fill='none' stroke='%231a5fd0' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
    --qf-focus: rgba(26,110,240,0.35);
}
html.q-dark {
    --qf-bg: #1f2430; --qf-fg: #e6e6e6; --qf-muted: #9aa4b2;
    --qf-arrow: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 12 8'%3E%3Cpath d='M1 1l5 5 5-5' fill='none' stroke='%238cc2ff' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
    --qf-focus: rgba(47,125,246,0.45);
}

/* Buttons: Filter, Search, Submit, etc. = same primary button as "assign to me" */
${ui([
    'input[type="submit"]', 'input[type="button"]', 'input[type="reset"]',
    'button', 'a.button', 'a.btn'
])} {
    -webkit-appearance: none;
    appearance: none;
    display: inline-block;
    padding: 5px 14px !important;
    border: 1px solid var(--ql-primary-bg) !important;
    border-radius: 6px !important;
    background: var(--ql-primary-bg) !important;
    background-image: none !important;
    color: var(--ql-primary-fg) !important;
    font-size: 13px;
    font-weight: 600;
    line-height: 1.4;
    text-shadow: none !important;
    box-shadow: none !important;
    cursor: pointer;
    transition: background 0.15s, border-color 0.15s, transform 0.05s;
}
${ui([
    'input[type="submit"]:hover', 'input[type="button"]:hover',
    'input[type="reset"]:hover', 'button:hover', 'a.button:hover', 'a.btn:hover'
])} {
    background: var(--ql-primary-hover) !important;
    border-color: var(--ql-primary-hover) !important;
}
${ui([
    'input[type="submit"]:active', 'input[type="button"]:active', 'button:active'
])} { transform: translateY(1px); }

/* Top navigation tabs */
${ui([
    '#nav a', '.nav a', 'ul.tabs a', '.tabs a', '.tab a', 'a.tab', 'td.tab a'
])} {
    display: inline-block;
    padding: 4px 10px;
    border: 1px solid var(--ql-border) !important;
    border-radius: 6px;
    background: var(--ql-bg) !important;
    color: var(--ql-fg) !important;
    text-decoration: none !important;
    font-weight: 500;
}
${ui(['#nav a:hover', '.nav a:hover', 'ul.tabs a:hover', '.tabs a:hover', '.tab a:hover', 'a.tab:hover'])} {
    background: var(--ql-hover-bg) !important;
}
${ui([
    '#nav .current a', '#nav a.current', '.nav .active a', '.nav a.active',
    '.tabs .selected a', '.tabs a.selected', '.tabs .current a', 'a.tab.active', 'a.tab.current'
])} {
    background: var(--ql-primary-bg) !important;
    border-color: var(--ql-primary-bg) !important;
    color: var(--ql-primary-fg) !important;
    font-weight: 600;
}

/* Text fields */
${ui([
    'input[type="text"]', 'input[type="number"]', 'input[type="search"]',
    'input[type="email"]', 'input[type="password"]', 'input:not([type])', 'textarea'
])} {
    padding: 5px 9px;
    border: 1px solid var(--ql-border) !important;
    border-radius: 6px !important;
    background: var(--qf-bg) !important;
    color: var(--qf-fg) !important;
    font-size: 13px;
    box-shadow: none !important;
    transition: border-color 0.15s, box-shadow 0.15s;
}
${ui(['input::placeholder', 'textarea::placeholder'])} { color: var(--qf-muted) !important; opacity: 1; }

/* Dropdowns (native select) */
${ui(['select:not([multiple]):not([size])'])} {
    -webkit-appearance: none;
    appearance: none;
    padding: 5px 30px 5px 10px;
    border: 1px solid var(--ql-border) !important;
    border-radius: 6px !important;
    background-color: var(--qf-bg) !important;
    background-image: var(--qf-arrow) !important;
    background-repeat: no-repeat !important;
    background-position: right 10px center !important;
    background-size: 11px !important;
    color: var(--qf-fg) !important;
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    box-shadow: none !important;
}
${ui(['select option', 'select optgroup'])} {
    background: var(--qf-bg) !important;
    color: var(--qf-fg) !important;
}

/* Multi-select / list box (the State list) */
${ui(['select[multiple]', 'select[size]'])} {
    padding: 4px;
    border: 1px solid var(--ql-border) !important;
    border-radius: 6px !important;
    background: var(--qf-bg) !important;
    color: var(--qf-fg) !important;
    font-size: 13px;
}
${ui(['select[multiple] option', 'select[size] option'])} { padding: 3px 8px; border-radius: 4px; }
${ui(['select[multiple] option:checked', 'select[size] option:checked'])} {
    background: var(--ql-primary-bg) linear-gradient(0deg, var(--ql-primary-bg), var(--ql-primary-bg)) !important;
    color: var(--ql-primary-fg) !important;
}

/* select2 / chosen / jQuery UI dropdown widgets */
${ui([
    '.select2-container .select2-selection',
    '.select2-container--default .select2-selection--single',
    '.select2-container--default .select2-selection--multiple',
    '.chosen-container-single .chosen-single',
    '.chosen-container-multi .chosen-choices',
    '.ui-selectmenu-button', '.ui-autocomplete-input'
])} {
    min-height: 28px;
    border: 1px solid var(--ql-border) !important;
    border-radius: 6px !important;
    background: var(--qf-bg) !important;
    background-image: none !important;
    color: var(--qf-fg) !important;
    box-shadow: none !important;
}
${ui([
    '.select2-selection__rendered', '.select2-selection__placeholder',
    '.chosen-single span', '.chosen-container .chosen-default',
    '.ui-selectmenu-text'
])} { color: var(--qf-fg) !important; opacity: 1 !important; }
${ui(['.select2-selection__placeholder', '.chosen-default'])} { color: var(--qf-muted) !important; }

${ui([
    '.select2-dropdown', '.chosen-drop', 'ul.ui-menu', '.ui-selectmenu-menu .ui-menu'
])} {
    background: var(--qf-bg) !important;
    border: 1px solid var(--ql-border) !important;
    border-radius: 6px !important;
    color: var(--qf-fg) !important;
}
${ui([
    '.select2-results__option', '.chosen-results li', '.ui-menu-item',
    '.ui-menu-item-wrapper'
])} { color: var(--qf-fg) !important; background: transparent !important; }
${ui([
    '.select2-results__option--highlighted', '.select2-results__option[aria-selected="true"]',
    '.chosen-results li.highlighted', '.ui-state-active', '.ui-state-focus',
    '.ui-menu-item-wrapper.ui-state-active'
])} {
    background: var(--ql-primary-bg) !important;
    color: var(--ql-primary-fg) !important;
    border: 0 !important;
}

${ui(['select:disabled', 'input:disabled', 'button:disabled', '.select2-container--disabled .select2-selection'])} {
    opacity: 0.6;
    cursor: not-allowed;
}

${ui([
    'input[type="text"]:focus', 'input[type="number"]:focus', 'input[type="search"]:focus',
    'input:not([type]):focus', 'textarea:focus', 'select:focus', 'button:focus-visible'
])} {
    outline: none !important;
    border-color: var(--ql-primary-bg) !important;
    box-shadow: 0 0 0 3px var(--qf-focus) !important;
}

${ui(['input[type="checkbox"]', 'input[type="radio"]'])} {
    accent-color: var(--ql-primary-bg);
    cursor: pointer;
}
`;
    }

    function injectStyles() {
        const style = document.createElement('style');

        style.id = 'kqc-styles';
        style.textContent = buildCss();

        (document.head || document.documentElement).appendChild(style);
    }

    function applyTheme() {
        document.documentElement.classList.toggle('q-dark', settings.theme === 'dark');

        const panel = document.getElementById('kqc-panel');

        if (panel) {
            panel.classList.toggle('q-light', settings.theme === 'light');
        }

        const toggle = document.getElementById('q-theme');
        const label = document.getElementById('q-theme-label');

        if (toggle) {
            toggle.checked = settings.theme === 'dark';
        }

        if (label) {
            label.textContent = settings.theme === 'dark' ? 'Dark' : 'Light';
        }
    }

    injectStyles();
    applyTheme();

    // Hide table rows until filtering has run (safety timer included).
    document.documentElement.classList.add('q-pending');
    setTimeout(function () {
        document.documentElement.classList.remove('q-pending');
    }, 4000);

    // ============================================================
    // HELPERS
    // ============================================================

    function normalize(text) {
        return String(text || '').replace(/\s+/g, ' ').trim();
    }

    function cleanNames(list) {
        const seen = new Set();
        const out = [];

        list.forEach((raw) => {
            const name = normalize(raw);
            const key = name.toLowerCase();

            if (name && !seen.has(key)) {
                seen.add(key);
                out.push(name);
            }
        });

        return out;
    }

    function loadDANames() {
        if (Array.isArray(settings.daNames)) {
            const clean = cleanNames(settings.daNames);

            if (clean.length) {
                return clean;
            }
        }

        return cleanNames(ALLOWED_DAS);
    }

    let currentDAs = loadDANames();

    function buildAllowedMap() {
        return new Map(currentDAs.map((name) => [name.toLowerCase(), name]));
    }

    let allowedLower = buildAllowedMap();

    // ---- Columns: found by header text, constants are the fallback ----
    let COLS = { proof: COL_PROOF, queue: COL_QUEUE, state: COL_STATE, da: DA_COLUMNS.slice() };
    let columnsLogged = false;

    function detectColumns() {
        const $table = $('#resultTable');
        const headRow = $table.find('tr').filter(function () {
            return $(this).children('th').length > 0;
        }).first();
        const firstDataRow = $table.find('tbody tr').filter(function () {
            return $(this).children('td').length > 0;
        }).first();

        if (!headRow.length) {
            return;
        }

        const heads = headRow.children('th, td').toArray()
            .map((cell) => normalize(cell.textContent));

        // If the header and the data rows do not line up, trust the constants.
        if (firstDataRow.length && firstDataRow.children('td').length !== heads.length) {
            return;
        }

        const found = { proof: 0, queue: 0, state: 0, da: [] };

        heads.forEach((text, index) => {
            const col = index + 1;

            if (!found.proof && HEADER_PATTERNS.proof.test(text)) {
                found.proof = col;
            } else if (!found.queue && HEADER_PATTERNS.queue.test(text)) {
                found.queue = col;
            } else if (!found.state && HEADER_PATTERNS.state.test(text)) {
                found.state = col;
            } else if (HEADER_PATTERNS.da.some((re) => re.test(text))) {
                found.da.push(col);
            }
        });

        COLS = {
            proof: found.proof || COL_PROOF,
            queue: found.queue || COL_QUEUE,
            state: found.state || COL_STATE,
            da: found.da.length ? found.da : DA_COLUMNS.slice()
        };

        if (!columnsLogged) {
            columnsLogged = true;
            console.log('[Kapoy QC] Columns in use:', COLS);
        }
    }

    function cellText($row, column) {
        return normalize($row.children(`td:nth-child(${column})`).text());
    }

    function getMatchedDA($row) {
        for (const column of COLS.da) {
            const text = cellText($row, column);
            const match = allowedLower.get(text.toLowerCase());

            if (match) {
                return match;
            }
        }

        return '';
    }

    function getQueueName($row) {
        const text = cellText($row, COLS.queue).toLowerCase();

        return QUEUE_TYPES.find((name) => text.includes(name.toLowerCase())) || '';
    }

    function daColor(name) {
        const i = currentDAs.indexOf(name);

        return DA_COLORS[(i < 0 ? 0 : i) % DA_COLORS.length];
    }

    function queueColor(name) {
        return QUEUE_COLORS[name] || QUEUE_FALLBACK_COLOR;
    }

    // ============================================================
    // SEEN PROOFS (so each proof notifies only once)
    // ============================================================

    let seenProofs = loadSeen();

    function pruneSeen(map) {
        const cutoff = Date.now() - SEEN_MAX_DAYS * 24 * 60 * 60 * 1000;

        Object.keys(map).forEach((id) => {
            if (Number(map[id]) < cutoff) {
                delete map[id];
            }
        });

        return map;
    }

    function loadSeen() {
        const parsed = parseJSON(readStorage(SEEN_KEY));

        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            return {};
        }

        return pruneSeen(parsed);
    }

    // Pruned on every save, so a tab that stays open for days stays small.
    function saveSeen() {
        pruneSeen(seenProofs);
        writeStorage(SEEN_KEY, JSON.stringify(seenProofs));
    }

    // ============================================================
    // ASSIGNED TRACKER (+1 on the DA when you click "assign to me")
    // ============================================================
    // EVERY "assign to me" click counts (duplicates included): the total and
    // the per-DA count go up by 1. Numbers start fresh every new day.
    // Shape: { date: 'YYYY-MM-DD', byDA: { name: count }, total: number }

    // Proofs you clicked "assign to me" on during this page session (row is dimmed).
    const clickedProofs = new Set();

    function todayKey() {
        const d = new Date();

        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }

    function newAssignedRecord() {
        return { date: todayKey(), byDA: {}, total: 0 };
    }

    function countOf(value) {
        if (Array.isArray(value)) {
            return value.length;
        }

        return Number(value) || 0;
    }

    function loadAssigned() {
        const parsed = parseJSON(readStorage(ASSIGNED_KEY));

        if (parsed && parsed.byDA && typeof parsed.byDA === 'object') {
            if (parsed.date === todayKey()) {
                // Old records stored lists of proof IDs: turn them into counts.
                Object.keys(parsed.byDA).forEach((name) => {
                    parsed.byDA[name] = countOf(parsed.byDA[name]);
                });

                if (typeof parsed.total !== 'number') {
                    parsed.total = Object.keys(parsed.byDA)
                        .reduce((sum, name) => sum + parsed.byDA[name], 0);
                }

                return { date: parsed.date, byDA: parsed.byDA, total: parsed.total };
            }

            // A new day started: today's numbers start from 0.
            const fresh = newAssignedRecord();

            writeStorage(ASSIGNED_KEY, JSON.stringify(fresh));

            return fresh;
        }

        return newAssignedRecord();
    }

    let assigned = loadAssigned();

    function saveAssigned() {
        writeStorage(ASSIGNED_KEY, JSON.stringify(assigned));
    }

    function assignedCount(name) {
        return countOf(assigned.byDA[name]);
    }

    function renderAssigned() {
        document.querySelectorAll('#kqc-panel .q-assigned').forEach((el) => {
            const n = assignedCount(el.dataset.da);

            el.textContent = n;
            el.classList.toggle('zero', n === 0);
        });

        const todayEl = document.getElementById('q-total-today');

        if (todayEl) {
            todayEl.textContent = assigned.total;
            todayEl.classList.toggle('zero', assigned.total === 0);
        }
    }

    function trackAssign($link) {
        // Re-read so several tabs / a day change stay in sync.
        assigned = loadAssigned();

        const $row = $link.closest('tr');
        const proofID = cellText($row, COLS.proof);

        if (!proofID) {
            console.warn('[Kapoy QC] Assign clicked but no proof ID found.');
            return;
        }

        assigned.total++;

        const daName = getMatchedDA($row);

        if (daName) {
            assigned.byDA[daName] = assignedCount(daName) + 1;
        }

        saveAssigned();
        renderAssigned();

        // Make the click visible, so an accidental double click is easy to spot.
        clickedProofs.add(proofID);
        $row.addClass('q-clicked');
    }

    function setupAssignTracking() {
        // Capture phase on document: runs before the site's own handlers.
        function handle(event) {
            if (event.type === 'click' && event.button !== 0) {
                return;
            }

            if (event.type === 'auxclick' && event.button !== 1) {
                return;
            }

            const link = event.target && event.target.closest
                ? event.target.closest('#resultTable a')
                : null;

            if (!link || normalize(link.textContent).toLowerCase() !== 'assign to me') {
                return;
            }

            trackAssign($(link));
        }

        document.addEventListener('click', handle, true);
        document.addEventListener('auxclick', handle, true);
    }

    function setupAssignedReset() {
        document.getElementById('q-reset-assigned').addEventListener('click', function () {
            if (!window.confirm("Reset today's assigned counts to 0?")) {
                return;
            }

            assigned = newAssignedRecord();

            saveAssigned();
            renderAssigned();
        });
    }

    // Other tabs changed something: keep this tab in sync.
    function setupStorageSync() {
        window.addEventListener('storage', function (event) {
            if (event.key === ASSIGNED_KEY) {
                assigned = loadAssigned();
                renderAssigned();
            } else if (event.key === SEEN_KEY) {
                // Another tab already notified these proofs.
                seenProofs = Object.assign(loadSeen(), seenProofs, loadSeen());
            }
        });
    }

    // ============================================================
    // FILTER + COLOR + COUNT (ONE pass over the rows, no :visible queries)
    // ============================================================

    let tableStats = { total: 0, byDA: {} };

    function applyTable() {
        const stats = { total: 0, byDA: {} };

        currentDAs.forEach((name) => {
            stats.byDA[name] = 0;
        });

        $('#resultTable tbody tr').each(function () {
            const $row = $(this);

            if (!$row.children('td').length) {
                return;
            }

            const da = getMatchedDA($row);

            $row.toggle(Boolean(da));

            if (da) {
                stats.total++;
                stats.byDA[da]++;

                $row[0].style.setProperty('--q-da', daColor(da));
                $row.addClass('q-colored');
            } else {
                $row.removeClass('q-colored');
            }

            const queue = getQueueName($row);
            const $queueCell = $row.children(`td:nth-child(${COLS.queue})`);

            if (queue && $queueCell.length) {
                $queueCell[0].style.setProperty('--q-queue', queueColor(queue));
                $queueCell.addClass('q-queue-cell');
            } else {
                $queueCell.removeClass('q-queue-cell');
            }

            $row.toggleClass('q-clicked', clickedProofs.has(cellText($row, COLS.proof)));
        });

        tableStats = stats;
    }

    function updateCount() {
        const count = tableStats.total;

        const level = LEVELS.find(
            (item) => count >= item.min && count <= item.max
        ) || LEVELS[LEVELS.length - 1];

        $('div.warning')
            .text(level.message(count))
            .css('color', settings.theme === 'dark' ? level.darkColor : level.color);
    }

    function renderDACounts() {
        document.querySelectorAll('#kqc-panel .q-show').forEach((el) => {
            const n = tableStats.byDA[el.dataset.da] || 0;

            el.textContent = n;
            el.classList.toggle('zero', n === 0);
        });
    }

    // Make every "assign to me" link open in a new tab.
    function openAssignInNewTab() {
        $('#resultTable a').filter(function () {
            return normalize($(this).text()).toLowerCase() === 'assign to me';
        }).addClass('q-assign').attr({
            target: '_blank',
            rel: 'noopener'
        });
    }

    // ============================================================
    // DESKTOP NOTIFICATIONS + SOUND
    // ============================================================

    let permissionAsked = false;

    // Chrome only shows the prompt reliably after a click / key press, so this
    // is called from the first user gesture (and from the Settings button).
    function requestNotificationPermission() {
        if (!('Notification' in window) || Notification.permission !== 'default') {
            return Promise.resolve();
        }

        permissionAsked = true;

        return Notification.requestPermission().then(function () {
            refreshNotifStatus();
        }).catch((error) => {
            console.error('[Kapoy QC] Permission error:', error);
        });
    }

    let audioContext = null;

    function setupUserGesture() {
        function unlock() {
            if (!permissionAsked) {
                requestNotificationPermission();
            }

            if (!NOTIFICATION_SOUND) {
                return;
            }

            try {
                const AudioCtx = window.AudioContext || window.webkitAudioContext;

                if (!AudioCtx) {
                    return;
                }

                if (!audioContext) {
                    audioContext = new AudioCtx();
                }

                if (audioContext.state === 'suspended') {
                    audioContext.resume();
                }
            } catch (error) {
                console.error('[Kapoy QC] Sound unlock failed:', error);
            }
        }

        ['pointerdown', 'keydown'].forEach((type) => {
            document.addEventListener(type, unlock, { passive: true });
        });
    }

    function beep() {
        if (!NOTIFICATION_SOUND || !audioContext || audioContext.state !== 'running') {
            return;
        }

        try {
            const now = audioContext.currentTime;

            [880, 1175].forEach((frequency, index) => {
                const start = now + index * 0.16;
                const oscillator = audioContext.createOscillator();
                const gain = audioContext.createGain();

                oscillator.type = 'sine';
                oscillator.frequency.value = frequency;

                gain.gain.setValueAtTime(0.0001, start);
                gain.gain.exponentialRampToValueAtTime(
                    Math.max(0.0002, NOTIFICATION_SOUND_VOLUME),
                    start + 0.02
                );
                gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.18);

                oscillator.connect(gain);
                gain.connect(audioContext.destination);

                oscillator.start(start);
                oscillator.stop(start + 0.2);
            });
        } catch (error) {
            console.error('[Kapoy QC] Beep failed:', error);
        }
    }

    function notify(title, body, tag) {
        if (!('Notification' in window) || Notification.permission !== 'granted') {
            return;
        }

        try {
            const notification = new Notification(title, {
                body: body,
                tag: tag,
                renotify: true,
                requireInteraction: NOTIFICATION_STAYS_UNTIL_DISMISSED
            });

            if (!NOTIFICATION_STAYS_UNTIL_DISMISSED) {
                setTimeout(function () {
                    notification.close();
                }, NOTIFICATION_SECONDS * 1000);
            }

            notification.onclick = function () {
                window.focus();
                notification.close();
            };
        } catch (error) {
            console.error('[Kapoy QC] Failed to send notification:', error);
        }
    }

    // ============================================================
    // NEW PROOF DETECTION
    // ============================================================

    function collectProofs($rows) {
        const proofs = [];

        $rows.each(function () {
            const $row = $(this);

            if (!$row.children('td').length) {
                return;
            }

            const daName = getMatchedDA($row);
            const proofID = cellText($row, COLS.proof);

            if (!daName || !proofID) {
                return;
            }

            proofs.push({
                proofID: proofID,
                daName: daName,
                queue: cellText($row, COLS.queue),
                state: cellText($row, COLS.state)
            });
        });

        return proofs;
    }

    function notifyNewProofs(list) {
        if (list.length === 1) {
            const p = list[0];

            notify(
                `New Proof - ${p.daName}`,
                `Proof ${p.proofID} • ${p.queue || 'Unknown Queue'}`,
                NOTIFICATION_TAG
            );

            return;
        }

        const byDA = {};

        list.forEach((p) => {
            (byDA[p.daName] || (byDA[p.daName] = [])).push(p);
        });

        const lines = Object.keys(byDA).map((name) => {
            const ids = byDA[name].map((p) => p.proofID);
            const shown = ids.slice(0, 3).join(', ');

            return `${name}: ${ids.length} (${shown}${ids.length > 3 ? ', ...' : ''})`;
        });

        notify(`${list.length} New Proofs`, lines.join('\n'), NOTIFICATION_TAG);
    }

    function checkForNewProofs(proofs) {
        if (!proofs.length) {
            return;
        }

        const now = Date.now();

        const initialized = settings.seenInit || Object.keys(seenProofs).length > 0;

        if (!settings.seenInit) {
            settings.seenInit = true;
            saveSettings();
        }

        // First run: everything shown now counts as already seen.
        if (!initialized) {
            proofs.forEach((proof) => {
                seenProofs[proof.proofID] = now;
            });

            saveSeen();
            return;
        }

        const newProofs = proofs.filter((proof) => !seenProofs[proof.proofID]);

        if (newProofs.length) {
            beep();
            notifyNewProofs(newProofs);
        }

        proofs.forEach((proof) => {
            seenProofs[proof.proofID] = now;
        });

        saveSeen();
    }

    // ============================================================
    // STATUS PANEL
    // ============================================================

    function escapeHtml(value) {
        return String(value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    function setLastCheck(text) {
        const el = document.getElementById('q-last');

        if (el) {
            el.textContent = text;
        }
    }

    function formatTime(date) {
        return date.toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit'
        });
    }

    // Countdown state. A timestamp is used (not a decrementing counter), so a
    // throttled background tab can never make the refresh slower than set.
    let nextRefreshAt = Date.now() + settings.reloadSeconds * 1000;
    let intervalEditing = false;
    let namesEditing = false;

    function resetTimer() {
        nextRefreshAt = Date.now() + settings.reloadSeconds * 1000;
    }

    function refreshNotifStatus() {
        const label = document.getElementById('q-notif-label');
        const button = document.getElementById('q-notif-btn');

        if (!label || !button) {
            return;
        }

        if (!('Notification' in window)) {
            label.textContent = 'Not supported';
            button.hidden = true;
            return;
        }

        const state = Notification.permission;

        label.textContent = state === 'granted' ? 'Allowed'
            : state === 'denied' ? 'Blocked (change in browser)'
            : 'Not asked yet';
        button.hidden = state !== 'default';
    }

    function createPanel() {
        if (document.getElementById('kqc-panel')) {
            return;
        }

        const panel = document.createElement('div');

        panel.id = 'kqc-panel';

        panel.innerHTML = `
            <div class="q-head" id="q-head"><span>Kapoy QC</span><span class="q-tools"><button type="button" id="q-settings-btn" title="Settings">⚙</button><button type="button" id="q-collapse" title="Hide panel">▾</button><span class="q-grip">⋮⋮</span></span></div>
            <div class="q-body">
                <div id="q-settings" hidden>
                    <div class="q-label q-label-row">
                        <span>SETTINGS</span>
                        <button type="button" class="q-btn q-mini" id="q-settings-back" title="Back to the tracker">Back</button>
                    </div>
                    <div class="q-divider"></div>

                    <div class="q-label">APPEARANCE</div>
                    <div class="q-row">
                        <span>Theme: <strong id="q-theme-label"></strong></span>
                        <label class="q-switch" title="Switch light / dark">
                            <input type="checkbox" id="q-theme">
                            <span class="q-slider"></span>
                        </label>
                    </div>
                    <div class="q-divider"></div>

                    <div class="q-label">RELOAD</div>
                    <div class="q-row">
                        <span>Auto-reload: <strong id="q-auto-label"></strong></span>
                        <label class="q-switch" title="Turn auto-reload on / off">
                            <input type="checkbox" id="q-auto">
                            <span class="q-slider"></span>
                        </label>
                    </div>
                    <div class="q-row">
                        <span>Every</span>
                        <span class="q-interval">
                            <input class="q-number" id="q-interval" type="number"
                                   min="${MIN_RELOAD_SECONDS}" max="${MAX_RELOAD_SECONDS}"
                                   value="${settings.reloadSeconds}">
                            <span>sec</span>
                        </span>
                    </div>
                    <div class="q-divider"></div>

                    <div class="q-label">NOTIFICATIONS</div>
                    <div class="q-row">
                        <span>Status: <strong id="q-notif-label"></strong></span>
                        <button type="button" class="q-btn" id="q-notif-btn">Enable</button>
                    </div>
                </div>

                <div id="q-main">
                <div class="q-row q-reload">
                    <span>Reloading in</span>
                    <strong id="q-countdown">--</strong>
                </div>
                <div class="q-last" id="q-last"></div>
                <div class="q-divider"></div>

                <div class="q-label q-label-row">
                    <span>DA NAMES <button type="button" class="q-btn q-mini" id="q-edit-names" title="Add, remove or rename DAs">Edit</button></span>
                    <span>SHOWING · ASSIGNED</span>
                </div>
                <div id="q-das"></div>
                <div id="q-names-editor" hidden>
                    <textarea id="q-names-text" rows="4" spellcheck="false" placeholder="One name per line"></textarea>
                    <div class="q-note">One name per line, spelled exactly like the DA column in the table.</div>
                    <div class="q-foot-btns q-editor-btns">
                        <button type="button" class="q-btn" id="q-names-cancel">Cancel</button>
                        <button type="button" class="q-btn q-save" id="q-names-save">Save</button>
                    </div>
                </div>

                <div class="q-divider"></div>
                <div class="q-label q-label-row">
                    <span>TOTAL ASSIGNED</span>
                    <span>TODAY</span>
                </div>
                <div class="q-da" style="--q-rowcolor:var(--q-green)">
                    <strong>Total</strong>
                    <span class="q-chips">
                        <span class="q-count q-tot zero" id="q-total-today" title="Total assign clicks today (duplicates included)">0</span>
                    </span>
                </div>

                <div class="q-foot">
                    <span>Today resets daily</span>
                    <span class="q-foot-btns">
                        <button type="button" class="q-btn q-danger" id="q-reset-assigned" title="Reset today's assigned counts to 0">Reset</button>
                    </span>
                </div>
                </div>
            </div>
        `;

        document.body.appendChild(panel);

        renderDAList();

        document.getElementById('q-last').textContent =
            `Last check: ${formatTime(new Date())}`;

        setupThemeSwitch();
        setupCollapse(panel);
        setupSettingsView(panel);
        setupIntervalInput();
        setupAutoToggle();
        setupNotifButton();
        setupAssignedReset();
        setupNamesEditor();
        renderAssigned();

        applyTheme();
        restorePanelPosition(panel);
        makePanelDraggable(panel);
    }

    function renderDAList() {
        document.getElementById('q-das').innerHTML = currentDAs
            .map((name) => {
                const shown = tableStats.byDA[name] || 0;

                return `
                <div class="q-da" style="--q-rowcolor:${daColor(name)}">
                    <span title="${escapeHtml(name)}">${escapeHtml(name)}</span>
                    <span class="q-chips">
                        <span class="q-count q-show ${shown ? '' : 'zero'}" data-da="${escapeHtml(name)}" title="Proofs showing now">${shown}</span>
                        <span class="q-count q-assigned zero" data-da="${escapeHtml(name)}" title="Assigned to me today (duplicates included)">0</span>
                    </span>
                </div>
            `;
            })
            .join('');

        renderAssigned();
    }

    function setupNamesEditor() {
        const editBtn = document.getElementById('q-edit-names');
        const editor = document.getElementById('q-names-editor');
        const list = document.getElementById('q-das');
        const text = document.getElementById('q-names-text');

        function open() {
            text.value = currentDAs.join('\n');
            list.hidden = true;
            editor.hidden = false;
            namesEditing = true;
            editBtn.textContent = 'Close';
            text.focus();
        }

        function close() {
            editor.hidden = true;
            list.hidden = false;
            namesEditing = false;
            editBtn.textContent = 'Edit';
        }

        function save() {
            const names = cleanNames(text.value.split(/\r?\n/));

            if (!names.length) {
                window.alert('Add at least one DA name.');
                return;
            }

            currentDAs = names;
            allowedLower = buildAllowedMap();
            settings.daNames = names;
            saveSettings();

            // Proofs of newly added DAs already on the page must not fire
            // "new proof" notifications, so mark them as seen first.
            const now = Date.now();

            collectProofs($('#resultTable tbody tr')).forEach((proof) => {
                if (!seenProofs[proof.proofID]) {
                    seenProofs[proof.proofID] = now;
                }
            });

            saveSeen();

            applyTable();
            updateCount();
            renderDAList();
            close();
        }

        editBtn.addEventListener('click', function () {
            namesEditing ? close() : open();
        });

        document.getElementById('q-names-cancel').addEventListener('click', close);
        document.getElementById('q-names-save').addEventListener('click', save);

        text.addEventListener('keydown', function (event) {
            if (event.key === 'Escape') {
                close();
            }
        });
    }

    function setupThemeSwitch() {
        const toggle = document.getElementById('q-theme');

        toggle.addEventListener('change', function () {
            settings.theme = toggle.checked ? 'dark' : 'light';

            saveSettings();
            applyTheme();
            updateCount();
        });
    }

    function applyCollapsed(panel) {
        const button = document.getElementById('q-collapse');

        panel.classList.toggle('q-collapsed', settings.collapsed);

        if (button) {
            button.textContent = settings.collapsed ? '▸' : '▾';
            button.title = settings.collapsed ? 'Show panel' : 'Hide panel';
        }

        const rect = panel.getBoundingClientRect();

        if (panel.style.left) {
            placePanel(panel, rect.left, rect.top);
        }
    }

    function setupCollapse(panel) {
        const button = document.getElementById('q-collapse');

        button.addEventListener('click', function () {
            settings.collapsed = !settings.collapsed;

            saveSettings();
            applyCollapsed(panel);
        });

        applyCollapsed(panel);
    }

    function setupSettingsView(panel) {
        const button = document.getElementById('q-settings-btn');
        const back = document.getElementById('q-settings-back');
        const settingsView = document.getElementById('q-settings');
        const main = document.getElementById('q-main');

        function show(open) {
            settingsView.hidden = !open;
            main.hidden = open;
            button.classList.toggle('q-on', open);
            button.title = open ? 'Back to the tracker' : 'Settings';

            if (open) {
                refreshNotifStatus();
            }

            const rect = panel.getBoundingClientRect();

            if (panel.style.left) {
                placePanel(panel, rect.left, rect.top);
            }
        }

        button.addEventListener('click', function () {
            show(settingsView.hidden);
        });

        back.addEventListener('click', function () {
            show(false);
        });
    }

    function setupAutoToggle() {
        const toggle = document.getElementById('q-auto');
        const label = document.getElementById('q-auto-label');

        function show() {
            toggle.checked = settings.auto;
            label.textContent = settings.auto ? 'On' : 'Off';
        }

        toggle.addEventListener('change', function () {
            settings.auto = toggle.checked;

            saveSettings();
            resetTimer();
            show();
        });

        show();
    }

    function setupNotifButton() {
        document.getElementById('q-notif-btn').addEventListener('click', function () {
            requestNotificationPermission();
        });

        refreshNotifStatus();
    }

    function setupIntervalInput() {
        const input = document.getElementById('q-interval');

        function apply() {
            settings.reloadSeconds = clampSeconds(input.value);

            input.value = settings.reloadSeconds;
            saveSettings();
            resetTimer();
        }

        input.addEventListener('focus', function () {
            intervalEditing = true;
        });

        input.addEventListener('blur', function () {
            intervalEditing = false;
            apply();
        });

        input.addEventListener('change', apply);

        input.addEventListener('keydown', function (event) {
            if (event.key === 'Enter') {
                input.blur();
            }
        });
    }

    // ============================================================
    // DRAGGING (pointer events: mouse, touch and pen; position is saved)
    // ============================================================

    let panelDragging = false;

    function clampPosition(panel, left, top) {
        const maxLeft = Math.max(0, window.innerWidth - panel.offsetWidth);
        const maxTop = Math.max(0, window.innerHeight - panel.offsetHeight);

        return {
            left: Math.max(0, Math.min(left, maxLeft)),
            top: Math.max(0, Math.min(top, maxTop))
        };
    }

    function placePanel(panel, left, top) {
        const pos = clampPosition(panel, left, top);

        panel.style.left = `${pos.left}px`;
        panel.style.top = `${pos.top}px`;
        panel.style.right = 'auto';
    }

    function restorePanelPosition(panel) {
        if (settings.position) {
            placePanel(panel, settings.position.left, settings.position.top);
        }
    }

    function savePanelPosition(panel) {
        const rect = panel.getBoundingClientRect();

        settings.position = { left: rect.left, top: rect.top };
        saveSettings();
    }

    function makePanelDraggable(panel) {
        const handle = document.getElementById('q-head');

        if (!handle) {
            return;
        }

        let offsetX = 0;
        let offsetY = 0;

        handle.addEventListener('pointerdown', function (event) {
            if (event.button !== 0 || event.target.closest('button')) {
                return;
            }

            const rect = panel.getBoundingClientRect();

            panelDragging = true;
            offsetX = event.clientX - rect.left;
            offsetY = event.clientY - rect.top;

            placePanel(panel, rect.left, rect.top);

            try {
                handle.setPointerCapture(event.pointerId);
            } catch (error) {
                // not critical
            }

            event.preventDefault();
        });

        handle.addEventListener('pointermove', function (event) {
            if (!panelDragging) {
                return;
            }

            placePanel(panel, event.clientX - offsetX, event.clientY - offsetY);
        });

        function stop() {
            if (!panelDragging) {
                return;
            }

            panelDragging = false;
            savePanelPosition(panel);
        }

        handle.addEventListener('pointerup', stop);
        handle.addEventListener('pointercancel', stop);

        window.addEventListener('resize', function () {
            const rect = panel.getBoundingClientRect();

            placePanel(panel, rect.left, rect.top);
        });
    }

    // ============================================================
    // REFRESH (background merge or full reload)
    // ============================================================

    function applyRefreshedTable() {
        detectColumns();
        applyTable();
        updateCount();
        openAssignInNewTab();

        checkForNewProofs(collectProofs($('#resultTable tbody tr')));

        // A new day may have started since the page was opened.
        assigned = loadAssigned();
        renderAssigned();
        renderDACounts();

        setLastCheck(`Last check: ${formatTime(new Date())}`);
    }

    function rowProofId(tr) {
        const cell = tr.children[COLS.proof - 1];

        return cell && cell.tagName === 'TD' ? normalize(cell.textContent) : '';
    }

    function rowSignature(tr) {
        const links = Array.from(tr.querySelectorAll('a'))
            .map((a) => a.getAttribute('href') || '')
            .join('|');

        return `${normalize(tr.textContent)}||${links}`;
    }

    // Keeps the rows that did not change (same DOM nodes, so any handler the
    // site attached to them survives) and only brings in new / changed rows.
    function mergeRows(liveBody, freshBody) {
        const liveMap = new Map();

        Array.from(liveBody.rows).forEach((tr) => {
            const id = rowProofId(tr);

            if (id && !liveMap.has(id)) {
                liveMap.set(id, tr);
            }
        });

        const fragment = document.createDocumentFragment();

        Array.from(freshBody.rows).forEach((freshRow) => {
            const id = rowProofId(freshRow);
            const liveRow = id ? liveMap.get(id) : null;

            if (liveRow && rowSignature(liveRow) === rowSignature(freshRow)) {
                liveMap.delete(id);
                fragment.appendChild(liveRow);
            } else {
                fragment.appendChild(document.importNode(freshRow, true));
            }
        });

        // Rows still left in the old body (gone from the server) are dropped.
        liveBody.replaceChildren(fragment);
    }

    let refreshing = false;

    async function backgroundRefresh() {
        if (refreshing) {
            return;
        }

        if (!document.querySelector('#resultTable tbody')) {
            window.location.reload();
            return;
        }

        refreshing = true;

        const controller = new AbortController();
        const timer = setTimeout(function () {
            controller.abort();
        }, REFRESH_TIMEOUT_MS);

        try {
            const response = await fetch(window.location.href, {
                credentials: 'same-origin',
                cache: 'no-store',
                signal: controller.signal
            });

            if (response.status === 401 || response.status === 403) {
                window.location.reload();
                return;
            }

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }

            const html = await response.text();
            const doc = new DOMParser().parseFromString(html, 'text/html');
            const fresh = doc.querySelector('#resultTable tbody');

            // No results table = most likely the login page (session expired).
            if (!fresh) {
                window.location.reload();
                return;
            }

            const live = document.querySelector('#resultTable tbody');

            if (!live) {
                window.location.reload();
                return;
            }

            // You ticked a box while the download was running: leave the rows alone.
            if (isSelectionActive()) {
                return;
            }

            mergeRows(live, fresh);
            applyRefreshedTable();
        } catch (error) {
            console.error('[Kapoy QC] Background refresh failed:', error);

            setLastCheck(`Refresh failed ${formatTime(new Date())} - retrying`);
        } finally {
            clearTimeout(timer);
            refreshing = false;
        }
    }

    function isSelectionActive() {
        return SKIP_RELOAD_IF_CHECKED &&
            $('#resultTable tbody input[type="checkbox"]:checked').length > 0;
    }

    function tick() {
        const label = document.getElementById('q-countdown');

        function show(text, paused) {
            if (label) {
                label.textContent = text;
                label.className = paused ? 'paused' : '';
            }
        }

        if (!settings.auto) {
            resetTimer();
            show('Off', true);
            return;
        }

        if (panelDragging) {
            resetTimer();
            show('Paused (moving)', true);
            return;
        }

        if (intervalEditing || namesEditing) {
            resetTimer();
            show('Paused (editing)', true);
            return;
        }

        if (isSelectionActive()) {
            resetTimer();
            show('Paused (selected)', true);
            return;
        }

        if (refreshing) {
            show('Refreshing...', false);
            return;
        }

        const remaining = Math.ceil((nextRefreshAt - Date.now()) / 1000);

        if (remaining > 0) {
            show(`${remaining}s`, false);
            return;
        }

        resetTimer();

        if (USE_BACKGROUND_REFRESH) {
            show('Refreshing...', false);
            backgroundRefresh();
            return;
        }

        show('Reloading...', false);
        window.location.reload();
    }

    // The tick comes from an inline Web Worker, because browsers slow down
    // timers on the main thread in hidden tabs. If workers are blocked by the
    // page, it falls back to a normal setInterval.
    function startTicker() {
        resetTimer();
        tick();

        let usingWorker = false;

        function fallback() {
            setInterval(tick, 1000);
        }

        try {
            const blob = new Blob(
                ['setInterval(function(){postMessage(0);},1000);'],
                { type: 'application/javascript' }
            );
            const url = URL.createObjectURL(blob);
            const worker = new Worker(url);

            usingWorker = true;

            worker.onmessage = tick;
            worker.onerror = function () {
                worker.terminate();

                if (usingWorker) {
                    usingWorker = false;
                    fallback();
                }
            };
        } catch (error) {
            fallback();
        }

        // Catch up right away when you come back to the tab.
        document.addEventListener('visibilitychange', tick);
    }

    // ============================================================
    // INITIALIZATION
    // ============================================================

    $(function () {
        function safe(name, fn) {
            try {
                fn();
            } catch (error) {
                console.error(`[Kapoy QC] ${name} failed:`, error);
            }
        }

        safe('columns', detectColumns);
        safe('filter rows', applyTable);

        // Rows are filtered now, so they can be shown.
        document.documentElement.classList.remove('q-pending');

        safe('count', updateCount);
        safe('assign links', openAssignInNewTab);
        safe('assign tracking', setupAssignTracking);
        safe('storage sync', setupStorageSync);
        safe('user gesture', setupUserGesture);

        safe('new proofs', function () {
            checkForNewProofs(collectProofs($('#resultTable tbody tr')));
        });

        safe('panel', createPanel);
        safe('ticker', startTicker);
    });

})(jQuery);
