// ==UserScript==
// @name         Kapoy QC
// @namespace    http://tampermonkey.net/
// @version      1.7
// @description  Show only proofs of selected DAs, count, auto-reload (adjustable in the panel), per-proof desktop notifications, "assign to me" in new tab, dark/light theme, unified buttons/dropdowns, hide/show panel, assigned counter per DA, assigned history (30 days), background refresh (no page reload), new-proof beep, better fonts
// @match        https://mbo.minted.com/mbo/proofs?action=filter*
// @grant        none
// @run-at       document-start
// @require      https://code.jquery.com/jquery-3.7.1.min.js
// ==/UserScript==

(function ($) {
    'use strict';

    // ============================================================
    // CONFIG
    // ============================================================

    // Add/remove DA names ONLY here.
    const ALLOWED_DAS = [
        'Edzmer Amarani',
        'Jannel Tatoy',
        'Sherwin Jay Acruz'
    ];

    // Table columns (1-based, as used by nth-child):
    // 4 = Proof ID, 7 = Queue, 13 = State, 15 = Accepted DA, 16 = Target DA
    const COL_PROOF = 4;
    const COL_QUEUE = 7;
    const COL_STATE = 13;
    const DA_COLUMNS = [15, 16];

    // Reload interval is now changed in the panel. This is only the
    // starting value used the very first time (it is saved afterwards).
    const DEFAULT_RELOAD_SECONDS = 10;
    const MIN_RELOAD_SECONDS = 5;
    const MAX_RELOAD_SECONDS = 3600;

    // Theme used the very first time ('dark' or 'light'). Changed in the panel.
    const DEFAULT_THEME = 'dark';

    // true = skip a reload while any row checkbox is ticked,
    // so you don't lose your selection mid-action.
    const SKIP_RELOAD_IF_CHECKED = true;

    // true = notifications stay until dismissed. false = they auto-dismiss.
    const NOTIFICATION_STAYS_UNTIL_DISMISSED = true;

    // How many days of assigned history to keep (per-day lists).
    // The all-time totals per DA are never deleted.
    const HISTORY_DAYS = 30;

    // true = play a short beep when a new proof appears (along with the
    // desktop notification). Browsers only allow sound after you have
    // clicked or pressed a key on the page once, so click anywhere after
    // opening the tab. Volume is 0 (silent) to 1 (loudest).
    const NOTIFICATION_SOUND = true;
    const NOTIFICATION_SOUND_VOLUME = 0.2;

    // true  = refresh the table in the background (no page reload, keeps your
    //         scroll position and the panel). If anything on the page stops
    //         working after a refresh, set this to false to go back to a full reload.
    // false = full page reload like before.
    const USE_BACKGROUND_REFRESH = true;

    // Give up on a background refresh after this many milliseconds.
    const REFRESH_TIMEOUT_MS = 20000;

    // Forget "already notified" proofs that have not been on the page for this many days.
    const SEEN_MAX_DAYS = 7;

    const SEEN_KEY = 'Qchonon_Seen_Proofs';
    const SEEN_INIT_KEY = 'Qchonon_Seen_Initialized';
    const POSITION_KEY = 'Qchonon_Panel_Position';
    const THEME_KEY = 'Qchonon_Theme';
    const COLLAPSED_KEY = 'Qchonon_Panel_Collapsed';
    const RELOAD_KEY = 'Qchonon_Reload_Seconds';
    const ASSIGNED_KEY = 'Qchonon_Assigned_Today';
    const HISTORY_KEY = 'Qchonon_Assigned_History';

    // Message and color by workload. "max: Infinity" means no upper limit.
    // color = light theme, darkColor = dark theme.
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
    // SETTINGS (theme + reload interval, saved in localStorage)
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
            console.error('[Kapoy QC] Failed to save setting:', key, error);
        }
    }

    function clampSeconds(value) {
        const n = parseInt(value, 10);

        if (Number.isNaN(n)) {
            return DEFAULT_RELOAD_SECONDS;
        }

        return Math.max(MIN_RELOAD_SECONDS, Math.min(MAX_RELOAD_SECONDS, n));
    }

    let theme = readStorage(THEME_KEY) === 'light' ? 'light'
        : readStorage(THEME_KEY) === 'dark' ? 'dark'
        : DEFAULT_THEME;

    let reloadSeconds = readStorage(RELOAD_KEY)
        ? clampSeconds(readStorage(RELOAD_KEY))
        : DEFAULT_RELOAD_SECONDS;

    // Panel hidden (collapsed to its title bar) or shown. Saved between reloads.
    let collapsed = readStorage(COLLAPSED_KEY) === 'yes';

    // ============================================================
    // THEME (page + panel styles, injected immediately to avoid flashing)
    // ============================================================

    // Clean system font stack (Segoe UI on Windows). No external font loading needed.
    const FONT_STACK = "'Segoe UI Variable Text', 'Segoe UI', system-ui, -apple-system, Roboto, 'Helvetica Neue', Arial, sans-serif";

    // Page rules only apply to the page, never to the Kapoy QC panel.
    const PAGE = 'html.q-dark body > :not(#qchonon-panel)';

    function within(list) {
        return list.map((s) => `${PAGE} ${s}`).join(',\n');
    }

    // Like within(), but for BOTH themes (used for the unified controls)
    const ANY = 'html:root body > :not(#qchonon-panel)';

    function ui(list) {
        return list.map((s) => `${ANY} ${s}`).join(',\n');
    }

    function buildCss() {
        const transparentBg = [
            'html.q-dark body > div:not(#qchonon-panel)',
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

/* ---------- FONTS (both themes) ---------- */
html:root body,
html:root body > :not(#qchonon-panel),
html:root body > :not(#qchonon-panel) * {
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

/* ---------- PANEL ---------- */
#qchonon-panel {
    --q-bg: #171717; --q-head: #202020; --q-text: #f5f5f5; --q-muted: #999;
    --q-border: #333; --q-row: #292929; --q-green: #8ee09b; --q-amber: #f2c66d;
    --q-chip-bg: #473b24; --q-chip-zero-bg: #2a2a2a; --q-chip-zero: #888;
    --q-input-bg: #101010; --q-input-border: #444; --q-shadow: rgba(0,0,0,0.45);
    color-scheme: dark;
    position: fixed;
    top: 80px;
    right: 25px;
    width: 250px;
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
#qchonon-panel.q-light {
    --q-bg: #ffffff; --q-head: #f1f1f1; --q-text: #1b1b1b; --q-muted: #666;
    --q-border: #d6d6d6; --q-row: #eeeeee; --q-green: #2e7d32; --q-amber: #b26a00;
    --q-chip-bg: #fff0cf; --q-chip-zero-bg: #eeeeee; --q-chip-zero: #888;
    --q-input-bg: #ffffff; --q-input-border: #bbb; --q-shadow: rgba(0,0,0,0.2);
    color-scheme: light;
}
#qchonon-panel .q-head {
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
}
#qchonon-panel .q-grip { color: var(--q-muted); font-size: 18px; letter-spacing: -3px; }
#qchonon-panel .q-tools { display: inline-flex; align-items: center; gap: 8px; }
#qchonon-panel button#q-collapse {
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
#qchonon-panel button#q-collapse:hover { color: var(--q-text); border-color: var(--q-muted); }
#qchonon-panel.q-collapsed .q-body { display: none; }
#qchonon-panel.q-collapsed .q-head { border-bottom: none; }
#qchonon-panel .q-body { padding: 10px 12px 12px; }
#qchonon-panel .q-label {
    margin: 0 0 6px;
    color: var(--q-muted);
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.8px;
}
#qchonon-panel .q-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 4px 0;
}
#qchonon-panel .q-reload strong { font-size: 15px; color: var(--q-green); }
#qchonon-panel .q-reload strong.paused { color: var(--q-amber); font-size: 12px; }
#qchonon-panel .q-last { color: var(--q-muted); font-size: 11px; padding-bottom: 8px; }
#qchonon-panel .q-divider { height: 1px; margin: 6px 0 10px; background: var(--q-border); }
#qchonon-panel .q-da {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 6px 0;
    border-bottom: 1px solid var(--q-row);
}
#qchonon-panel .q-da:last-child { border-bottom: none; }
#qchonon-panel .q-count {
    min-width: 22px;
    padding: 2px 7px;
    border-radius: 4px;
    background: var(--q-chip-bg);
    color: var(--q-amber);
    font-weight: 700;
    text-align: center;
}
#qchonon-panel .q-count.zero { background: var(--q-chip-zero-bg); color: var(--q-chip-zero); }
#qchonon-panel .q-chips { display: inline-flex; align-items: center; gap: 6px; }
#qchonon-panel .q-count.q-assigned,
#qchonon-panel .q-count.q-tot {
    background: color-mix(in srgb, var(--q-green) 18%, transparent);
    color: var(--q-green);
}
#qchonon-panel .q-count.q-assigned.zero,
#qchonon-panel .q-count.q-tot.zero { background: var(--q-chip-zero-bg); color: var(--q-chip-zero); }
#qchonon-panel .q-label-row { display: flex; justify-content: space-between; align-items: center; }
#qchonon-panel .q-label-row span:last-child { font-size: 9px; letter-spacing: 0.4px; }
#qchonon-panel .q-foot {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-top: 8px;
    padding-top: 8px;
    border-top: 1px solid var(--q-border);
    color: var(--q-muted);
    font-size: 11px;
}
#qchonon-panel .q-foot-btns { display: inline-flex; gap: 6px; }
#qchonon-panel button.q-btn {
    padding: 2px 9px;
    background: transparent;
    color: var(--q-muted);
    border: 1px solid var(--q-border);
    border-radius: 5px;
    font-size: 11px;
    cursor: pointer;
}
#qchonon-panel button.q-btn:hover { color: var(--q-text); border-color: var(--q-muted); }
#qchonon-panel button.q-btn.q-danger:hover { color: #ef5350; border-color: #ef5350; }

