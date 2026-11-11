# Kapoy QC

A Tampermonkey userscript for the Minted MBO **proofs** page. It shows only the proofs of the DAs you pick, refreshes the list in the background, and alerts you when new ones arrive.

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/) in your browser.
2. Open the raw script: **[Qchonon.user.js](https://raw.githubusercontent.com/nicolelodeontv/kapoy-qc/main/Qchonon.user.js)**. Tampermonkey shows an install page; click Install.
3. Open the proofs page filtered by state 2070 (`https://mbo.minted.com/mbo/proofs?action=filter&state=2070...`).

The script only runs when the URL has `action=filter` and `state=2070`; everywhere else on the site it does nothing.

Updates: the script checks this repo every 6 hours and shows a popup (Update now / Later / Skip this version) when a newer `@version` is published. Settings > Updates > Check now checks immediately.

## What it does

- **DA filter and counts**: hides every proof that is not assigned to one of your DAs. The panel shows how many each DA has. Click a DA to show only that one.
- **Background refresh**: reloads the table data without reloading the page (every 5 to 3600 seconds). It backs off after failures, warns when data is stale, and pauses while you are using a dropdown, typing, or have a box ticked.
- **New proof alerts**: sound plus a desktop notification, grouped when several arrive together. Mute single DAs with the bell, set quiet hours, or stay quiet while the tab is in view.
- **Tab badge**: the tab title and icon show how many proofs are showing; a bell appears in the title when something new arrived in a background tab.
- **Proof age**: each proof shows how old it is, amber after 15 minutes and red after 30. Optional sorting: oldest first, Wedding first.
- **Assign tracking**: "assign to me" opens in a new tab and counts toward today's total. "Confirmed" counts clicked proofs that then left the list. The last 30 days are kept and can be exported as CSV.
- **Dark / light theme** for the page and the panel.
- **Settings backup**: export and import all settings as JSON.

### Keyboard shortcuts

| Keys  | Action                    |
| ----- | ------------------------- |
| Alt+K | Hide / show the panel     |
| Alt+P | Pause / resume auto-reload |

### Changing the DAs

Open the panel, then **DA NAMES > Edit**, and enter one name per line, spelled exactly like the DA column in the table. The starting list is `ALLOWED_DAS` near the top of the script and is used only until you save your own list.

## Privacy

Everything is stored in your browser's `localStorage` on the MBO site. The script makes two kinds of network requests: a refresh of the same proofs page you are on, and the version check against `raw.githubusercontent.com` (it reads only the `@version` line). Nothing is sent anywhere else.

## Troubleshooting

- Add `&kqcdebug=1` to the page URL to turn on logging, then run `kapoyQCSelfTest()` in the browser console to run the built-in checks.
- If notifications do not appear, open Settings > Alerts and press **Enable**, then **Test**. If it says Blocked, allow notifications for the site in your browser settings.
- If the table columns change on the site, the script finds them by header text and falls back to the fixed column numbers at the top of the script.

## Releasing a new version

Change the version in **both** places, and update `CHANGELOG`:

1. `// @version` in the script header (this is what the update check reads)
2. `const VERSION` near the top of the script

If they differ, installed copies will keep showing the update popup.
