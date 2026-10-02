// ==UserScript==
// @name         Kapoy QC
// @namespace    http://tampermonkey.net/
// @version      2.8
// @description  Show only proofs of selected DAs, count, auto-reload (adjustable in the panel), per-proof desktop notifications, "assign to me" in new tab, dark/light theme, unified buttons/dropdowns, hide/show panel, editable DA names (in the panel), Standard / Wedding queue tracker, assigned counter per DA, total assigned (today + all-time), background refresh (no page reload), new-proof beep, auto-reload on/off switch, better fonts, color-coded DAs and queues, grouped notifications, Settings section, single total
// @match        https://mbo.minted.com/mbo/proofs?action=filter*
// @updateURL    https://raw.githubusercontent.com/nicolelodeontv/kapoy-qc/main/Qchonon.user.js
// @downloadURL  https://raw.githubusercontent.com/nicolelodeontv/kapoy-qc/main/Qchonon.user.js
// @grant        none
// @run-at       document-start
// @require      https://code.jquery.com/jquery-3.7.1.min.js
// ==/UserScript==

(function ($) {
    'use strict';

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

    // Table columns (1-based, as used by nth-child):
    // 4 = Proof ID, 7 = Queue, 13 = State, 15 = Accepted DA, 16 = Target DA
    const COL_PROOF = 4;
    const COL_QUEUE = 7;
    const COL_STATE = 13;
    const DA_COLUMNS = [15, 16];

    // Queue types to track (showing + assigned today). A proof belongs to a
    // type when its Queue cell (column 7) contains that word, any capitals.
    const QUEUE_TYPES = ['Standard', 'Wedding'];

    // Colors that tell the DAs apart. They are given out in the order of the
    // DA list (first DA = first color, and so on; it repeats if you add more DAs
    // than there are colors). Change the hex values freely.
    // The DA names themselves stay in the normal text color (white in dark theme).
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

    // Colors for the queue types (Queue column + panel rows).
    const QUEUE_COLORS = {
        Standard: '#42a5f5',
        Wedding: '#f06292'
    };
    const QUEUE_FALLBACK_COLOR = '#9e9e9e';

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

    // New proofs are grouped into ONE popup per refresh (a summary per DA),
    // and a newer popup replaces the previous one, so only one is ever on screen.
    const NOTIFICATION_TAG = 'qchonon-new-proofs';

    // Seconds before a popup closes by itself (only when
    // NOTIFICATION_STAYS_UNTIL_DISMISSED is false).
    const NOTIFICATION_SECONDS = 6;

    // true = notifications stay until dismissed. false = they auto-dismiss.
    const NOTIFICATION_STAYS_UNTIL_DISMISSED = false;

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
    const AUTO_KEY = 'Qchonon_Auto_Reload';
    const ASSIGNED_KEY = 'Qchonon_Assigned_Today';
    const ALLTIME_KEY = 'Qchonon_Assigned_AllTime';
    const DAS_KEY = 'Qchonon_DA_Names';
    // Old history storage (removed in v2.0). Only used once to carry the
    // old all-time total over, then it is deleted.
    const OLD_HISTORY_KEY = 'Qchonon_Assigned_History';

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

    // Auto-reload on or off (switch in the panel). On by default. Saved between reloads.
    let autoReload = readStorage(AUTO_KEY) !== 'off';

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

/* ---------- DA / QUEUE COLORS (DA names stay in the normal text color) ---------- */
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
#qchonon-panel {
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
#qchonon-panel button#q-collapse,
#qchonon-panel button#q-settings-btn {
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
#qchonon-panel button#q-collapse:hover,
#qchonon-panel button#q-settings-btn:hover { color: var(--q-text); border-color: var(--q-muted); }
#qchonon-panel button#q-settings-btn.q-on { color: var(--q-text); border-color: var(--q-amber); }
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
    padding: 6px 0 6px 8px;
    border-bottom: 1px solid var(--q-row);
    border-left: 3px solid var(--q-rowcolor, transparent);
}
#qchonon-panel .q-da:last-child { border-bottom: none; }
/* Names and labels always stay on ONE line (long names get "...") */
#qchonon-panel .q-da > span:first-child,
#qchonon-panel .q-da > strong {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
}
#qchonon-panel .q-chips { flex: 0 0 auto; margin-left: 8px; }
#qchonon-panel .q-label,
#qchonon-panel .q-label-row span,
#qchonon-panel .q-row,
#qchonon-panel .q-last,
#qchonon-panel .q-foot { white-space: nowrap; }
/* Colored dot before each DA / queue name (the name text itself is unchanged) */
#qchonon-panel .q-da > span:first-child::before,
#qchonon-panel .q-da > strong::before {
    content: '';
    display: inline-block;
    width: 8px;
    height: 8px;
    margin-right: 7px;
    border-radius: 50%;
    background: var(--q-rowcolor, transparent);
}
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
#qchonon-panel .q-count.q-qassigned,
#qchonon-panel .q-count.q-tot {
    background: color-mix(in srgb, var(--q-green) 18%, transparent);
    color: var(--q-green);
}
#qchonon-panel .q-count.q-assigned.zero,
#qchonon-panel .q-count.q-qassigned.zero,
#qchonon-panel .q-count.q-tot.zero { background: var(--q-chip-zero-bg); color: var(--q-chip-zero); }
/* Counters take the color of their DA / queue (only when above 0) */
#qchonon-panel .q-da .q-count.q-show:not(.zero),
#qchonon-panel .q-da .q-count.q-assigned:not(.zero),
#qchonon-panel .q-da .q-count.q-qshow:not(.zero),
#qchonon-panel .q-da .q-count.q-qassigned:not(.zero) {
    background: color-mix(in srgb, var(--q-rowcolor) 22%, transparent);
    color: var(--q-rowcolor);
}
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

