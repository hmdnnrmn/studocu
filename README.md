# studocu-unlock

Tampermonkey userscript for the Studocu document viewer: removes blur/paywall overlays, lifts the
rendered document content, and exports it as `.txt`, `.html`, or print-to-PDF.

```
studocu-unlock.user.js     the userscript
test/cdp.mjs               dependency-free Chrome DevTools Protocol client
test/run.mjs               44-assertion browser test suite over Studocu-shaped fixtures
test/live-run2.mjs         live end-to-end against the real site (search -> document)
test/probe-extract.mjs     structural probe for a document whose pages did not mount
```

## Install

Tampermonkey -> Create a new script -> paste `studocu-unlock.user.js` -> Ctrl+S.
Panel appears bottom-right; `Alt+S` toggles it.

## What each control does

| Control | Behaviour |
|---|---|
| Unlock page | Injects CSS that clears `filter/backdrop-filter/opacity/transform/clip-path/mask` on page containers, removes inline blur, deletes paywall/upsell nodes, and releases `overflow`, `pointer-events`, `user-select` and scroll locks. |
| Load all pages | Scrolls the window and any inner overflow container to the bottom, dispatching `scroll` events so lazy mounters fire. Use before exporting a long document. |
| Copy text | Extracts and writes to the clipboard. |
| Download .txt | Per-page text with `=== page N ===` markers and image URLs, plus a header note when pages were withheld server-side. |
| Download .html | Same content as standalone HTML (images referenced by absolute URL). |
| Print / Save PDF | Opens a print view; `Ctrl+P` -> Save as PDF. |

Console API: `scu.unlock()`, `scu.extract()`, `scu.exportTxt()`, `scu.exportHtml()`,
`scu.printView()`, `scu.autoScroll()`, `scu.findPages()`.

## Verification

`npm test` (needs Chrome installed; no npm dependencies) launches headless Chrome over CDP, serves
eight fixtures that reproduce the viewer variants, injects the userscript the way Tampermonkey does,
and asserts against computed styles and real DOM state.

```
44/44 passed
```

Covered: class-based blur, inline-style blur, grayscale+blur, fixed scrim overlays, text pages,
scanned-image decks with `srcset`/`data-src`, CSS background-image pages, `__NEXT_DATA__`-only
payloads, streamed page mounts, premium layouts with decoy wrappers, hashed gate modals matched by copy, cookie banners, blurred-preview exclusion,
document-start injection, double-injection guard, and zero uncaught exceptions.

`npm run test:live` drives the real site (search page -> document page) and reports what was
recovered. Verified against three documents:

| Document | Pages | Text | Images | Blocked previews | Export |
|---|---|---|---|---|---|
| Management Guidelines for Malaria (Premium) | 63 | 33,387 chars | 14 | 49 | 44,931 B txt |
| Management Guidelines for Malaria (Premium, second run) | 63 | 62 blocks | 14 | 49 | ok |
| MUET Speaking Session 1 (Premium) | 12 | 46,260 chars | 8 | 4 | 52,585 B txt |
| Ebook Kesatria Negara (free) | 56 | 6,340 chars (free page text) | 42 previews skipped | 42 | 6,604 B txt |

## Limits, measured not guessed

- **Server-side withholding is real.** Locked pages arrive as 140×181 `pages/blurred/pageN.webp`
  images. The unblurred siblings (`pages/pageN.webp`, `.png`, `.jpg`) were probed from inside the
  page and all 404. Nothing client-side recovers bytes the server never sent; those pages are
  counted in the export header instead of being silently dropped.
- **Downloads/quotas are server-enforced.** `/document/download` style endpoints check entitlement
  server-side. A userscript can change the page, not the account.
- **Cold navigations get a bot interstitial.** `studocu.com` returned `403 Access Blocked` from a
  datacenter IP with a headless user agent, cleared with a normal desktop UA. Document pages still
  serve a `Just a moment...` / `Bot Verification` challenge to cold navigations from this network;
  click-through from search results works. Normal browsing is unaffected.
- **Lazy mounts need a beat.** One document mounted its 56 pages only after two full scroll passes;
  the script retries on its own, and the panel's *Load all pages* button forces it.

Behaviour is verified against fixtures and three live documents; selector heuristics are hedged
(`[data-page-index]`, `.page-content`, `.document-page`, `.page`, `[id^="page-"]`) because Studocu
A/B-tests its viewer. If a variant misses, `scu.findPages()` in the console prints what the page
actually matched.