/* ---------- HISTORY WINDOW ---------- */
#qchonon-panel .q-overlay {
    position: fixed;
    inset: 0;
    z-index: 1000000;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(0,0,0,0.5);
}
#qchonon-panel .q-overlay[hidden] { display: none; }
#qchonon-panel .q-modal {
    width: min(540px, 92vw);
    max-height: 82vh;
    display: flex;
    flex-direction: column;
    background: var(--q-bg);
    color: var(--q-text);
    border: 1px solid var(--q-border);
    border-radius: 10px;
    box-shadow: 0 12px 40px var(--q-shadow);
    overflow: hidden;
    font-size: 12px;
}
#qchonon-panel .q-modal-head {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 10px 14px;
    background: var(--q-head);
    border-bottom: 1px solid var(--q-border);
    font-size: 14px;
    font-weight: 700;
}
#qchonon-panel .q-modal-body { flex: 1; padding: 12px 14px; overflow: auto; }
#qchonon-panel .q-modal-foot {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 8px;
    padding: 8px 14px;
    border-top: 1px solid var(--q-border);
    color: var(--q-muted);
    font-size: 11px;
}
#qchonon-panel .q-hsec { margin-bottom: 14px; }
#qchonon-panel .q-hline {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 4px 0;
    border-bottom: 1px solid var(--q-row);
}
#qchonon-panel .q-hline:last-child { border-bottom: none; }
#qchonon-panel .q-hday-head {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 4px;
    padding-bottom: 4px;
    border-bottom: 1px solid var(--q-border);
    font-weight: 700;
}
#qchonon-panel .q-hda { padding: 4px 0; }
#qchonon-panel .q-hda-name { display: flex; justify-content: space-between; align-items: center; }
#qchonon-panel .q-proofs { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 4px; }
#qchonon-panel .q-proof {
    padding: 1px 6px;
    border-radius: 4px;
    background: var(--q-row);
    color: var(--q-text);
    font-size: 11px;
    font-variant-numeric: tabular-nums;
}
#qchonon-panel .q-proof .q-time { margin-left: 4px; color: var(--q-muted); font-size: 10px; }
#qchonon-panel .q-empty { padding: 18px 0; color: var(--q-muted); text-align: center; }
#qchonon-panel .q-note { color: var(--q-muted); font-size: 11px; }