#qchonon-panel [hidden] { display: none !important; }
#qchonon-panel button.q-mini { margin-left: 6px; padding: 0 7px; font-size: 10px; letter-spacing: 0; }
#qchonon-panel button.q-save { color: var(--q-green); border-color: var(--q-green); }
#qchonon-panel textarea {
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
#qchonon-panel textarea:focus { outline: none; border-color: var(--q-amber); }
#qchonon-panel .q-note { margin: 4px 0 6px; color: var(--q-muted); font-size: 10px; }
#qchonon-panel .q-editor-btns { justify-content: flex-end; width: 100%; }

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

    function normalize(text) {
        return String(text || '').replace(/\s+/g, ' ').trim();
    }

    // Cleans a list of names: trims, drops empty ones and duplicates (any case).
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

    // DA names: the list saved from the panel, or the starting list above.
    function loadDANames() {
        try {
            const parsed = JSON.parse(localStorage.getItem(DAS_KEY));

            if (Array.isArray(parsed)) {
                const clean = cleanNames(parsed);

                if (clean.length) {
                    return clean;
                }
            }
        } catch (error) {
            // fall through to the starting list
        }

        return cleanNames(ALLOWED_DAS);
    }

    let currentDAs = loadDANames();

    // lowercase name -> name exactly as saved
    function buildAllowedMap() {
        return new Map(currentDAs.map((name) => [name.toLowerCase(), name]));
    }

    let allowedLower = buildAllowedMap();

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

    // Color of a DA, by its position in the DA list.
    function daColor(name) {
        const i = currentDAs.indexOf(name);

        return DA_COLORS[(i < 0 ? 0 : i) % DA_COLORS.length];
    }

    // Color of a queue type (Standard / Wedding).
    function queueColor(name) {
        return QUEUE_COLORS[name] || QUEUE_FALLBACK_COLOR;
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
    // ASSIGNED TRACKER (+1 on the DA when you click "assign to me")
    // ============================================================
    // TODAY: saved per day and per proof ID, so clicking the same proof
    // twice counts once, and the numbers start fresh every new day.
    // The "Reset" button sets today's numbers back to 0.
    //
    // The TOTAL for today is its own list of unique proof IDs (proofs),
    // so it never depends on the DA list. Per-DA and per-queue lists
    // are extra breakdowns.
    //
    // ALL-TIME: one running number that goes up by 1 for every newly
    // counted proof. It survives the daily reset and the Reset button.
    // Only "Clear all" sets it back to 0.
    // Shape: { since: 'YYYY-MM-DD', count: number }

    function dateKeyFrom(d) {
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }

    function todayKey() {
        return dateKeyFrom(new Date());
    }

    function ensureAssignedShape(a) {
        if (!a.byQueue || typeof a.byQueue !== 'object') {
            a.byQueue = {};
        }

        // Unique proofs assigned today (the real total). Built from the old
        // per-DA lists the first time, so today's existing count is kept.
        if (!Array.isArray(a.proofs)) {
            const all = new Set();

            Object.keys(a.byDA).forEach((name) => {
                (a.byDA[name] || []).forEach((id) => all.add(id));
            });

            a.proofs = Array.from(all);
        }

        return a;
    }

    function loadAssigned() {
        try {
            const parsed = JSON.parse(localStorage.getItem(ASSIGNED_KEY));

            if (parsed && parsed.byDA && typeof parsed.byDA === 'object') {
                if (parsed.date === todayKey()) {
                    return ensureAssignedShape(parsed);
                }

                // A new day started: today's numbers start from 0.
                const fresh = { date: todayKey(), byDA: {}, byQueue: {}, proofs: [] };

                writeStorage(ASSIGNED_KEY, JSON.stringify(fresh));

                return fresh;
            }
        } catch (error) {
            // fall through to a fresh record
        }

        return { date: todayKey(), byDA: {}, byQueue: {}, proofs: [] };
    }

    let assigned = loadAssigned();

    function saveAssigned() {
        writeStorage(ASSIGNED_KEY, JSON.stringify(assigned));
    }

    function assignedCount(name) {
        return (assigned.byDA[name] || []).length;
    }

    function assignedTodayTotal() {
        return (assigned.proofs || []).length;
    }

    function getQueueName($row) {
        const text = cellText($row, COL_QUEUE).toLowerCase();

        return QUEUE_TYPES.find((name) => text.includes(name.toLowerCase())) || '';
    }

    // Updates the Standard / Wedding rows: proofs showing now + assigned today.
    function renderQueueCounts() {
        const counts = {};

        QUEUE_TYPES.forEach((name) => {
            counts[name] = 0;
        });

        $('#resultTable tbody tr:visible').each(function () {
            const name = getQueueName($(this));

            if (name) {
                counts[name]++;
            }
        });

        document.querySelectorAll('#qchonon-panel .q-qshow').forEach((el) => {
            const n = counts[el.dataset.q] || 0;

            el.textContent = n;
            el.classList.toggle('zero', n === 0);
        });

        document.querySelectorAll('#qchonon-panel .q-qassigned').forEach((el) => {
            const n = ((assigned.byQueue || {})[el.dataset.q] || []).length;

            el.textContent = n;
            el.classList.toggle('zero', n === 0);
        });
    }

    function loadAllTime() {
        try {
            const parsed = JSON.parse(localStorage.getItem(ALLTIME_KEY));

            if (parsed && typeof parsed.count === 'number') {
                return parsed;
            }
        } catch (error) {
            // fall through
        }

        return null;
    }

    function saveAllTime(data) {
        writeStorage(ALLTIME_KEY, JSON.stringify(data));
    }

    // Runs once at startup. First time on v2.0 it carries the old history
    // total over (so the all-time number does not drop to 0), then deletes
    // the old history data.
    function initAllTime() {
        if (!loadAllTime()) {
            let count = 0;
            let since = todayKey();

            try {
                const old = JSON.parse(localStorage.getItem(OLD_HISTORY_KEY));

                if (old && old.totals && typeof old.totals === 'object') {
                    count = Object.keys(old.totals)
                        .reduce((sum, name) => sum + (Number(old.totals[name]) || 0), 0);

                    if (old.since) {
                        since = old.since;
                    }
                }
            } catch (error) {
                // no old history, start from 0
            }

            if (!count) {
                count = assignedTodayTotal();
            }

            saveAllTime({ since: since, count: count });
        }

        try {
            localStorage.removeItem(OLD_HISTORY_KEY);
        } catch (error) {
            // ignore
        }
    }

    function formatSince(key) {
        const parts = String(key || '').split('-').map(Number);

        if (parts.length !== 3 || parts.some(Number.isNaN)) {
            return '';
        }

        return new Date(parts[0], parts[1] - 1, parts[2]).toLocaleDateString([], {
            month: 'short',
            day: 'numeric',
            year: 'numeric'
        });
    }

    function renderAssigned() {
        document.querySelectorAll('#qchonon-panel .q-assigned').forEach((el) => {
            const n = assignedCount(el.dataset.da);

            el.textContent = n;
            el.classList.toggle('zero', n === 0);
        });

        renderQueueCounts();

        const todayTotal = assignedTodayTotal();
        const todayEl = document.getElementById('q-total-today');

        if (todayEl) {
            todayEl.textContent = todayTotal;
            todayEl.classList.toggle('zero', todayTotal === 0);
        }

        const allTime = loadAllTime() || { since: todayKey(), count: 0 };
        const allEl = document.getElementById('q-total-all');

        if (allEl) {
            allEl.textContent = allTime.count;
            allEl.classList.toggle('zero', allTime.count === 0);
            allEl.title = `All-time total since ${formatSince(allTime.since)}`;
        }
    }

    function trackAssign($link) {
        // Re-read so several tabs / a day change stay in sync.
        assigned = loadAssigned();

        const $row = $link.closest('tr');
        const proofID = cellText($row, COL_PROOF);

        if (!proofID) {
            console.warn('[Kapoy QC] Assign clicked but no proof ID found.');
            return;
        }

        // Same proof clicked twice today = counted once.
        if (assigned.proofs.includes(proofID)) {
            return;
        }

        assigned.proofs.push(proofID);

        // Per-DA count (only if the row matches a listed DA).
        const daName = getMatchedDA($row);

        if (daName) {
            const list = assigned.byDA[daName] || (assigned.byDA[daName] = []);

            if (!list.includes(proofID)) {
                list.push(proofID);
            }
        }

        // Per-queue count (Standard / Wedding).
        const queueName = getQueueName($row);

        if (queueName) {
            const queueList = assigned.byQueue[queueName] || (assigned.byQueue[queueName] = []);

            if (!queueList.includes(proofID)) {
                queueList.push(proofID);
            }
        }

        saveAssigned();

        // New proof counted today: add it to the all-time total too.
        const allTime = loadAllTime() || { since: todayKey(), count: 0 };

        allTime.count++;
        saveAllTime(allTime);

        renderAssigned();
    }

    function setupAssignTracking() {
        // Capture phase on document: runs before the site's own handlers,
        // so a stopPropagation() on the page can't hide the click from us.
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
        // Reset = today's assigned numbers back to 0.
        document.getElementById('q-reset-assigned').addEventListener('click', function () {
            if (!window.confirm("Reset today's assigned counts to 0?")) {
                return;
            }

            assigned = { date: todayKey(), byDA: {}, byQueue: {}, proofs: [] };

            saveAssigned();
            renderAssigned();
        });
    }

    // ============================================================
    // FILTER + COUNT + ASSIGN LINKS + COLORS
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

    // Colors each row by its DA (left bar + soft tint) and the Queue cell by
    // its queue type. The DA name cells are left alone, so names stay white.
    function colorRows() {
        $('#resultTable tbody tr').each(function () {
            const $row = $(this);

            if (!$row.children('td').length) {
                return;
            }

            const da = getMatchedDA($row);

            if (da) {
                $row[0].style.setProperty('--q-da', daColor(da));
                $row.addClass('q-colored');
            } else {
                $row.removeClass('q-colored');
            }

            const queue = getQueueName($row);
            const $queueCell = $row.children(`td:nth-child(${COL_QUEUE})`);

            if (queue && $queueCell.length) {
                $queueCell[0].style.setProperty('--q-queue', queueColor(queue));
                $queueCell.addClass('q-queue-cell');
            } else {
                $queueCell.removeClass('q-queue-cell');
            }
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
                tag: tag, // same tag = the new popup replaces the old one
                renotify: true, // still alert (sound/flash) when it replaces one
                requireInteraction: NOTIFICATION_STAYS_UNTIL_DISMISSED
            });

            // Windows may keep a popup in the Action Center, so close it ourselves.
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

    // One popup per batch: full details for a single proof, a short
    // per-DA summary when several arrive at once.
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

        // One grouped notification for the whole batch.
        if (newProofs.length) {
            notifyNewProofs(newProofs);
        }

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

        currentDAs.forEach((name) => {
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

        renderQueueCounts();
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
    let namesEditing = false;

    function createPanel() {
        if (document.getElementById('qchonon-panel')) {
            return;
        }

        const panel = document.createElement('div');

        panel.id = 'qchonon-panel';

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
                                   value="${reloadSeconds}">
                            <span>sec</span>
                        </span>
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
                        <span class="q-count q-tot zero" id="q-total-today" title="Total assigned to me today">0</span>
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
        setupAssignedReset();
        setupNamesEditor();
        renderAssigned();

        applyTheme();
        restorePanelPosition(panel);
        makePanelDraggable(panel);
    }

    // Draws the DA rows (name + showing + assigned) from the current list.
    function renderDAList() {
        const counts = getDACounts();

        document.getElementById('q-das').innerHTML = currentDAs
            .map((name) => `
                <div class="q-da" style="--q-rowcolor:${daColor(name)}">
                    <span title="${escapeHtml(name)}">${escapeHtml(name)}</span>
                    <span class="q-chips">
                        <span class="q-count q-show ${counts[name] ? '' : 'zero'}" data-da="${escapeHtml(name)}" title="Proofs showing now">${counts[name]}</span>
                        <span class="q-count q-assigned zero" data-da="${escapeHtml(name)}" title="Assigned to me today">0</span>
                    </span>
                </div>
            `)
            .join('');

        renderAssigned();
    }

    // Edit the DA names from the panel (saved in the browser).
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
            writeStorage(DAS_KEY, JSON.stringify(names));

            // Proofs of newly added DAs that are already on the page should not
            // fire "new proof" notifications, so mark them as seen first.
            const now = Date.now();

            collectProofs($('#resultTable tbody tr')).forEach((proof) => {
                if (!seenProofs[proof.proofID]) {
                    seenProofs[proof.proofID] = now;
                }
            });

            saveSeen();

            filterRows();
            colorRows();
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

    // Gear button: switch between the tracker and the Settings section, single total.
    function setupSettingsView(panel) {
        const button = document.getElementById('q-settings-btn');
        const back = document.getElementById('q-settings-back');
        const settings = document.getElementById('q-settings');
        const main = document.getElementById('q-main');

        function show(open) {
            settings.hidden = !open;
            main.hidden = open;
            button.classList.toggle('q-on', open);
            button.title = open ? 'Back to the tracker' : 'Settings';

            // Panel height changed: keep it fully on screen.
            const rect = panel.getBoundingClientRect();

            if (panel.style.left) {
                placePanel(panel, rect.left, rect.top);
            }
        }

        button.addEventListener('click', function () {
            show(settings.hidden);
        });

        back.addEventListener('click', function () {
            show(false);
        });
    }

    function setupAutoToggle() {
        const toggle = document.getElementById('q-auto');
        const label = document.getElementById('q-auto-label');

        function show() {
            toggle.checked = autoReload;
            label.textContent = autoReload ? 'On' : 'Off';
        }

        toggle.addEventListener('change', function () {
            autoReload = toggle.checked;

            writeStorage(AUTO_KEY, autoReload ? 'on' : 'off');

            // Start a fresh countdown when it is turned back on.
            remaining = reloadSeconds;

            show();
        });

        show();
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
            if (event.button !== 0 || event.target.closest('button')) {
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
        colorRows();
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

            if (!autoReload) {
                label.textContent = 'Off';
                label.className = 'paused';
            } else if (panelDragging) {
                label.textContent = 'Paused (moving)';
                label.className = 'paused';
            } else if (intervalEditing || namesEditing) {
                label.textContent = 'Paused (editing)';
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
            if (!autoReload || panelDragging || intervalEditing || namesEditing || isSelectionActive()) {
                // Keep the countdown at full while off, dragging, editing or selecting.
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

        // Sets up the all-time total (carries over the old history total once).
        safe('all-time total', initAllTime);

        safe('filter rows', filterRows);
        safe('color rows', colorRows);

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
