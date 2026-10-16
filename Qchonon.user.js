// ==UserScript==
// @name         Kapoy QC
// @namespace    http://tampermonkey.net/
// @version      3.3.4
// @description  Show only proofs of selected DAs, counts, background refresh with backoff, grouped notifications + beep, "assign to me" in new tab, proof age + stale tint, tab badge, gone-from-list detection, per-DA mute, quiet hours, history + CSV, dark/light theme, no jQuery
// @match        https://mbo.minted.com/mbo/proofs*
// @updateURL    https://raw.githubusercontent.com/nicolelodeontv/kapoy-qc/main/Qchonon.user.js
// @downloadURL  https://raw.githubusercontent.com/nicolelodeontv/kapoy-qc/main/Qchonon.user.js
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function () {
    'use strict';

    // The @match is broad on purpose (parameter order / extra params can change).
    // Only run on the "filter by state 2070" page.
    const params = new URLSearchParams(window.location.search);

    if (params.get('action') !== 'filter' || params.get('state') !== '2070') {
        return;
    }

    const VERSION = '3.3.4';

    // Add &kqcdebug=1 to the page URL to turn on logging and the self-test
    // (run kapoyQCSelfTest() in the browser console).
    const DEBUG = params.get('kqcdebug') === '1';

    function log() {
        if (DEBUG) {
            console.log('[Kapoy QC]', ...arguments);
        }
    }

    const CHANGELOG = [
        'Sorted (green) header text is always readable',
        'Results table is centered in the window',
        'Assignment dropdown popup is no longer see-through'
    ];

    // ============================================================
    // CONFIG
    // ============================================================

    // STARTING list of DA names, used only until you edit the names in the
    // panel (DA NAMES > Edit). After that, the saved list is used.
    const ALLOWED_DAS = [
        'Edzmer Amarani',
        'Jannel Tatoy',
        'Sherwin Jay Acruz'
    ];

    // Fallback table columns (1-based). The script first tries to find the
    // columns by header text and only uses these if that fails.
    const COL_PROOF = 4;
    const COL_QUEUE = 7;
    const COL_STATE = 13;
    const DA_COLUMNS = [15, 16];

    // Header text used to find the columns. "time" is optional: when a column
    // matches and its text is a parseable date, it is used for the proof age.
    // Otherwise the age counts from when this script first saw the proof.
    const HEADER_PATTERNS = {
        proof: /^proof\s*(id|#)?$/i,
        queue: /^queue$/i,
        state: /^state$/i,
        time: /(created|submitted|queued|since|state\s*(date|time|changed))/i,
        da: [/accepted\s*da/i, /target\s*da/i]
    };

    const QUEUE_TYPES = ['Standard', 'Wedding'];

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

    // Proof age: amber label after this many minutes, red after the second one.
    const STALE_MINUTES = 15;
    const VERY_STALE_MINUTES = 30;

    const DEFAULT_RELOAD_SECONDS = 10;
    const MIN_RELOAD_SECONDS = 5;
    const MAX_RELOAD_SECONDS = 3600;

    // After this many failed refreshes in a row the panel shows a warning,
    // and the wait between tries grows (interval x 2, x 4, ...) up to the cap.
    const HEALTH_FAILS = 3;
    const MAX_BACKOFF_SECONDS = 300;

    const DEFAULT_THEME = 'dark';

    const SKIP_RELOAD_IF_CHECKED = true;

    const NOTIFICATION_TAG = 'kapoyqc-new-proofs';
    const NOTIFICATION_SECONDS = 6;
    const NOTIFICATION_STAYS_UNTIL_DISMISSED = false;

    // Beep volume = (panel volume 0-100) / 100 x this.
    const BEEP_MAX_GAIN = 0.5;

    const USE_BACKGROUND_REFRESH = true;
    const REFRESH_TIMEOUT_MS = 20000;

    const SEEN_MAX_DAYS = 7;
    const HISTORY_DAYS = 30;

    const SETTINGS_KEY = 'KapoyQC_Settings';
    const SEEN_KEY = 'KapoyQC_Seen';
    const FIRST_SEEN_KEY = 'KapoyQC_FirstSeen';
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
    // STORAGE + SETTINGS (one object, old keys migrated once)
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
            seenInit: false,
            badge: true,
            sortOldest: false,
            wedFirst: false,
            soundOn: true,
            volume: 40,
            quietWhenFocused: true,
            quietEnabled: false,
            quietFrom: '22:00',
            quietTo: '06:00',
            mutedDAs: [],
            history: [],
            lastVersion: ''
        };
    }

    function validHistory(h) {
        return h && typeof h.date === 'string' && typeof h.total === 'number';
    }

    // Copies only valid values from `p` into `s` (also used by Import).
    function mergeSettings(s, p) {
        if (!p || typeof p !== 'object') {
            return s;
        }

        if (p.theme === 'light' || p.theme === 'dark') {
            s.theme = p.theme;
        }

        if (p.reloadSeconds) {
            s.reloadSeconds = clampSeconds(p.reloadSeconds);
        }

        ['auto', 'collapsed', 'seenInit', 'badge', 'sortOldest', 'wedFirst',
            'soundOn', 'quietWhenFocused', 'quietEnabled'].forEach((key) => {
            if (typeof p[key] === 'boolean') {
                s[key] = p[key];
            }
        });

        if (typeof p.volume === 'number') {
            s.volume = Math.max(0, Math.min(100, Math.round(p.volume)));
        }

        ['quietFrom', 'quietTo'].forEach((key) => {
            if (typeof p[key] === 'string' && /^\d{2}:\d{2}$/.test(p[key])) {
                s[key] = p[key];
            }
        });

        if (p.position && typeof p.position.left === 'number' &&
            typeof p.position.top === 'number') {
            s.position = { left: p.position.left, top: p.position.top };
        }

        if (Array.isArray(p.daNames) && p.daNames.length) {
            s.daNames = p.daNames.map(String);
        }

        if (Array.isArray(p.mutedDAs)) {
            s.mutedDAs = p.mutedDAs.map(String);
        }

        if (Array.isArray(p.history)) {
            s.history = p.history.filter(validHistory).slice(-HISTORY_DAYS);
        }

        if (typeof p.lastVersion === 'string') {
            s.lastVersion = p.lastVersion;
        }

        return s;
    }

    // One-time move from the old separate Qchonon_* keys.
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
        const position = parseJSON(readStorage(LEGACY_KEYS.position));
        const das = parseJSON(readStorage(LEGACY_KEYS.das));

        mergeSettings(s, {
            theme: readStorage(LEGACY_KEYS.theme),
            reloadSeconds: readStorage(LEGACY_KEYS.reload),
            auto: readStorage(LEGACY_KEYS.auto) !== 'off',
            collapsed: readStorage(LEGACY_KEYS.collapsed) === 'yes',
            seenInit: readStorage(LEGACY_KEYS.seenInit) === 'yes',
            position: position,
            daNames: das
        });

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
        return mergeSettings(defaultSettings(), parseJSON(readStorage(SETTINGS_KEY)));
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

    const POP = 'html:root body > .select2-drop:not(#kqc-panel)';

    function buildCss() {
        const transparentBg = [
            'html.q-dark body > div:not(#kqc-panel):not(.select2-drop):not(.chosen-drop):not(.ui-front)',
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

/* ---------- TABLE + PAGE TEXT (matches the panel and the controls) ---------- */
html {
    --qt-head-bg: #eef1f6; --qt-head-fg: #5b6573; --qt-row: #f6f8fb;
    --qt-row-hover: #eaf0fa; --qt-chip: #e3e8f0;
}
html.q-dark {
    --qt-head-bg: #1d2230; --qt-head-fg: #b9c2cf; --qt-row: #1b1b1b;
    --qt-row-hover: #272727; --qt-chip: #2a2f3a;
}
/* Page text: one size (13px) like the controls; things with their own size keep it */
html:root body > div:not(#kqc-panel) { font-size: 13px; }
html:root div.warning { font-size: 13px; margin: 8px 0; }

html:root body table#resultTable { border-collapse: separate; border-spacing: 0 4px; }
html:root body table#resultTable tr:has(> th) { background: var(--qt-head-bg); }
html:root body table#resultTable th {
    padding: 9px 10px !important;
    border: 0 !important;
    color: var(--qt-head-fg) !important;
    font-size: 11px !important;
    font-weight: 700 !important;
    letter-spacing: 0.6px;
    text-transform: uppercase;
    text-align: left;
    vertical-align: middle;
}
html:root body table#resultTable th:first-child { border-radius: 8px 0 0 8px; }
html:root body table#resultTable th:last-child { border-radius: 0 8px 8px 0; }

html:root body table#resultTable tbody td {
    padding: 8px 10px;
    border: 0 !important;
    font-size: 12px;
    vertical-align: middle;
}
html:root body table#resultTable tbody td:first-child { border-radius: 8px 0 0 8px; }
html:root body table#resultTable tbody td:last-child { border-radius: 0 8px 8px 0; }
html:root:not(.q-dark) body table#resultTable tbody td { background-color: var(--qt-row); }
html:root:not(.q-dark) body table#resultTable tbody tr:hover td { background-color: var(--qt-row-hover); }

/* Age pill under the Proof ID + stale tint */
html:root body table#resultTable tbody td[data-q-age]::after {
    content: attr(data-q-age);
    display: block;
    width: max-content;
    margin: 4px 0 0;
    padding: 1px 7px;
    border-radius: 999px;
    background: var(--qt-chip);
    color: var(--qt-head-fg);
    font-size: 10px;
    font-weight: 700;
    line-height: 1.5;
    white-space: nowrap;
}
html:root body table#resultTable tbody tr.q-stale td[data-q-age]::after {
    background: color-mix(in srgb, #e08a00 22%, transparent);
    color: #e08a00;
}
html:root body table#resultTable tbody tr.q-very-stale td[data-q-age]::after {
    background: color-mix(in srgb, #ef5350 22%, transparent);
    color: #ef5350;
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

#kqc-panel .q-health {
    margin: 0 0 8px;
    padding: 6px 8px;
    border-radius: 6px;
    background: color-mix(in srgb, #ef5350 20%, transparent);
    color: #ef5350;
    font-size: 11px;
    font-weight: 600;
    white-space: normal;
}
#kqc-panel .q-news {
    margin: 0 0 8px;
    padding: 6px 8px;
    border: 1px solid var(--q-border);
    border-radius: 6px;
    font-size: 11px;
    white-space: normal;
}
#kqc-panel .q-news ul { margin: 4px 0 6px 14px; padding: 0; }
#kqc-panel .q-news li { margin: 1px 0; }
#kqc-panel .q-gone { color: var(--q-muted); font-size: 11px; padding: 0 0 6px; white-space: normal; }
#kqc-panel .q-gone:empty { display: none; }
#kqc-panel .q-da[data-da] { cursor: pointer; }
#kqc-panel .q-da.q-focus { background: color-mix(in srgb, var(--q-rowcolor) 14%, transparent); }
#kqc-panel button.q-mute { padding: 0 4px; font-size: 11px; line-height: 18px; }
#kqc-panel input[type="range"] { width: 100px; accent-color: #4f8cff; }
#kqc-panel input.q-time {
    box-sizing: border-box;
    width: 84px;
    height: 24px;
    padding: 2px 4px;
    background: var(--q-input-bg);
    color: var(--q-text);
    border: 1px solid var(--q-input-border);
    border-radius: 5px;
    font-size: 11px;
}
#kqc-panel .q-body { max-height: var(--q-maxh, calc(100vh - 70px)); overflow-y: auto; scrollbar-width: thin; scrollbar-color: var(--q-border) transparent; }

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