#qchonon-panel input,
#qchonon-panel button { font-family: inherit; }
#qchonon-panel .q-count,
#qchonon-panel #q-countdown,
#qchonon-panel input.q-number { font-variant-numeric: tabular-nums; }
#qchonon-panel .q-interval {
    display: inline-flex;
    align-items: center;
    gap: 5px;
}
#qchonon-panel input.q-number {
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
#qchonon-panel input.q-number:focus { outline: none; border-color: var(--q-amber); }

#qchonon-panel .q-switch { position: relative; display: inline-block; width: 38px; height: 20px; margin: 0; }
#qchonon-panel .q-switch input { opacity: 0; width: 0; height: 0; position: absolute; }
#qchonon-panel .q-slider {
    position: absolute;
    inset: 0;
    background: #b5b5b5;
    border-radius: 20px;
    cursor: pointer;
    transition: background 0.2s;
}
#qchonon-panel .q-slider::before {
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
#qchonon-panel .q-switch input:checked + .q-slider { background: #4f8cff; }
#qchonon-panel .q-switch input:checked + .q-slider::before { transform: translateX(18px); }

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

/* Top navigation tabs (State Report, Orders, POs, Proofs, ...) */
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

/* select2 / chosen / jQuery UI dropdown widgets (the white "assignment" box) */
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

/* Their popup lists */
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

/* Disabled controls stay readable */
${ui(['select:disabled', 'input:disabled', 'button:disabled', '.select2-container--disabled .select2-selection'])} {
    opacity: 0.6;
    cursor: not-allowed;
}

/* Focus ring for everything */
${ui([
    'input[type="text"]:focus', 'input[type="number"]:focus', 'input[type="search"]:focus',
    'input:not([type]):focus', 'textarea:focus', 'select:focus', 'button:focus-visible'
])} {
    outline: none !important;
    border-color: var(--ql-primary-bg) !important;
    box-shadow: 0 0 0 3px var(--qf-focus) !important;
}

/* Checkboxes (Check All + row boxes) */
${ui(['input[type="checkbox"]', 'input[type="radio"]'])} {
    accent-color: var(--ql-primary-bg);
    cursor: pointer;
}
`;
    }

    function injectStyles() {
        const style = document.createElement('style');

        style.id = 'qchonon-styles';
        style.textContent = buildCss();

        // At document-start <head> may not exist yet.
        (document.head || document.documentElement).appendChild(style);
    }

    function applyTheme() {
        document.documentElement.classList.toggle('q-dark', theme === 'dark');

        const panel = document.getElementById('qchonon-panel');

        if (panel) {
            panel.classList.toggle('q-light', theme === 'light');
        }

        const toggle = document.getElementById('q-theme');
        const label = document.getElementById('q-theme-label');
        if (toggle) {
            toggle.checked = theme === 'dark';
        }

        if (label) {
            label.textContent = theme === 'dark' ? 'Dark' : 'Light';
        }
    }

    // Run right away so there is no white flash on each reload.
    injectStyles();
    applyTheme();

    // Hide table rows until filtering has run. Removed in init, with a
    // safety timer so rows can never stay hidden if something goes wrong.
    document.documentElement.classList.add('q-pending');
    setTimeout(function () {
        document.documentElement.classList.remove('q-pending');
    }, 4000);

    // ============================================================
    // HELPERS
    // ============================================================

    // lowercase name -> name exactly as written in ALLOWED_DAS
    const allowedLower = new Map(
        ALLOWED_DAS.map((name) => [name.trim().toLowerCase(), name])
    );

    function normalize(text) {
        return String(text || '').replace(/\s+/g, ' ').trim();
    }

    function cellText($row, column) {
        return normalize($row.children(`td:nth-child(${column})`).text());
    }

    function getMatchedDA($row) {
        for (const column of DA_COLUMNS) {
            const text = cellText($row, column);

            const match = allowedLower.get(text.toLowerCase());

            if (match) {
                return match;
            }
        }

        return '';
    }

    // ============================================================
    // SEEN PROOFS (so each proof notifies only once)
    // ============================================================

    let seenProofs = loadSeen();

    function loadSeen() {
        try {
            const parsed = JSON.parse(localStorage.getItem(SEEN_KEY));

            if (!parsed || typeof parsed !== 'object') {
                return {};
            }

            // Drop proofs not seen for SEEN_MAX_DAYS days (keeps the list small).
            const cutoff = Date.now() - SEEN_MAX_DAYS * 24 * 60 * 60 * 1000;

            Object.keys(parsed).forEach((id) => {
                if (Number(parsed[id]) < cutoff) {
                    delete parsed[id];
                }
            });

            return parsed;
        } catch (error) {
            return {};
        }
    }

    function saveSeen() {
        try {
            localStorage.setItem(SEEN_KEY, JSON.stringify(seenProofs));
        } catch (error) {
            console.error('[Kapoy QC] Failed to save seen proofs:', error);
        }
    }

    // ============================================================
    // ASSIGNED HISTORY (previous days, kept for HISTORY_DAYS days)
    // ============================================================
    // Shape: { since: 'YYYY-MM-DD',
    //          totals: { 'DA name': number },            (never deleted)
    //          days:   { 'YYYY-MM-DD': { 'DA name': [ { id, t } ] } } }
    // t = time of the click (ms). t = 0 means the time is unknown.

    function dateKeyFrom(d) {
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }

    function todayKey() {
        return dateKeyFrom(new Date());
    }

    function oldestKeptKey() {
        const d = new Date();

        d.setDate(d.getDate() - (HISTORY_DAYS - 1));

        return dateKeyFrom(d);
    }

    function loadHistory() {
        let h = null;

        try {
            h = JSON.parse(localStorage.getItem(HISTORY_KEY));
        } catch (error) {
            h = null;
        }

        if (!h || typeof h !== 'object') {
            h = {};
        }

        if (!h.totals || typeof h.totals !== 'object') {
            h.totals = {};
        }

        if (!h.days || typeof h.days !== 'object') {
            h.days = {};
        }

        if (!h.since) {
            h.since = todayKey();
        }

        return h;
    }

    function saveHistory(h) {
        // Drop per-day lists older than HISTORY_DAYS (the totals stay).
        const cutoff = oldestKeptKey();

        Object.keys(h.days).forEach((date) => {
            if (date < cutoff) {
                delete h.days[date];
            }
        });

        writeStorage(HISTORY_KEY, JSON.stringify(h));
    }

    // Adds one proof to a day. Returns true if it was new (so it counts once).
    function addToHistory(h, date, daName, proofID, time) {
        if (date < oldestKeptKey()) {
            return false;
        }

        const day = h.days[date] || (h.days[date] = {});
        const list = day[daName] || (day[daName] = []);

        if (list.some((entry) => entry.id === proofID)) {
            return false;
        }

        list.push({ id: proofID, t: time || 0 });
        h.totals[daName] = (h.totals[daName] || 0) + 1;

        return true;
    }

    // Copies a { DA: [proofIDs] } record (the daily counter) into the history.
    // Safe to run many times: proofs already there are skipped.
    function mergeDayIntoHistory(date, byDA) {
        if (!date || !byDA || typeof byDA !== 'object') {
            return;
        }

        const h = loadHistory();
        let changed = false;

        Object.keys(byDA).forEach((daName) => {
            (byDA[daName] || []).forEach((proofID) => {
                if (addToHistory(h, date, daName, String(proofID), 0)) {
                    changed = true;
                }
            });
        });

        if (changed) {
            saveHistory(h);
        }
    }

    // ============================================================
    // ASSIGNED TRACKER (+1 on the DA when you click "assign to me")
    // ============================================================
    // Saved per day and per proof ID, so clicking the same proof twice
    // counts once, and the numbers start fresh every new day.
    // Every click is also written to the history above.

    function loadAssigned() {
        try {
            const parsed = JSON.parse(localStorage.getItem(ASSIGNED_KEY));

            if (parsed && parsed.byDA && typeof parsed.byDA === 'object') {
                if (parsed.date === todayKey()) {
                    return parsed;
                }

                // A new day started: keep yesterday's numbers in the history.
                mergeDayIntoHistory(parsed.date, parsed.byDA);

                const fresh = { date: todayKey(), byDA: {} };

                writeStorage(ASSIGNED_KEY, JSON.stringify(fresh));

                return fresh;
            }
        } catch (error) {
            // fall through to a fresh record
        }

        return { date: todayKey(), byDA: {} };
    }

    let assigned = loadAssigned();

    function saveAssigned() {
        writeStorage(ASSIGNED_KEY, JSON.stringify(assigned));
    }

    function assignedCount(name) {
        return (assigned.byDA[name] || []).length;
    }

    function renderAssigned() {
        document.querySelectorAll('#qchonon-panel .q-assigned').forEach((el) => {
            const n = assignedCount(el.dataset.da);

            el.textContent = n;
            el.classList.toggle('zero', n === 0);
        });
    }

    function trackAssign($link) {
        // Re-read so several tabs / a day change stay in sync.
        assigned = loadAssigned();

        const $row = $link.closest('tr');
        const daName = getMatchedDA($row);
        const proofID = cellText($row, COL_PROOF);

        if (!daName || !proofID) {
            return;
        }

        const list = assigned.byDA[daName] || (assigned.byDA[daName] = []);

        if (list.includes(proofID)) {
            return;
        }

        list.push(proofID);

        saveAssigned();
        renderAssigned();

        // Also log it in the history, with the time of the click.
        const h = loadHistory();

        if (addToHistory(h, assigned.date, daName, proofID, Date.now())) {
            saveHistory(h);
        }
    }

    function setupAssignTracking() {
        // Left click, and middle click (open in new tab) both count.
        $(document).on('click auxclick', '#resultTable a.q-assign', function (event) {
            if (event.type === 'auxclick' && event.button !== 1) {
                return;
            }

            trackAssign($(this));
        });
    }

    function setupAssignedReset() {
        const button = document.getElementById('q-reset-assigned');

        button.addEventListener('click', function () {
            if (!window.confirm("Reset today's assigned counts to 0?\n(The history is kept.)")) {
                return;
            }

            assigned = { date: todayKey(), byDA: {} };

            saveAssigned();
            renderAssigned();
        });
    }

    // ============================================================
    // HISTORY WINDOW (view, copy, export, clear)
    // ============================================================

    let historyOpen = false;

    function formatClock(ms) {
        return ms
            ? new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
            : '';
    }

    function formatDay(key) {
        const parts = key.split('-').map(Number);
        const d = new Date(parts[0], parts[1] - 1, parts[2]);
        const label = d.toLocaleDateString([], {
            weekday: 'short',
            month: 'short',
            day: 'numeric'
        });

        if (key === todayKey()) {
            return `Today · ${label}`;
        }

        return label;
    }

    function dayTotal(day) {
        return Object.keys(day).reduce((sum, name) => sum + day[name].length, 0);
    }

    function renderHistory() {
        const body = document.getElementById('q-history-body');
        const note = document.getElementById('q-history-note');
        const h = loadHistory();
        const dates = Object.keys(h.days)
            .filter((date) => dayTotal(h.days[date]) > 0)
            .sort()
            .reverse();

        // DAs from the config first, then any others that appear in the data.
        const names = ALLOWED_DAS.slice();

        Object.keys(h.totals).forEach((name) => {
            if (!names.includes(name)) {
                names.push(name);
            }
        });

        const grand = names.reduce((sum, name) => sum + (h.totals[name] || 0), 0);

        let html = '';

        html += `
            <div class="q-hsec">
                <div class="q-label q-label-row">
                    <span>ALL-TIME TOTAL</span>
                    <span>SINCE ${escapeHtml(formatDay(h.since).replace('Today · ', ''))}</span>
                </div>
                ${names.map((name) => `
                    <div class="q-hline">
                        <span>${escapeHtml(name)}</span>
                        <span class="q-count q-tot ${h.totals[name] ? '' : 'zero'}">${h.totals[name] || 0}</span>
                    </div>
                `).join('')}
                <div class="q-hline">
                    <strong>Total</strong>
                    <span class="q-count q-tot ${grand ? '' : 'zero'}">${grand}</span>
                </div>
            </div>
        `;

        if (!dates.length) {
            html += '<div class="q-empty">No assigned proofs recorded yet.</div>';
        }

        dates.forEach((date) => {
            const day = h.days[date];

            html += `
                <div class="q-hsec">
                    <div class="q-hday-head">
                        <span>${escapeHtml(formatDay(date))}</span>
                        <span class="q-count q-tot">${dayTotal(day)}</span>
                    </div>
                    ${names.filter((name) => day[name] && day[name].length).map((name) => `
                        <div class="q-hda">
                            <div class="q-hda-name">
                                <span>${escapeHtml(name)}</span>
                                <span class="q-count q-tot">${day[name].length}</span>
                            </div>
                            <div class="q-proofs">
                                ${day[name].map((entry) => `
                                    <span class="q-proof">${escapeHtml(entry.id)}${entry.t ? `<span class="q-time">${escapeHtml(formatClock(entry.t))}</span>` : ''}</span>
                                `).join('')}
                            </div>
                        </div>
                    `).join('')}
                </div>
            `;
        });

        body.innerHTML = html;
        note.textContent = `Daily lists: last ${HISTORY_DAYS} days`;
    }

    function historyToCsv() {
        const h = loadHistory();
        const rows = [['Date', 'Time', 'DA', 'Proof ID']];
        const flat = [];

        Object.keys(h.days).forEach((date) => {
            Object.keys(h.days[date]).forEach((name) => {
                h.days[date][name].forEach((entry) => {
                    flat.push({ date: date, t: entry.t, name: name, id: entry.id });
                });
            });
        });

        flat.sort((a, b) => (a.date === b.date ? b.t - a.t : a.date < b.date ? 1 : -1));

        flat.forEach((item) => {
            rows.push([
                item.date,
                item.t ? new Date(item.t).toLocaleTimeString([], { hour12: false }) : '',
                item.name,
                item.id
            ]);
        });

        return rows
            .map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(','))
            .join('\r\n');
    }

    function flashLabel(button, text) {
        const original = button.dataset.label || button.textContent;

        button.dataset.label = original;
        button.textContent = text;

        setTimeout(function () {
            button.textContent = original;
        }, 1500);
    }

    function copyText(text) {
        if (navigator.clipboard && navigator.clipboard.writeText) {
            return navigator.clipboard.writeText(text);
        }

        return new Promise(function (resolve, reject) {
            const box = document.createElement('textarea');

            box.value = text;
            box.style.position = 'fixed';
            box.style.opacity = '0';
            document.body.appendChild(box);
            box.select();

            try {
                document.execCommand('copy') ? resolve() : reject(new Error('copy failed'));
            } catch (error) {
                reject(error);
            } finally {
                box.remove();
            }
        });
    }

    function openHistory() {
        renderHistory();

        document.getElementById('q-history').hidden = false;
        historyOpen = true;
    }

    function closeHistory() {
        document.getElementById('q-history').hidden = true;
        historyOpen = false;
    }

    function setupHistory() {
        const overlay = document.getElementById('q-history');

        document.getElementById('q-open-history').addEventListener('click', openHistory);
        document.getElementById('q-history-close').addEventListener('click', closeHistory);

        // Click on the dark area outside the window closes it.
        overlay.addEventListener('mousedown', function (event) {
            if (event.target === overlay) {
                closeHistory();
            }
        });

        document.addEventListener('keydown', function (event) {
            if (event.key === 'Escape' && historyOpen) {
                closeHistory();
            }
        });

        document.getElementById('q-history-copy').addEventListener('click', function () {
            const button = this;

            copyText(historyToCsv()).then(
                function () { flashLabel(button, 'Copied!'); },
                function () { flashLabel(button, 'Failed'); }
            );
        });

        document.getElementById('q-history-export').addEventListener('click', function () {
            const blob = new Blob(['\ufeff' + historyToCsv()], { type: 'text/csv;charset=utf-8' });
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');

            link.href = url;
            link.download = `kapoy-qc-history-${todayKey()}.csv`;
            link.style.display = 'none';
            document.body.appendChild(link);
            link.click();
            link.remove();

            setTimeout(function () {
                URL.revokeObjectURL(url);
            }, 1000);
        });

        document.getElementById('q-history-clear').addEventListener('click', function () {
            if (!window.confirm("Clear the whole assigned history?\nThis also resets today's counts to 0.")) {
                return;
            }

            writeStorage(HISTORY_KEY, JSON.stringify({
                since: todayKey(),
                totals: {},
                days: {}
            }));

            assigned = { date: todayKey(), byDA: {} };

            saveAssigned();
            renderAssigned();
            renderHistory();
        });
    }

    // ============================================================
    // FILTER + COUNT + ASSIGN LINKS
    // ============================================================

    function filterRows() {
        $('#resultTable tbody tr').each(function () {
            const $row = $(this);

            // Skip rows without data cells.
            if (!$row.children('td').length) {
                return;
            }

            $row.toggle(Boolean(getMatchedDA($row)));
        });
    }

    function updateCount() {
        const count = $('#resultTable tbody tr:visible').length;

        const level = LEVELS.find(
            (item) => count >= item.min && count <= item.max
        ) || LEVELS[LEVELS.length - 1];

        $('div.warning')
            .text(level.message(count))
            .css('color', theme === 'dark' ? level.darkColor : level.color);
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
    // WINDOWS DESKTOP NOTIFICATIONS
    // ============================================================

    function requestNotificationPermission() {
        if (!('Notification' in window)) {
            console.log('[Kapoy QC] Notifications are not supported.');
            return;
        }

        if (Notification.permission === 'default') {
            Notification.requestPermission().catch((error) => {
                console.error('[Kapoy QC] Permission error:', error);
            });
        }
    }

    // ---- Beep (Web Audio, no sound file needed) ----
    let audioContext = null;

    function setupSound() {
        if (!NOTIFICATION_SOUND) {
            return;
        }

        // Browsers block sound until the page got a click or key press.
        function unlock() {
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

            // Two quick notes: a soft "ding-ding".
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
        if (!('Notification' in window)) {
            return;
        }

        if (Notification.permission !== 'granted') {
            return;
        }

        try {
            const notification = new Notification(title, {
                body: body,
                tag: tag, // unique per proof, so they don't replace each other
                requireInteraction: NOTIFICATION_STAYS_UNTIL_DISMISSED
            });

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

    // Reads proofs of the allowed DAs from the given rows.
    function collectProofs($rows) {
        const proofs = [];

        $rows.each(function () {
            const $row = $(this);

            if (!$row.children('td').length) {
                return;
            }

            const daName = getMatchedDA($row);
            const proofID = cellText($row, COL_PROOF);

            if (!daName || !proofID) {
                return;
            }

            proofs.push({
                proofID: proofID,
                daName: daName,
                queue: cellText($row, COL_QUEUE),
                state: cellText($row, COL_STATE)
            });
        });

        return proofs;
    }

    function checkForNewProofs(proofs) {
        if (!proofs.length) {
            return;
        }

        const now = Date.now();

        // "First run" is remembered in its own flag, so pruning old entries
        // can never make the script think it is running for the first time.
        const initialized =
            readStorage(SEEN_INIT_KEY) === 'yes' ||
            Object.keys(seenProofs).length > 0;

        writeStorage(SEEN_INIT_KEY, 'yes');

        // First run: treat everything currently shown as already seen,
        // so there is no notification storm when the script first loads.
        if (!initialized) {
            proofs.forEach((proof) => {
                seenProofs[proof.proofID] = now;
            });

            saveSeen();
            return;
        }

        const newProofs = proofs.filter((proof) => !seenProofs[proof.proofID]);

        // One beep per batch of new proofs.
        if (newProofs.length) {
            beep();
        }

        // One notification per proof.
        newProofs.forEach((p) => {
            notify(
                `New Proof - ${p.daName}`,
                `Proof ${p.proofID} • ${p.queue || 'Unknown Queue'}`,
                `qchonon-proof-${p.proofID}`
            );
        });

        // Refresh the timestamp of every proof still on the page, so a proof
        // that stays for days is not forgotten and notified a second time.
        proofs.forEach((proof) => {
            seenProofs[proof.proofID] = now;
        });

        saveSeen();
    }

    // ============================================================
    // STATUS PANEL (theme switch, reload interval, countdown, DA names)
    // ============================================================

    function escapeHtml(value) {
        return String(value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    function getDACounts() {
        const counts = {};

        ALLOWED_DAS.forEach((name) => {
            counts[name] = 0;
        });

        $('#resultTable tbody tr:visible').each(function () {
            const daName = getMatchedDA($(this));

            if (daName) {
                counts[daName]++;
            }
        });

        return counts;
    }

    function renderDACounts() {
        const counts = getDACounts();

        document.querySelectorAll('#qchonon-panel .q-show').forEach((el) => {
            const n = counts[el.dataset.da] || 0;

            el.textContent = n;
            el.classList.toggle('zero', n === 0);
        });
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

    // Countdown state (shared so the interval box can reset it).
    let remaining = reloadSeconds;
    let intervalEditing = false;

    function createPanel() {
        if (document.getElementById('qchonon-panel')) {
            return;
        }

        const panel = document.createElement('div');

        panel.id = 'qchonon-panel';

        panel.innerHTML = `
            <div class="q-head" id="q-head"><span>Kapoy QC</span><span class="q-tools"><button type="button" id="q-collapse" title="Hide panel">▾</button><span class="q-grip">⋮⋮</span></span></div>
            <div class="q-body">
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
                    <span>Every</span>
                    <span class="q-interval">
                        <input class="q-number" id="q-interval" type="number"
                               min="${MIN_RELOAD_SECONDS}" max="${MAX_RELOAD_SECONDS}"
                               value="${reloadSeconds}">
                        <span>sec</span>
                    </span>
                </div>
                <div class="q-row q-reload">
                    <span>Reloading in</span>
                    <strong id="q-countdown">--</strong>
                </div>
                <div class="q-last" id="q-last"></div>
                <div class="q-divider"></div>

                <div class="q-label q-label-row">
                    <span>DA NAMES</span>
                    <span>SHOWING · ASSIGNED</span>
                </div>
                <div id="q-das"></div>
                <div class="q-foot">
                    <span>Resets daily</span>
                    <span class="q-foot-btns">
                        <button type="button" class="q-btn" id="q-open-history">History</button>
                        <button type="button" class="q-btn" id="q-reset-assigned">Reset</button>
                    </span>
                </div>
            </div>

            <div class="q-overlay" id="q-history" hidden>
                <div class="q-modal">
                    <div class="q-modal-head">
                        <span>Assigned history</span>
                        <button type="button" class="q-btn" id="q-history-close" title="Close">✕</button>
                    </div>
                    <div class="q-modal-body" id="q-history-body"></div>
                    <div class="q-modal-foot">
                        <span class="q-note" id="q-history-note"></span>
                        <span class="q-foot-btns">
                            <button type="button" class="q-btn" id="q-history-copy">Copy</button>
                            <button type="button" class="q-btn" id="q-history-export">Export</button>
                            <button type="button" class="q-btn q-danger" id="q-history-clear">Clear</button>
                        </span>
                    </div>
                </div>
            </div>
        `;

        document.body.appendChild(panel);

        const counts = getDACounts();

        document.getElementById('q-das').innerHTML = ALLOWED_DAS
            .map((name) => `
                <div class="q-da">
                    <span>${escapeHtml(name)}</span>
                    <span class="q-chips">
                        <span class="q-count q-show ${counts[name] ? '' : 'zero'}" data-da="${escapeHtml(name)}" title="Proofs showing now">${counts[name]}</span>
                        <span class="q-count q-assigned zero" data-da="${escapeHtml(name)}" title="Assigned to me today">0</span>
                    </span>
                </div>
            `)
            .join('');

        document.getElementById('q-last').textContent =
            `Last check: ${formatTime(new Date())}`;

        setupThemeSwitch();
        setupCollapse(panel);
        setupIntervalInput();
        setupAssignedReset();
        setupHistory();
        renderAssigned();

        applyTheme();
        restorePanelPosition(panel);
        makePanelDraggable(panel);
    }

    function setupThemeSwitch() {
        const toggle = document.getElementById('q-theme');

        toggle.addEventListener('change', function () {
            theme = toggle.checked ? 'dark' : 'light';

            writeStorage(THEME_KEY, theme);
            applyTheme();
            updateCount(); // refresh message color for the new theme
        });
    }

    // Hide / show the panel body (the title bar stays so you can bring it back).
    function applyCollapsed(panel) {
        const button = document.getElementById('q-collapse');

        panel.classList.toggle('q-collapsed', collapsed);

        if (button) {
            button.textContent = collapsed ? '▸' : '▾';
            button.title = collapsed ? 'Show panel' : 'Hide panel';
        }

        // The panel height changed, so keep it fully on screen.
        const rect = panel.getBoundingClientRect();

        if (panel.style.left) {
            placePanel(panel, rect.left, rect.top);
        }
    }

    function setupCollapse(panel) {
        const button = document.getElementById('q-collapse');

        button.addEventListener('click', function () {
            collapsed = !collapsed;

            writeStorage(COLLAPSED_KEY, collapsed ? 'yes' : 'no');
            applyCollapsed(panel);
        });

        applyCollapsed(panel);
    }

    function setupIntervalInput() {
        const input = document.getElementById('q-interval');

        function apply() {
            reloadSeconds = clampSeconds(input.value);

            input.value = reloadSeconds;
            writeStorage(RELOAD_KEY, String(reloadSeconds));

            // Restart the countdown with the new value.
            remaining = reloadSeconds;
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
    // DRAGGING (position is saved, so it survives page reloads)
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
        try {
            const saved = JSON.parse(localStorage.getItem(POSITION_KEY));

            if (
                saved &&
                typeof saved.left === 'number' &&
                typeof saved.top === 'number'
            ) {
                placePanel(panel, saved.left, saved.top);
            }
        } catch (error) {
            console.error('[Kapoy QC] Failed to restore position:', error);
        }
    }

    function savePanelPosition(panel) {
        const rect = panel.getBoundingClientRect();

        try {
            localStorage.setItem(
                POSITION_KEY,
                JSON.stringify({ left: rect.left, top: rect.top })
            );
        } catch (error) {
            console.error('[Kapoy QC] Failed to save position:', error);
        }
    }

    function makePanelDraggable(panel) {
        const handle = document.getElementById('q-head');

        if (!handle) {
            return;
        }

        let offsetX = 0;
        let offsetY = 0;

        handle.addEventListener('mousedown', function (event) {
            if (event.button !== 0 || event.target.closest('#q-collapse')) {
                return;
            }

            const rect = panel.getBoundingClientRect();

            panelDragging = true;
            offsetX = event.clientX - rect.left;
            offsetY = event.clientY - rect.top;

            placePanel(panel, rect.left, rect.top);

            event.preventDefault();
        });

        document.addEventListener('mousemove', function (event) {
            if (!panelDragging) {
                return;
            }

            placePanel(panel, event.clientX - offsetX, event.clientY - offsetY);
        });

        document.addEventListener('mouseup', function () {
            if (!panelDragging) {
                return;
            }

            panelDragging = false;
            savePanelPosition(panel);
        });

        // Keep the panel on screen if the window gets smaller.
        window.addEventListener('resize', function () {
            const rect = panel.getBoundingClientRect();

            placePanel(panel, rect.left, rect.top);
        });
    }

    // ============================================================
    // AUTO RELOAD (full page reload with visible countdown)
    // ============================================================

    // Re-runs everything that depends on the table after its rows changed.
    function applyRefreshedTable() {
        filterRows();
        updateCount();
        openAssignInNewTab();

        checkForNewProofs(collectProofs($('#resultTable tbody tr')));

        // A new day may have started since the page was opened.
        assigned = loadAssigned();
        renderAssigned();
        renderDACounts();

        setLastCheck(`Last check: ${formatTime(new Date())}`);
    }

    let refreshing = false;

    // Downloads the page in the background and swaps only the table rows.
    // No page reload: scroll position, selections and the panel stay as they are.
    async function backgroundRefresh() {
        if (refreshing) {
            return;
        }

        // No table on this page right now: fall back to a normal reload.
        if (!document.querySelector('#resultTable tbody')) {
            window.location.reload();
            return;
        }

        refreshing = true;

        const label = document.getElementById('q-countdown');

        if (label) {
            label.textContent = 'Refreshing...';
            label.className = '';
        }

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

            // No results table in the answer = most likely the login page
            // (session expired). Reload so you see it instead of stale data.
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

            live.replaceWith(document.importNode(fresh, true));

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

    function startCountdown() {
        remaining = reloadSeconds;

        const label = document.getElementById('q-countdown');

        function render() {
            if (!label) {
                return;
            }

            if (panelDragging) {
                label.textContent = 'Paused (moving)';
                label.className = 'paused';
            } else if (intervalEditing) {
                label.textContent = 'Paused (editing)';
                label.className = 'paused';
            } else if (historyOpen) {
                label.textContent = 'Paused (history)';
                label.className = 'paused';
            } else if (isSelectionActive()) {
                label.textContent = 'Paused (selected)';
                label.className = 'paused';
            } else {
                label.textContent = `${remaining}s`;
                label.className = '';
            }
        }

        render();

        setInterval(function () {
            if (panelDragging || intervalEditing || historyOpen || isSelectionActive()) {
                // Keep the countdown at full while dragging, editing, viewing history or selecting.
                remaining = reloadSeconds;
                render();
                return;
            }

            remaining--;

            if (remaining <= 0) {
                remaining = reloadSeconds;

                if (USE_BACKGROUND_REFRESH) {
                    backgroundRefresh();
                    return;
                }

                if (label) {
                    label.textContent = 'Reloading...';
                }

                window.location.reload();
                return;
            }

            render();
        }, 1000);
    }

    // ============================================================
    // INITIALIZATION
    // ============================================================

    $(function () {
        // Each step is isolated: if one fails, the others still run.
        function safe(name, fn) {
            try {
                fn();
            } catch (error) {
                console.error(`[Kapoy QC] ${name} failed:`, error);
            }
        }

        // Make sure today's counted proofs (including ones counted before
        // the history existed) are in the history. Safe to repeat.
        safe('history sync', function () {
            mergeDayIntoHistory(assigned.date, assigned.byDA);
        });

        safe('filter rows', filterRows);

        // Rows are filtered now, so they can be shown.
        document.documentElement.classList.remove('q-pending');

        safe('count', updateCount);
        safe('assign links', openAssignInNewTab);
        safe('assign tracking', setupAssignTracking);
        safe('notification permission', requestNotificationPermission);
        safe('sound', setupSound);

        // Compare the proofs on this page load with the ones seen before.
        safe('new proofs', function () {
            checkForNewProofs(collectProofs($('#resultTable tbody tr')));
        });

        safe('panel', createPanel);
        safe('countdown', startCountdown);
    });

})(jQuery);