/* select2 v3: the "assignment" box and its popup (the popup sits directly under <body>) */
${ui([
    '.select2-container .select2-choice',
    '.select2-container-multi .select2-choices'
])} {
    min-height: 28px;
    border: 1px solid var(--ql-border) !important;
    border-radius: 6px !important;
    background: var(--qf-bg) !important;
    background-image: none !important;
    color: var(--qf-fg) !important;
    box-shadow: none !important;
}
${ui(['.select2-container .select2-choice .select2-chosen'])} { color: var(--qf-fg) !important; }
${ui(['.select2-container .select2-choice .select2-arrow'])} {
    background: transparent !important;
    border: 0 !important;
}
html.q-dark .select2-container .select2-choice .select2-arrow b { filter: invert(1) brightness(1.3); }

${POP} {
    background: var(--qf-bg) !important;
    border: 1px solid var(--ql-border) !important;
    border-radius: 6px !important;
    color: var(--qf-fg) !important;
    box-shadow: 0 8px 24px rgba(0,0,0,0.35) !important;
}
${POP} .select2-results { background: transparent !important; }
${POP} .select2-results .select2-result-label,
${POP} .select2-results .select2-no-results,
${POP} .select2-results .select2-searching { color: var(--qf-fg) !important; background: transparent !important; }
${POP} .select2-results .select2-highlighted,
${POP} .select2-results .select2-highlighted .select2-result-label {
    background: var(--ql-primary-bg) !important;
    color: var(--ql-primary-fg) !important;
}
${POP} .select2-results .select2-disabled { opacity: 0.5; }

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
    // DOM + TEXT HELPERS (no jQuery)
    // ============================================================

    function $q(selector, root) {
        return (root || document).querySelector(selector);
    }

    function $$(selector, root) {
        return Array.from((root || document).querySelectorAll(selector));
    }

    function hasCells(tr) {
        return Array.from(tr.children).some((c) => c.tagName === 'TD');
    }

    function dataRows(root) {
        return $$('#resultTable tbody tr', root).filter(hasCells);
    }

    function onReady(fn) {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', fn);
        } else {
            fn();
        }
    }

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

    function escapeHtml(value) {
        return String(value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    function countOf(value) {
        if (Array.isArray(value)) {
            return value.length;
        }

        return Number(value) || 0;
    }

    function parseWhen(text) {
        if (!text) {
            return 0;
        }

        const t = Date.parse(text);

        return Number.isNaN(t) ? 0 : t;
    }

    function formatAge(ms) {
        const m = Math.floor(ms / 60000);

        if (m < 1) {
            return '<1m';
        }

        if (m < 60) {
            return `${m}m`;
        }

        const h = Math.floor(m / 60);

        if (h < 24) {
            return `${h}h ${m % 60}m`;
        }

        return `${Math.floor(h / 24)}d ${h % 24}h`;
    }

    function formatTime(date) {
        return date.toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit'
        });
    }

    function toMinutes(text) {
        const parts = String(text).split(':').map(Number);

        return parts[0] * 60 + parts[1];
    }

    // Pure helper: is `nowMin` inside the quiet window (may cross midnight)?
    function isQuietAt(nowMin, from, to) {
        if (from === to) {
            return false;
        }

        return from < to
            ? nowMin >= from && nowMin < to
            : nowMin >= from || nowMin < to;
    }

    function inQuietHours() {
        if (!settings.quietEnabled) {
            return false;
        }

        const d = new Date();

        return isQuietAt(
            d.getHours() * 60 + d.getMinutes(),
            toMinutes(settings.quietFrom),
            toMinutes(settings.quietTo)
        );
    }

    // ============================================================
    // DA NAMES + COLUMNS
    // ============================================================

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

    let COLS = {
        proof: COL_PROOF,
        queue: COL_QUEUE,
        state: COL_STATE,
        time: 0,
        da: DA_COLUMNS.slice()
    };
    let columnsLogged = false;

    // Finds the columns by header text. Returns null when the header and the
    // data rows do not line up (then the constants stay in use).
    function detectColumns(root) {
        const table = $q('#resultTable', root);

        if (!table) {
            return null;
        }

        const headRow = $$('tr', table)
            .find((tr) => Array.from(tr.children).some((c) => c.tagName === 'TH'));

        if (!headRow) {
            return null;
        }

        const heads = Array.from(headRow.children).map((c) => normalize(c.textContent));
        const firstData = dataRows(root)[0];

        if (firstData && firstData.children.length !== heads.length) {
            return null;
        }

        const found = { proof: 0, queue: 0, state: 0, time: 0, da: [] };

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
            } else if (!found.time && HEADER_PATTERNS.time.test(text)) {
                found.time = col;
            }
        });

        return {
            proof: found.proof || COL_PROOF,
            queue: found.queue || COL_QUEUE,
            state: found.state || COL_STATE,
            time: found.time,
            da: found.da.length ? found.da : DA_COLUMNS.slice()
        };
    }

    function refreshColumns() {
        const cols = detectColumns(document);

        if (cols) {
            COLS = cols;

            if (!columnsLogged) {
                columnsLogged = true;
                console.log('[Kapoy QC] Columns in use:', COLS);
            }
        }
    }

    function cellText(row, column) {
        const cell = row.children[column - 1];

        return cell && cell.tagName === 'TD' ? normalize(cell.textContent) : '';
    }

    function getMatchedDA(row) {
        for (const column of COLS.da) {
            const match = allowedLower.get(cellText(row, column).toLowerCase());

            if (match) {
                return match;
            }
        }

        return '';
    }

    function getQueueName(row) {
        const text = cellText(row, COLS.queue).toLowerCase();

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
    // SEEN + FIRST-SEEN PROOFS
    // ============================================================

    function pruneOld(map) {
        const cutoff = Date.now() - SEEN_MAX_DAYS * 24 * 60 * 60 * 1000;

        Object.keys(map).forEach((id) => {
            if (Number(map[id]) < cutoff) {
                delete map[id];
            }
        });

        return map;
    }

    function loadMap(key) {
        const parsed = parseJSON(readStorage(key));

        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            return {};
        }

        return pruneOld(parsed);
    }

    // Proofs already notified (so each one notifies only once).
    let seenProofs = loadMap(SEEN_KEY);

    function saveSeen() {
        pruneOld(seenProofs);
        writeStorage(SEEN_KEY, JSON.stringify(seenProofs));
    }

    // When this script first saw each proof (used for the age label when the
    // table has no usable date column).
    let firstSeen = loadMap(FIRST_SEEN_KEY);

    function saveFirstSeen() {
        pruneOld(firstSeen);
        writeStorage(FIRST_SEEN_KEY, JSON.stringify(firstSeen));
    }

    // ============================================================
    // ASSIGNED TRACKER + HISTORY
    // ============================================================
    // Every "assign to me" click counts (duplicates included).
    // "confirmed" = a proof you clicked that later left the list.
    // Shape: { date, byDA: { name: count }, total, confirmed }

    // Proofs you clicked "assign to me" on during this page session.
    const clickedProofs = new Set();

    function todayKey() {
        const d = new Date();

        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }

    function newAssignedRecord() {
        return { date: todayKey(), byDA: {}, total: 0, confirmed: 0 };
    }

    function archiveDay(rec) {
        const total = Number(rec.total) || 0;
        const confirmed = Number(rec.confirmed) || 0;

        if (!rec.date || (!total && !confirmed)) {
            return;
        }

        if (settings.history.some((h) => h.date === rec.date)) {
            return;
        }

        const byDA = {};

        Object.keys(rec.byDA || {}).forEach((name) => {
            byDA[name] = countOf(rec.byDA[name]);
        });

        settings.history.push({ date: rec.date, total: total, confirmed: confirmed, byDA: byDA });
        settings.history.sort((a, b) => a.date.localeCompare(b.date));
        settings.history = settings.history.slice(-HISTORY_DAYS);

        saveSettings();
    }

    function loadAssigned() {
        const parsed = parseJSON(readStorage(ASSIGNED_KEY));

        if (parsed && parsed.byDA && typeof parsed.byDA === 'object') {
            Object.keys(parsed.byDA).forEach((name) => {
                parsed.byDA[name] = countOf(parsed.byDA[name]);
            });

            if (typeof parsed.total !== 'number') {
                parsed.total = Object.keys(parsed.byDA)
                    .reduce((sum, name) => sum + parsed.byDA[name], 0);
            }

            parsed.confirmed = Number(parsed.confirmed) || 0;

            if (parsed.date === todayKey()) {
                return parsed;
            }

            // A new day started: keep yesterday in the history, start from 0.
            archiveDay(parsed);

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
        $$('#kqc-panel .q-assigned').forEach((el) => {
            const n = assignedCount(el.dataset.da);

            el.textContent = n;
            el.classList.toggle('zero', n === 0);
        });

        const totalEl = $q('#q-total-today');

        if (totalEl) {
            totalEl.textContent = assigned.total;
            totalEl.classList.toggle('zero', assigned.total === 0);
        }

        const confirmedEl = $q('#q-total-confirmed');

        if (confirmedEl) {
            confirmedEl.textContent = assigned.confirmed;
            confirmedEl.classList.toggle('zero', assigned.confirmed === 0);
        }
    }

    function trackAssign(link) {
        assigned = loadAssigned();

        const row = link.closest('tr');
        const proofID = row ? cellText(row, COLS.proof) : '';

        if (!proofID) {
            console.warn('[Kapoy QC] Assign clicked but no proof ID found.');
            return;
        }

        assigned.total++;

        const daName = getMatchedDA(row);

        if (daName) {
            assigned.byDA[daName] = assignedCount(daName) + 1;
        }

        saveAssigned();
        renderAssigned();

        // Make the click visible, so an accidental double click is easy to spot.
        clickedProofs.add(proofID);
        row.classList.add('q-clicked');
    }

    function setupAssignTracking() {
        // Capture phase: runs before the site's own handlers.
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

            trackAssign(link);
        }

        document.addEventListener('click', handle, true);
        document.addEventListener('auxclick', handle, true);
    }

    function setupAssignedReset() {
        $q('#q-reset-assigned').addEventListener('click', function () {
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
                const stored = loadMap(SEEN_KEY);

                Object.keys(stored).forEach((id) => {
                    if (!seenProofs[id]) {
                        seenProofs[id] = stored[id];
                    }
                });
            } else if (event.key === SETTINGS_KEY) {
                Object.assign(settings, loadSettings());
                applyTheme();
                updateBadge();

                if ($q('#q-das')) {
                    renderDAList();
                }
            }
        });
    }

    // ============================================================
    // FILTER + COLOR + AGE + COUNT (one pass, no :visible queries)
    // ============================================================

    let tableStats = { total: 0, visible: 0, byDA: {}, ids: new Set() };

    // Click a DA in the panel to show only that DA ('' = all).
    let focusDA = '';

    function applyTable() {
        const now = Date.now();
        const stats = { total: 0, visible: 0, byDA: {}, ids: new Set() };
        let firstSeenChanged = false;

        currentDAs.forEach((name) => {
            stats.byDA[name] = 0;
        });

        dataRows().forEach((row) => {
            const da = getMatchedDA(row);
            const show = Boolean(da) && (!focusDA || da === focusDA);
            const proofID = cellText(row, COLS.proof);
            const proofCell = row.children[COLS.proof - 1];
            const hasProofCell = proofCell && proofCell.tagName === 'TD';

            row.style.display = show ? '' : 'none';

            if (da) {
                stats.total++;
                stats.byDA[da]++;

                if (proofID) {
                    stats.ids.add(proofID);
                }

                if (show) {
                    stats.visible++;
                }

                row.style.setProperty('--q-da', daColor(da));
                row.classList.add('q-colored');
            } else {
                row.classList.remove('q-colored');
            }

            const queue = getQueueName(row);
            const queueCell = row.children[COLS.queue - 1];

            if (queueCell && queueCell.tagName === 'TD') {
                if (queue) {
                    queueCell.style.setProperty('--q-queue', queueColor(queue));
                    queueCell.classList.add('q-queue-cell');
                } else {
                    queueCell.classList.remove('q-queue-cell');
                }
            }

            row.classList.toggle('q-clicked', clickedProofs.has(proofID));

            // Age: from the table's date column when there is one,
            // otherwise from the first time this script saw the proof.
            if (da && proofID && hasProofCell) {
                let since = COLS.time ? parseWhen(cellText(row, COLS.time)) : 0;

                if (!since) {
                    if (!firstSeen[proofID]) {
                        firstSeen[proofID] = now;
                        firstSeenChanged = true;
                    }

                    since = firstSeen[proofID];
                }

                const age = Math.max(0, now - since);

                proofCell.setAttribute('data-q-age', formatAge(age));
                row.dataset.qSince = String(since);
                row.classList.toggle('q-stale',
                    age >= STALE_MINUTES * 60000 && age < VERY_STALE_MINUTES * 60000);
                row.classList.toggle('q-very-stale', age >= VERY_STALE_MINUTES * 60000);
            } else {
                if (hasProofCell) {
                    proofCell.removeAttribute('data-q-age');
                }

                delete row.dataset.qSince;
                row.classList.remove('q-stale', 'q-very-stale');
            }
        });

        if (firstSeenChanged) {
            saveFirstSeen();
        }

        tableStats = stats;
        sortRows();
    }

    // Optional: Wedding first and/or oldest first. Rows are only moved (never
    // recreated), so the site's handlers on them keep working.
    function sortRows() {
        if (!settings.sortOldest && !settings.wedFirst) {
            return;
        }

        const tbody = $q('#resultTable tbody');

        if (!tbody) {
            return;
        }

        const keyed = dataRows().map((row, index) => ({
            row: row,
            index: index,
            wed: settings.wedFirst && getQueueName(row) === 'Wedding' ? 0 : 1,
            since: settings.sortOldest
                ? (Number(row.dataset.qSince) || Number.MAX_SAFE_INTEGER)
                : 0
        }));

        const sorted = keyed.slice().sort((a, b) =>
            (a.wed - b.wed) || (a.since - b.since) || (a.index - b.index));

        if (sorted.every((item, i) => item === keyed[i])) {
            return;
        }

        sorted.forEach((item) => tbody.appendChild(item.row));
    }

    // Header cells that carry their own background (the green sorted column)
    // get dark or white text, whichever is readable on that color.
    function fixHeaderContrast() {
        $$('#resultTable th').forEach((th) => {
            const nums = (getComputedStyle(th).backgroundColor.match(/[\d.]+/g) || []).map(parseFloat);
            const alpha = nums.length > 3 ? nums[3] : 1;

            if (nums.length < 3 || alpha < 0.2) {
                th.style.removeProperty('color');
                return;
            }

            const lum = (0.299 * nums[0] + 0.587 * nums[1] + 0.114 * nums[2]) / 255;

            th.style.setProperty('color', lum > 0.6 ? '#1b1b1b' : '#ffffff', 'important');
            th.style.borderRadius = '6px';
        });
    }

    function updateCount() {
        const count = tableStats.visible;

        const level = LEVELS.find(
            (item) => count >= item.min && count <= item.max
        ) || LEVELS[LEVELS.length - 1];

        $$('div.warning').forEach((el) => {
            el.textContent = level.message(count);
            el.style.color = settings.theme === 'dark' ? level.darkColor : level.color;
        });

        updateBadge();
    }

    function renderDACounts() {
        $$('#kqc-panel .q-show').forEach((el) => {
            const n = tableStats.byDA[el.dataset.da] || 0;

            el.textContent = n;
            el.classList.toggle('zero', n === 0);
        });
    }

    function openAssignInNewTab() {
        $$('#resultTable a')
            .filter((a) => normalize(a.textContent).toLowerCase() === 'assign to me')
            .forEach((a) => {
                a.classList.add('q-assign');
                a.setAttribute('target', '_blank');
                a.setAttribute('rel', 'noopener');
            });
    }

    // ============================================================
    // TAB TITLE + ICON BADGE
    // ============================================================

    let baseTitle = '';
    let newFlag = false;
    let lastBadgeN = -1;
    let removedIcons = [];

    function restoreIcons() {
        const ours = $q('link#kqc-icon');

        if (ours) {
            ours.remove();
        }

        removedIcons.forEach((link) => document.head.appendChild(link));
        removedIcons = [];
    }

    function drawFavicon(n) {
        if (n === lastBadgeN) {
            return;
        }

        lastBadgeN = n;

        try {
            const canvas = document.createElement('canvas');

            canvas.width = 64;
            canvas.height = 64;

            const g = canvas.getContext('2d');

            g.fillStyle = n > 0 ? '#e53935' : '#2e7d32';
            g.beginPath();
            g.arc(32, 32, 30, 0, Math.PI * 2);
            g.fill();
            g.fillStyle = '#ffffff';
            g.font = 'bold 36px Arial, sans-serif';
            g.textAlign = 'center';
            g.textBaseline = 'middle';
            g.fillText(n > 99 ? '99+' : String(n), 32, 35);

            let link = $q('link#kqc-icon');

            if (!link) {
                $$('link[rel~="icon"]').forEach((l) => {
                    removedIcons.push(l);
                    l.remove();
                });

                link = document.createElement('link');
                link.id = 'kqc-icon';
                link.rel = 'icon';
                link.type = 'image/png';
                document.head.appendChild(link);
            }

            link.href = canvas.toDataURL('image/png');
        } catch (error) {
            log('Favicon failed:', error);
        }
    }

    function updateBadge() {
        if (!settings.badge) {
            if (baseTitle) {
                document.title = baseTitle;
            }

            restoreIcons();
            lastBadgeN = -1;
            return;
        }

        const n = tableStats.visible;

        document.title = `${newFlag ? '🔔 ' : ''}${n ? `(${n}) ` : ''}${baseTitle}`;
        drawFavicon(n);
    }

    // ============================================================
    // NOTIFICATIONS + SOUND
    // ============================================================

    let permissionAsked = false;

    // Chrome only shows the prompt reliably after a click / key press, so this
    // runs from the first user gesture (and from the Settings button).
    function requestNotificationPermission() {
        if (!('Notification' in window) || Notification.permission !== 'default') {
            return Promise.resolve();
        }

        permissionAsked = true;

        return Notification.requestPermission().then(refreshNotifStatus).catch((error) => {
            console.error('[Kapoy QC] Permission error:', error);
        });
    }

    let audioContext = null;

    function ensureAudio() {
        try {
            const AudioCtx = window.AudioContext || window.webkitAudioContext;

            if (!AudioCtx) {
                return Promise.resolve(false);
            }

            if (!audioContext) {
                audioContext = new AudioCtx();
            }

            if (audioContext.state === 'suspended') {
                return audioContext.resume().then(() => true).catch(() => false);
            }

            return Promise.resolve(true);
        } catch (error) {
            return Promise.resolve(false);
        }
    }

    function setupUserGesture() {
        function unlock() {
            if (!permissionAsked) {
                requestNotificationPermission();
            }

            ensureAudio();
        }

        ['pointerdown', 'keydown'].forEach((type) => {
            document.addEventListener(type, unlock, { passive: true });
        });
    }

    function beep() {
        const gainValue = (settings.volume / 100) * BEEP_MAX_GAIN;

        if (!audioContext || audioContext.state !== 'running' || gainValue <= 0) {
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
                gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, gainValue), start + 0.02);
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

    function testAlert() {
        requestNotificationPermission();

        ensureAudio().then(function () {
            if (settings.soundOn) {
                beep();
            }
        });

        notify('Kapoy QC test', 'Notifications are working.', `${NOTIFICATION_TAG}-test`);
    }

    // Should a new-proof alert (sound + popup) fire right now?
    function shouldAlert() {
        if (inQuietHours()) {
            return false;
        }

        if (settings.quietWhenFocused &&
            document.visibilityState === 'visible' && document.hasFocus()) {
            return false;
        }

        return true;
    }

    // ============================================================
    // NEW PROOF DETECTION
    // ============================================================

    function collectProofs(rows) {
        const proofs = [];

        rows.forEach((row) => {
            const daName = getMatchedDA(row);
            const proofID = cellText(row, COLS.proof);

            if (!daName || !proofID) {
                return;
            }

            proofs.push({
                proofID: proofID,
                daName: daName,
                queue: cellText(row, COLS.queue),
                state: cellText(row, COLS.state)
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

        // Pick up what another tab already marked, so only ONE tab alerts.
        const stored = loadMap(SEEN_KEY);

        Object.keys(stored).forEach((id) => {
            if (!seenProofs[id]) {
                seenProofs[id] = stored[id];
            }
        });

        const initialized = settings.seenInit || Object.keys(seenProofs).length > 0;

        if (!settings.seenInit) {
            settings.seenInit = true;
            saveSettings();
        }

        const newProofs = proofs.filter((proof) => !seenProofs[proof.proofID]);

        // Saved BEFORE alerting, so another tab sees it right away.
        proofs.forEach((proof) => {
            seenProofs[proof.proofID] = now;
        });

        saveSeen();

        // First run: everything shown now counts as already seen.
        if (!initialized) {
            return;
        }

        const audible = newProofs.filter((p) => !settings.mutedDAs.includes(p.daName));

        if (!audible.length) {
            return;
        }

        if (document.visibilityState !== 'visible') {
            newFlag = true;
            updateBadge();
        }

        if (!shouldAlert()) {
            return;
        }

        if (settings.soundOn) {
            beep();
        }

        notifyNewProofs(audible);
    }

    // ============================================================
    // PROOFS THAT LEFT THE LIST (you vs others)
    // ============================================================

    let previousIds = null;
    const sessionGone = { mine: 0, others: 0 };

    function renderGone() {
        const el = $q('#q-gone');

        if (!el) {
            return;
        }

        el.textContent = sessionGone.mine || sessionGone.others
            ? `Left the list since opened: ${sessionGone.mine} yours · ${sessionGone.others} others`
            : '';
    }

    function detectGone() {
        const ids = tableStats.ids;

        if (previousIds) {
            const gone = Array.from(previousIds).filter((id) => !ids.has(id));

            if (gone.length) {
                const mine = gone.filter((id) => clickedProofs.has(id));

                mine.forEach((id) => clickedProofs.delete(id));
                gone.forEach((id) => {
                    delete firstSeen[id];
                });
                saveFirstSeen();

                if (mine.length) {
                    assigned = loadAssigned();
                    assigned.confirmed = (assigned.confirmed || 0) + mine.length;
                    saveAssigned();
                }

                sessionGone.mine += mine.length;
                sessionGone.others += gone.length - mine.length;

                renderAssigned();
                renderGone();
            }
        }

        previousIds = ids;
    }

    // ============================================================
    // STATUS PANEL
    // ============================================================

    function setLastCheck(text) {
        const el = $q('#q-last');

        if (el) {
            el.textContent = text;
        }
    }

    // Countdown uses a timestamp (not a decrementing counter), so a throttled
    // background tab can never make the refresh slower than set.
    let nextRefreshAt = Date.now() + settings.reloadSeconds * 1000;
    let intervalEditing = false;
    let namesEditing = false;
    let failCount = 0;
    let lastSuccessAt = Date.now();

    function resetTimer() {
        nextRefreshAt = Date.now() + settings.reloadSeconds * 1000;
    }

    function updateHealth() {
        const el = $q('#q-health');

        if (!el) {
            return;
        }

        const offline = navigator.onLine === false;

        if (failCount >= HEALTH_FAILS || offline) {
            el.hidden = false;
            el.textContent = `⚠ ${offline ? 'Offline' : 'Refresh failing'} - data is stale since ${formatTime(new Date(lastSuccessAt))}` +
                (failCount ? ` (${failCount} failed, retrying with backoff)` : '');
        } else {
            el.hidden = true;
        }
    }

    function refreshNotifStatus() {
        const label = $q('#q-notif-label');
        const button = $q('#q-notif-btn');

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
            : state === 'denied' ? 'Blocked (browser)'
            : 'Not asked yet';
        button.hidden = state !== 'default';
    }

    function switchRow(id, text, title) {
        return `
                    <div class="q-row">
                        <span>${text}</span>
                        <label class="q-switch" title="${title || ''}">
                            <input type="checkbox" id="${id}">
                            <span class="q-slider"></span>
                        </label>
                    </div>`;
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
                    ${switchRow('q-badge', 'Tab title + icon badge')}
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

                    <div class="q-label">SORTING</div>
                    ${switchRow('q-sort-oldest', 'Oldest first')}
                    ${switchRow('q-wed-first', 'Wedding first')}
                    <div class="q-note">Age label turns amber at ${STALE_MINUTES} min, red at ${VERY_STALE_MINUTES} min.</div>
                    <div class="q-divider"></div>

                    <div class="q-label">ALERTS</div>
                    ${switchRow('q-sound', 'Sound')}
                    <div class="q-row">
                        <span>Volume</span>
                        <input type="range" id="q-volume" min="0" max="100" step="5">
                    </div>
                    ${switchRow('q-quiet-focus', 'Quiet when tab is in view', 'No sound or popup while you are looking at this tab')}
                    ${switchRow('q-quiet', 'Quiet hours')}
                    <div class="q-row">
                        <span class="q-interval">
                            <input class="q-time" id="q-quiet-from" type="time">
                            <span>to</span>
                            <input class="q-time" id="q-quiet-to" type="time">
                        </span>
                    </div>
                    <div class="q-row">
                        <span>Popups: <strong id="q-notif-label"></strong></span>
                        <span class="q-foot-btns">
                            <button type="button" class="q-btn" id="q-notif-btn">Enable</button>
                            <button type="button" class="q-btn" id="q-test-alert">Test</button>
                        </span>
                    </div>
                    <div class="q-note">Mute single DAs with the bell in the tracker.</div>
                    <div class="q-divider"></div>

                    <div class="q-label">DATA</div>
                    <div class="q-row">
                        <span>History (${HISTORY_DAYS} days)</span>
                        <button type="button" class="q-btn" id="q-csv">CSV</button>
                    </div>
                    <div class="q-row">
                        <span>Settings</span>
                        <span class="q-foot-btns">
                            <button type="button" class="q-btn" id="q-export">Export</button>
                            <button type="button" class="q-btn" id="q-import">Import</button>
                        </span>
                    </div>
                    <textarea id="q-io-text" rows="4" spellcheck="false" hidden placeholder="Paste settings JSON here, then press Import again"></textarea>
                    <div class="q-note">Alt+K hide / show · Alt+P pause / resume · v${VERSION}</div>
                </div>

                <div id="q-main">
                <div class="q-health" id="q-health" hidden></div>
                <div class="q-news" id="q-news" hidden>
                    <strong>What's new in ${VERSION}</strong>
                    <ul>${CHANGELOG.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>
                    <button type="button" class="q-btn" id="q-news-ok">Got it</button>
                </div>
                <div class="q-row q-reload">
                    <span>Reloading in</span>
                    <strong id="q-countdown">--</strong>
                </div>
                <div class="q-last" id="q-last"></div>
                <div class="q-gone" id="q-gone"></div>
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
                <div class="q-da" style="--q-rowcolor:var(--q-green)">
                    <strong>Confirmed</strong>
                    <span class="q-chips">
                        <span class="q-count q-tot zero" id="q-total-confirmed" title="Proofs you clicked that then left the list">0</span>
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
        renderGone();

        setLastCheck(`Last check: ${formatTime(new Date())}`);

        setupThemeSwitch();
        setupCollapse(panel);
        setupSettingsView(panel);
        setupSettingsControls();
        setupIntervalInput();
        setupAssignedReset();
        setupNamesEditor();
        setupNews();
        renderAssigned();
        updateHealth();

        applyTheme();
        restorePanelPosition(panel);
        makePanelDraggable(panel);

        // Keep it fitting when its content grows (Settings, editor) or the window changes.
        fitPanel(panel);

        if ('ResizeObserver' in window) {
            new ResizeObserver(function () {
                fitPanel(panel);
            }).observe(panel);
        }

        window.addEventListener('resize', function () {
            fitPanel(panel);
        });
    }

    function setupNews() {
        const box = $q('#q-news');

        if (settings.lastVersion === VERSION) {
            return;
        }

        box.hidden = false;

        $q('#q-news-ok').addEventListener('click', function () {
            box.hidden = true;
            settings.lastVersion = VERSION;
            saveSettings();
        });
    }

    function renderDAList() {
        $q('#q-das').innerHTML = currentDAs
            .map((name) => {
                const shown = tableStats.byDA[name] || 0;
                const muted = settings.mutedDAs.includes(name);
                const safe = escapeHtml(name);

                return `
                <div class="q-da${focusDA === name ? ' q-focus' : ''}" data-da="${safe}" style="--q-rowcolor:${daColor(name)}" title="Click to show only this DA">
                    <span title="${safe}">${safe}</span>
                    <span class="q-chips">
                        <span class="q-count q-show ${shown ? '' : 'zero'}" data-da="${safe}" title="Proofs showing now">${shown}</span>
                        <span class="q-count q-assigned zero" data-da="${safe}" title="Assigned to me today (duplicates included)">0</span>
                        <button type="button" class="q-btn q-mute" data-da="${safe}" title="${muted ? 'Unmute' : 'Mute'} alerts for this DA">${muted ? '🔕' : '🔔'}</button>
                    </span>
                </div>
            `;
            })
            .join('');

        renderAssigned();
    }

    function setupDAListClicks() {
        $q('#q-das').addEventListener('click', function (event) {
            const mute = event.target.closest('.q-mute');

            if (mute) {
                const name = mute.dataset.da;

                settings.mutedDAs = settings.mutedDAs.includes(name)
                    ? settings.mutedDAs.filter((n) => n !== name)
                    : settings.mutedDAs.concat(name);

                saveSettings();
                renderDAList();
                return;
            }

            const row = event.target.closest('.q-da[data-da]');

            if (!row) {
                return;
            }

            focusDA = focusDA === row.dataset.da ? '' : row.dataset.da;

            applyTable();
            updateCount();
            renderDAList();
        });
    }

    function setupNamesEditor() {
        const editBtn = $q('#q-edit-names');
        const editor = $q('#q-names-editor');
        const list = $q('#q-das');
        const text = $q('#q-names-text');

        setupDAListClicks();

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
            settings.mutedDAs = settings.mutedDAs.filter((n) => names.includes(n));
            saveSettings();

            if (focusDA && !names.includes(focusDA)) {
                focusDA = '';
            }

            // Proofs of newly added DAs already on the page must not fire
            // "new proof" alerts, so mark them as seen first.
            const now = Date.now();

            collectProofs(dataRows()).forEach((proof) => {
                if (!seenProofs[proof.proofID]) {
                    seenProofs[proof.proofID] = now;
                }
            });

            saveSeen();

            applyTable();
            previousIds = tableStats.ids; // a changed DA list is not "proofs left"
            updateCount();
            renderDAList();
            close();
        }

        editBtn.addEventListener('click', function () {
            namesEditing ? close() : open();
        });

        $q('#q-names-cancel').addEventListener('click', close);
        $q('#q-names-save').addEventListener('click', save);

        text.addEventListener('keydown', function (event) {
            if (event.key === 'Escape') {
                close();
            }
        });
    }

    function setupThemeSwitch() {
        const toggle = $q('#q-theme');

        toggle.addEventListener('change', function () {
            settings.theme = toggle.checked ? 'dark' : 'light';

            saveSettings();
            applyTheme();
            updateCount();
        });
    }

    function applyCollapsed(panel) {
        const button = $q('#q-collapse');

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

    function setCollapsed(value) {
        settings.collapsed = Boolean(value);
        saveSettings();

        const panel = $q('#kqc-panel');

        if (panel) {
            applyCollapsed(panel);
        }
    }

    function setupCollapse(panel) {
        $q('#q-collapse').addEventListener('click', function () {
            setCollapsed(!settings.collapsed);
        });

        applyCollapsed(panel);
    }

    function setupSettingsView(panel) {
        const button = $q('#q-settings-btn');
        const back = $q('#q-settings-back');
        const settingsView = $q('#q-settings');
        const main = $q('#q-main');

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

    function syncAutoUi() {
        const toggle = $q('#q-auto');
        const label = $q('#q-auto-label');

        if (toggle) {
            toggle.checked = settings.auto;
        }

        if (label) {
            label.textContent = settings.auto ? 'On' : 'Off';
        }
    }

    function setAuto(value) {
        settings.auto = Boolean(value);

        saveSettings();
        resetTimer();
        syncAutoUi();
    }

    function bindSwitch(id, key, after) {
        const el = $q(`#${id}`);

        el.checked = Boolean(settings[key]);

        el.addEventListener('change', function () {
            settings[key] = el.checked;
            saveSettings();

            if (after) {
                after();
            }
        });
    }

    function exportHistoryCsv() {
        const rows = settings.history.slice();

        rows.push({
            date: assigned.date,
            total: assigned.total,
            confirmed: assigned.confirmed || 0,
            byDA: assigned.byDA
        });

        const names = [];

        rows.forEach((r) => {
            Object.keys(r.byDA || {}).forEach((name) => {
                if (!names.includes(name)) {
                    names.push(name);
                }
            });
        });

        const esc = (v) => `"${String(v).replace(/"/g, '""')}"`;
        const lines = [['date', 'total', 'confirmed'].concat(names).map(esc).join(',')];

        rows.forEach((r) => {
            lines.push([r.date, r.total, r.confirmed || 0]
                .concat(names.map((n) => countOf((r.byDA || {})[n])))
                .join(','));
        });

        const url = URL.createObjectURL(new Blob([lines.join('\r\n')], { type: 'text/csv' }));
        const a = document.createElement('a');

        a.href = url;
        a.download = `kapoyqc-history-${todayKey()}.csv`;
        document.body.appendChild(a);
        a.click();
        a.remove();

        setTimeout(function () {
            URL.revokeObjectURL(url);
        }, 1000);
    }

    function setupSettingsControls() {
        syncAutoUi();

        $q('#q-auto').addEventListener('change', function () {
            setAuto($q('#q-auto').checked);
        });

        bindSwitch('q-badge', 'badge', updateBadge);
        bindSwitch('q-sort-oldest', 'sortOldest', function () {
            applyTable();
        });
        bindSwitch('q-wed-first', 'wedFirst', function () {
            applyTable();
        });
        bindSwitch('q-sound', 'soundOn');
        bindSwitch('q-quiet-focus', 'quietWhenFocused');
        bindSwitch('q-quiet', 'quietEnabled');

        const volume = $q('#q-volume');

        volume.value = settings.volume;
        volume.addEventListener('change', function () {
            settings.volume = Math.max(0, Math.min(100, Number(volume.value) || 0));
            saveSettings();
        });

        [['q-quiet-from', 'quietFrom'], ['q-quiet-to', 'quietTo']].forEach((pair) => {
            const input = $q(`#${pair[0]}`);

            input.value = settings[pair[1]];
            input.addEventListener('change', function () {
                if (/^\d{2}:\d{2}$/.test(input.value)) {
                    settings[pair[1]] = input.value;
                    saveSettings();
                }
            });
        });

        $q('#q-notif-btn').addEventListener('click', requestNotificationPermission);
        $q('#q-test-alert').addEventListener('click', testAlert);
        refreshNotifStatus();

        $q('#q-csv').addEventListener('click', exportHistoryCsv);

        const io = $q('#q-io-text');

        $q('#q-export').addEventListener('click', function () {
            io.hidden = false;
            io.value = JSON.stringify(settings, null, 1);
            io.focus();
            io.select();

            try {
                navigator.clipboard.writeText(io.value);
            } catch (error) {
                // the text is selected, Ctrl+C works too
            }
        });

        $q('#q-import').addEventListener('click', function () {
            if (io.hidden) {
                io.hidden = false;
                io.value = '';
                io.focus();
                return;
            }

            const parsed = parseJSON(io.value);

            if (!parsed || typeof parsed !== 'object') {
                window.alert('That is not valid settings JSON.');
                return;
            }

            if (!window.confirm('Replace your current settings with the pasted ones and reload?')) {
                return;
            }

            Object.assign(settings, mergeSettings(defaultSettings(), parsed));
            saveSettings();
            window.location.reload();
        });
    }

    function setupIntervalInput() {
        const input = $q('#q-interval');

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

    function setupShortcuts() {
        document.addEventListener('keydown', function (event) {
            if (!event.altKey || event.ctrlKey || event.metaKey || event.repeat) {
                return;
            }

            if (event.code === 'KeyK') {
                event.preventDefault();
                setCollapsed(!settings.collapsed);
            } else if (event.code === 'KeyP') {
                event.preventDefault();
                setAuto(!settings.auto);
            }
        });
    }

    // ============================================================
    // DRAGGING (pointer events: mouse, touch and pen)
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

        fitPanel(panel);
    }

    // The panel body scrolls instead of being cut off: its max height is
    // whatever room is left between the panel top and the window bottom.
    function fitPanel(panel) {
        const head = panel.querySelector('.q-head');
        const top = panel.getBoundingClientRect().top;
        const room = window.innerHeight - top - (head ? head.offsetHeight : 40) - 16;
        const value = `${Math.max(160, Math.floor(room))}px`;

        if (panel.style.getPropertyValue('--q-maxh') !== value) {
            panel.style.setProperty('--q-maxh', value);
        }
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
        const handle = $q('#q-head');

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
            if (panelDragging) {
                placePanel(panel, event.clientX - offsetX, event.clientY - offsetY);
            }
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
    // REFRESH (background merge, backoff, health) + TICKER
    // ============================================================

    function applyRefreshedTable() {
        refreshColumns();
        applyTable();
        fixHeaderContrast();
        detectGone();
        updateCount();
        openAssignInNewTab();

        checkForNewProofs(collectProofs(dataRows()));

        // A new day may have started since the page was opened.
        assigned = loadAssigned();
        renderAssigned();
        renderDACounts();

        setLastCheck(`Last check: ${formatTime(new Date())}`);
    }

    function rowProofId(tr, col) {
        const cell = tr.children[(col || COLS.proof) - 1];

        return cell && cell.tagName === 'TD' ? normalize(cell.textContent) : '';
    }

    function rowSignature(tr) {
        const links = Array.from(tr.querySelectorAll('a'))
            .map((a) => a.getAttribute('href') || '')
            .join('|');

        return `${normalize(tr.textContent)}||${links}`;
    }

    // Keeps rows that did not change (same DOM nodes, so handlers the site
    // attached to them survive) and only brings in new / changed rows.
    function mergeRows(liveBody, freshBody, col) {
        const liveMap = new Map();
        const result = { kept: 0, added: 0, dropped: 0 };

        Array.from(liveBody.rows).forEach((tr) => {
            const id = rowProofId(tr, col);

            if (id && !liveMap.has(id)) {
                liveMap.set(id, tr);
            }
        });

        const fragment = document.createDocumentFragment();

        Array.from(freshBody.rows).forEach((freshRow) => {
            const id = rowProofId(freshRow, col);
            const liveRow = id ? liveMap.get(id) : null;

            if (liveRow && rowSignature(liveRow) === rowSignature(freshRow)) {
                liveMap.delete(id);
                fragment.appendChild(liveRow);
                result.kept++;
            } else {
                fragment.appendChild(document.importNode(freshRow, true));
                result.added++;
            }
        });

        result.dropped = liveBody.rows.length - result.kept;
        liveBody.replaceChildren(fragment);

        return result;
    }

    function isSelectionActive() {
        return SKIP_RELOAD_IF_CHECKED &&
            Boolean($q('#resultTable tbody input[type="checkbox"]:checked'));
    }

    let refreshing = false;

    function refreshFailed(error) {
        failCount++;

        // Wait longer after each failure: interval x 2, x 4, ... up to the cap.
        const wait = Math.min(settings.reloadSeconds * Math.pow(2, failCount), MAX_BACKOFF_SECONDS);

        nextRefreshAt = Date.now() + wait * 1000;

        console.error('[Kapoy QC] Background refresh failed:', error);
        setLastCheck(`Refresh failed ${formatTime(new Date())} - retry in ${wait}s`);
        updateHealth();
    }

    async function backgroundRefresh() {
        if (refreshing) {
            return;
        }

        if (!$q('#resultTable tbody')) {
            window.location.reload();
            return;
        }

        refreshing = true;

        const started = Date.now();
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

            // Logged out / no access: a normal reload shows the login page.
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

            const live = $q('#resultTable tbody');

            if (!live) {
                window.location.reload();
                return;
            }

            // You ticked a box while the download was running: leave the rows alone.
            if (isSelectionActive()) {
                return;
            }

            const merged = mergeRows(live, fresh, COLS.proof);

            log('Refresh ok in', Date.now() - started, 'ms, rows', merged);

            failCount = 0;
            lastSuccessAt = Date.now();
            updateHealth();

            applyRefreshedTable();
        } catch (error) {
            refreshFailed(error);
        } finally {
            clearTimeout(timer);
            refreshing = false;
        }
    }

    function tick() {
        const label = $q('#q-countdown');

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
            const worker = new Worker(URL.createObjectURL(blob));

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
        document.addEventListener('visibilitychange', function () {
            if (document.visibilityState === 'visible') {
                newFlag = false;
                updateBadge();
            }

            tick();
        });
    }

    // ============================================================
    // CENTER THE RESULTS TABLE (it is wider than the page column)
    // ============================================================

    function centerTable() {
        const table = $q('#resultTable');

        if (!table) {
            return;
        }

        // Measure from its natural position, then shift it to the window center.
        table.style.transform = '';

        const rect = table.getBoundingClientRect();
        const view = document.documentElement.clientWidth;
        const pageLeft = rect.left + window.scrollX;
        let dx = (view - rect.width) / 2 - pageLeft;

        // Never push the left edge off-screen (a wider table scrolls to the right).
        if (pageLeft + dx < 8) {
            dx = 8 - pageLeft;
        }

        if (Math.abs(dx) >= 1) {
            table.style.transform = `translateX(${Math.round(dx)}px)`;
        }
    }

    function setupTableCentering() {
        const table = $q('#resultTable');

        if (!table) {
            return;
        }

        centerTable();

        window.addEventListener('resize', centerTable);

        // Rows with different content change the table width: center again.
        if ('ResizeObserver' in window) {
            new ResizeObserver(centerTable).observe(table);
        }
    }

    function setupNetworkEvents() {
        window.addEventListener('offline', updateHealth);

        window.addEventListener('online', function () {
            // Back online: try again right away instead of waiting out a backoff.
            nextRefreshAt = Date.now();
            updateHealth();
        });
    }

    // ============================================================
    // SELF-TEST (only with &kqcdebug=1: run kapoyQCSelfTest() in the console)
    // ============================================================

    function runSelfTest() {
        const results = [];

        function check(name, condition) {
            results.push({ test: name, pass: Boolean(condition) });
        }

        const host = document.createElement('div');

        host.innerHTML = `
            <table id="resultTable">
                <thead><tr><th></th><th>A</th><th>B</th><th>Proof ID</th><th>Queue</th><th>State</th><th>Created</th><th>Accepted DA</th><th>Target DA</th></tr></thead>
                <tbody>
                    <tr><td></td><td></td><td></td><td>1001</td><td>Standard</td><td>Open</td><td>2026-10-16 08:00</td><td>Edzmer Amarani</td><td></td></tr>
                </tbody>
            </table>`;

        const cols = detectColumns(host);

        check('columns by header',
            cols && cols.proof === 4 && cols.queue === 5 && cols.state === 6 &&
            cols.time === 7 && cols.da.join() === '8,9');

        const mk = (id, state) =>
            `<tr><td></td><td></td><td></td><td>${id}</td><td>Standard</td><td>${state}</td><td></td><td></td><td></td></tr>`;
        const live = document.createElement('tbody');
        const fresh = document.createElement('tbody');

        live.innerHTML = mk(1, 'Open') + mk(2, 'Open');
        fresh.innerHTML = mk(2, 'Open') + mk(3, 'Open');

        const keptNode = live.rows[1];
        const merged = mergeRows(live, fresh, 4);

        check('merge keeps unchanged row node', live.rows[0] === keptNode);
        check('merge adds new / drops gone',
            live.rows.length === 2 && merged.kept === 1 && merged.added === 1 && merged.dropped === 1);

        fresh.innerHTML = mk(2, 'Changed');
        mergeRows(live, fresh, 4);
        check('merge replaces a changed row', live.rows[0] !== keptNode);

        check('formatAge', formatAge(30000) === '<1m' && formatAge(5 * 60000) === '5m' &&
            formatAge(125 * 60000) === '2h 5m' && formatAge(49 * 3600000) === '2d 1h');
        check('parseWhen', parseWhen('2026-10-16 08:00') > 0 && parseWhen('nope') === 0);
        check('quiet hours across midnight',
            isQuietAt(23 * 60, 22 * 60, 6 * 60) && isQuietAt(2 * 60, 22 * 60, 6 * 60) &&
            !isQuietAt(12 * 60, 22 * 60, 6 * 60));
        check('quiet hours same-day', isQuietAt(10 * 60, 9 * 60, 17 * 60) && !isQuietAt(18 * 60, 9 * 60, 17 * 60));
        check('cleanNames', cleanNames([' A  b ', 'a b', '', 'C']).join('|') === 'A b|C');
        check('countOf', countOf([1, 2]) === 2 && countOf(3) === 3 && countOf(null) === 0);
        check('mergeSettings clamps',
            mergeSettings(defaultSettings(), { volume: 999, reloadSeconds: 1, quietFrom: 'bad' }).volume === 100 &&
            mergeSettings(defaultSettings(), { reloadSeconds: 1 }).reloadSeconds === MIN_RELOAD_SECONDS &&
            mergeSettings(defaultSettings(), { quietFrom: 'bad' }).quietFrom === '22:00');

        console.table(results);

        return results.every((r) => r.pass);
    }

    if (DEBUG) {
        window.kapoyQCSelfTest = runSelfTest;
        log('Debug on. Run kapoyQCSelfTest() in the console.');
    }

    // ============================================================
    // INITIALIZATION
    // ============================================================

    onReady(function () {
        function safe(name, fn) {
            try {
                fn();
            } catch (error) {
                console.error(`[Kapoy QC] ${name} failed:`, error);
            }
        }

        baseTitle = document.title;

        safe('columns', refreshColumns);
        safe('filter rows', applyTable);
        safe('header contrast', fixHeaderContrast);

        // Rows are filtered now, so they can be shown.
        document.documentElement.classList.remove('q-pending');

        safe('count', updateCount);
        safe('assign links', openAssignInNewTab);
        safe('assign tracking', setupAssignTracking);
        safe('storage sync', setupStorageSync);
        safe('user gesture', setupUserGesture);

        safe('new proofs', function () {
            checkForNewProofs(collectProofs(dataRows()));
        });

        safe('panel', createPanel);

        // Baseline for "proofs that left the list".
        previousIds = tableStats.ids;

        safe('shortcuts', setupShortcuts);
        safe('network', setupNetworkEvents);
        safe('ticker', startTicker);
        safe('center table', setupTableCentering);
    });

})();
