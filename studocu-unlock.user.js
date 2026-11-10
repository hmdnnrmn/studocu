// ==UserScript==
// @name         Studocu Unlock + Export
// @namespace    local.studocu
// @version      1.1.0
// @description  Clears blur/paywall overlays on the rendered document viewer, extracts the full text, and exports TXT / print-to-PDF. Client-side only: works on what the browser already received.
// @author       hmdnnrmn
// @match        https://www.studocu.com/*
// @match        https://studocu.com/*
// @run-at       document-idle
// @noframes
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  if (window.__SCU_UNLOCK__) return;
  window.__SCU_UNLOCK__ = true;

  // ---------------------------------------------------------------- config

  const STYLE_ID = 'scu-unlock-style';
  const PANEL_ID = 'scu-panel';

  // Anything whose class/testid matches gets removed from layout. Kept narrow
  // on purpose: a broad `[class*=overlay]` sweep eats real document content.
  const KILL_SELECTORS = [
    '[data-testid="paywall"]',
    '[data-testid="paywall-overlay"]',
    '[data-testid="document-paywall"]',
    '[data-testid="upsell"]',
    '[data-testid="upsell-modal"]',
    '[class*="Paywall"]',
    '[class*="paywall"]',
    '[class*="UpsellBanner"]',
    '[class*="BlurOverlay"]',
    '[class*="blur-overlay"]',
    '[class*="premium-overlay"]',
    '[id*="paywall"]',
    '[id*="Paywall"]',
    '[class*="cookie" i]',
    '[id*="cookie" i]',
    '[class*="consent" i]',
    '[aria-label*="cookie" i]',
    'div[role="dialog"]'
  ];

  // Modal copy that only the gate renders. Used as a last-resort matcher for
  // overlays whose hashed class names carry no hint.
  const GATE_TEXT = /this is a preview|go premium|free trial|unlock all \d+ pages|become premium|already premium|read without ads|unlimited downloads/i;
  const GATE_HINT = /paywall|upsell|modal|gate|scrim|curtain|overlay|blur|preview|premium|login|signup|cta/i;

  // Blur is applied a dozen different ways across A/B variants; nuke all of them.
  const BLUR_STYLE_RE = /blur|grayscale|url\(#|opacity\s*:\s*0\.[0-4]/;

  // Container guesses for document pages, most specific first.
  const PAGE_SELECTORS = [
    '[data-page-index]',
    '.page-content',
    '[id^="page-"]',
    '.document-page',
    'article.page',
    '.page-container .page',
    '.page'
  ];

  const CONTENT_SELECTORS = [
    '.page-content',
    '.text-layer',
    '.document-content',
    '.page-body',
    '.doc-page-content'
  ];

  // Lines injected by upsell plumbing that must never land in an export.
  const JUNK_LINES = [
    /^unlock (the )?(full |complete )?document/i,
    /^sign up/i,
    /^log in$/i,
    /^continue reading/i,
    /^already (a )?member/i,
    /^this document (is|has been) (premium|locked)/i,
    /^you('| a)re (viewing|reading) (a|an) (preview|excerpt)/i,
    /^\d+ (pages? )?(left|remaining)/i,
    /^(download|upload)$/i,
    /^studocu(\.com)?$/i,
    /^(share|save|report)$/i,
    /^why is this page out of focus/i,
    /premium document/i,
    /become premium/i,
    /out of focus/i
  ];

  // ---------------------------------------------------------------- utils

  const log = (...a) => console.log('%c[scu]', 'color:#e0453f;font-weight:700', ...a);
  const warn = (...a) => console.warn('[scu]', ...a);

  /** Absolute URL from any attribute the viewer may use. */
  function absUrl(u) {
    if (!u) return '';
    try { return new URL(u, location.href).href; } catch { return ''; }
  }

  /** Largest candidate out of a srcset string. */
  function biggestSrcset(srcset) {
    let best = '';
    let bestW = -1;
    for (const part of String(srcset).split(',')) {
      const bits = part.trim().split(/\s+/);
      if (!bits[0]) continue;
      const w = parseFloat(bits[1]) || 0;
      if (w > bestW) { bestW = w; best = bits[0]; }
    }
    return absUrl(best);
  }

  /**
   * innerText honours layout and drops hidden text, but it is undefined in
   * non-rendering contexts and reflows on every read. textContent is the
   * fallback, with block boundaries rebuilt as newlines.
   */
  function textOf(el) {
    if (!el) return '';
    if (typeof el.innerText === 'string' && el.innerText.trim()) {
      return el.innerText.replace(/\u00a0/g, ' ');
    }
    const BLOCK = /^(P|DIV|LI|TR|H[1-6]|SECTION|ARTICLE|BLOCKQUOTE|PRE|TD|BR)$/;
    const out = [];
    (function walk(node) {
      for (const c of node.childNodes) {
        if (c.nodeType === 3) {
          out.push(c.nodeValue);
        } else if (c.nodeType === 1) {
          const tag = c.tagName;
          if (/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(tag)) continue;
          if (tag === 'BR') { out.push('\n'); continue; }
          const hidden = c.getAttribute && /(^|\s)(hidden|is-hidden)(\s|$)/.test(c.className || '') ||
            c.getAttribute('aria-hidden') === 'true';
          if (hidden) continue;
          const block = BLOCK.test(tag);
          if (block) out.push('\n');
          walk(c);
          if (block) out.push('\n');
        }
      }
    })(el);
    return out.join('').replace(/\u00a0/g, ' ');
  }

  function isJunkLine(line) {
    const t = line.trim();
    if (!t) return true;
    return JUNK_LINES.some((re) => re.test(t));
  }

  function download(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(url);
      a.remove();
    }, 4000);
  }

  function slug() {
    const t = (document.title || 'studocu')
      .replace(/\s*[|\-–]\s*Studocu.*$/i, '')
      .replace(/[^\w\d\- ]+/g, '')
      .trim()
      .replace(/\s+/g, '-')
      .toLowerCase();
    const idm = location.pathname.match(/(\d{5,})/);
    return `${t || 'document'}${idm ? '-' + idm[1] : ''}`;
  }

  // ---------------------------------------------------------------- unlock

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const el = document.createElement('style');
    el.id = STYLE_ID;
    el.textContent = `
      /* blur, whichever way it was applied */
      [class*="blur" i], [class*="Blur"] {
        filter: none !important;
        -webkit-filter: none !important;
        backdrop-filter: none !important;
        opacity: 1 !important;
      }
      /* kill the upsell furniture */
      ${KILL_SELECTORS.join(',\n      ')} { display: none !important; }
      /* free the scroll locks the viewer installs */
      html, body {
        overflow: auto !important;
        position: static !important;
        height: auto !important;
        max-height: none !important;
        pointer-events: auto !important;
        user-select: auto !important;
      }
      body * { pointer-events: auto !important; user-select: text !important; }
      .page, .page-content, [id^="page-"], [data-page-index] {
        filter: none !important;
        -webkit-filter: none !important;
        opacity: 1 !important;
        transform: none !important;
        clip-path: none !important;
        mask-image: none !important;
      }
    `;
    (document.head || document.documentElement).appendChild(el);
  }

  /** Clear inline blurs that stylesheets cannot reach. */
  function clearInlineBlur() {
    const nodes = document.querySelectorAll('[style*="blur" i],[style*="filter" i]');
    for (const n of nodes) {
      if (!n.style) continue;
      const f = n.style.filter || '';
      const wf = n.style.webkitFilter || '';
      if (BLUR_STYLE_RE.test(f) || BLUR_STYLE_RE.test(wf)) {
        n.style.filter = 'none';
        n.style.webkitFilter = 'none';
        n.style.opacity = '1';
      }
    }
  }

  /** Paywall overlays are frequently siblings, not classed. Sweep the viewers. */
  function killOverlays(root = document) {
    for (const sel of KILL_SELECTORS) {
      for (const n of root.querySelectorAll(sel)) n.remove();
    }

    // Fixed-position scrims sitting between the reader and the page: either
    // classed as gate furniture or hit-tested at the viewport centre points.
    const candidates = new Set(root.querySelectorAll(
      'body > div, body > section, [role="dialog"], [class*="modal" i], [class*="scrim" i], [class*="curtain" i], [class*="preview" i], [class*="cookie" i], [class*="consent" i], [style*="position:fixed"], [style*="position: fixed"]'
    ));
    const vw = innerWidth;
    const vh = innerHeight;
    for (const [fx, fy] of [[0.5, 0.5], [0.5, 0.25], [0.5, 0.85], [0.15, 0.5], [0.85, 0.5]]) {
      let stack = [];
      try { stack = document.elementsFromPoint(vw * fx, vh * fy); } catch { stack = []; }
      for (const el of stack) if (el !== document.body) candidates.add(el);
    }
    for (const n of candidates) {
      if (!n.isConnected || n === document.body || n === document.documentElement) continue;
      const cs = getComputedStyle(n);
      if (cs.position !== 'fixed' && cs.position !== 'absolute') continue;
      const r = n.getBoundingClientRect();
      if (r.width < vw * 0.35 || r.height < vh * 0.3) continue;
      const hint = n.className + ' ' + (n.id || '');
      const text = (n.innerText || '').slice(0, 400);
      if (!GATE_HINT.test(hint) && !GATE_TEXT.test(text)) continue;
      n.remove();
    }
  }

  function unlock() {
    injectStyle();
    clearInlineBlur();
    killOverlays();
    // Some variants set a body class that gates rendering.
    document.documentElement.classList.remove('is-blurred', 'blurred', 'paywalled');
    document.body && document.body.classList.remove('is-blurred', 'blurred', 'paywalled');
    log('unlock pass done');
  }

  // ---------------------------------------------------------------- extract

  /** A page node counts if it carries text, media, or a rendered background. */
  function hasContent(el) {
    if (textOf(el).trim().length > 0) return true;
    if (el.querySelector('img,canvas,svg,table,video')) return true;
    let budget = 60;
    for (const d of el.querySelectorAll('div[style*="background" i], div[class*="pc" i]')) {
      if (budget-- <= 0) break;
      if (/url\(/.test(getComputedStyle(d).backgroundImage || '')) return true;
    }
    return false;
  }

  /** Ordered list of page containers, de-duplicated. */
  function findPages() {
    let best = null;
    for (const sel of PAGE_SELECTORS) {
      // Nested matches (a wrapper that also matches `[id^="page-"]`) would
      // duplicate content once per level, so keep only the outermost.
      let list = [...document.querySelectorAll(sel)];
      list = list.filter((el) => !list.some((o) => o !== el && o.contains(el)));
      const usable = list.filter(hasContent);
      if (!usable.length) continue;
      if (!best || usable.length > best.length) best = usable;
    }
    if (!best) return [];
    return best.sort((a, b) => {
      const ai = a.getBoundingClientRect().top + scrollY;
      const bi = b.getBoundingClientRect().top + scrollY;
      return ai - bi;
    });
  }

  function pageText(el) {
    const text = textOf(el);
    const lines = text
      .split('\n')
      .map((l) => l.replace(/\s+$/g, ''))
      .filter((l) => !isJunkLine(l));
    // The viewer stamps a bare page number above the body text.
    if (lines.length && /^\s*\d{1,4}\s*$/.test(lines[0])) lines.shift();
    return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  /**
   * Rendered document pages ship as <img> on some variants and as CSS
   * background images on others, so both are scanned.
   */
  function collectImages(el) {
    const out = [];
    let blocked = 0;
    const push = (src) => {
      if (!src || src.startsWith('data:')) return;
      if (/(logo|avatar|icon|sprite|flag|pixel)/i.test(src)) return;
      if (!out.includes(src)) out.push(src);
    };

    for (const img of el.querySelectorAll('img')) {
      const srcset = biggestSrcset(img.getAttribute('srcset') || '');
      const lazy = absUrl(img.getAttribute('data-src') || img.getAttribute('data-original') || '');
      const live = absUrl(img.currentSrc || img.src || '');
      const src = srcset || lazy || live;
      if (!src || src.startsWith('data:')) continue;
      // Blurred previews are 140px-wide stand-ins for pages the server never
      // sent; exporting them adds noise, so they are counted, not included.
      if (/\/blurred\/|blurred_content/i.test(src) || /blurred/i.test(img.alt || '')) { blocked++; continue; }
      // The size gate exists to drop UI glyphs, avatars and tracking pixels.
      // It keys on the decoded size only: a page render that has not painted
      // yet reports 0 and its CSS box is often collapsed to 1px, so layout
      // dimensions cannot be trusted here.
      if (!srcset && !lazy) {
        const w = img.naturalWidth || 0;
        const h = img.naturalHeight || 0;
        if (w && h && w < 200 && h < 200) continue;
      }
      push(src);
    }

    if (out.length === 0) {
      // Bounded scan: rendered-page wrappers only, never every node on a page.
      const wraps = el.querySelectorAll('div[style*="background" i], div[class*="pc" i], div[class*="image" i], div[class*="page" i]');
      let budget = 200;
      for (const d of wraps) {
        if (budget-- <= 0) break;
        const bg = getComputedStyle(d).backgroundImage || '';
        if (!bg || bg === 'none') continue;
        const m = bg.match(/url\(["']?(.*?)["']?\)/);
        if (!m) continue;
        const src = absUrl(m[1]);
        if (/\/blurred\/|blurred_content/i.test(src)) { blocked++; continue; }
        push(src);
      }
    }

    return { imgs: out, blocked };
  }

  /** Pull any server-embedded document payload (Next.js/__NUXT__/JSON-LD). */
  function embeddedText() {
    const chunks = [];
    const CONTENT_KEY = /^(content|text|html|body|pages|pageText|documentContent|description|extractedText)$/i;
    const walk = (v, depth, key) => {
      if (depth > 14 || v == null) return;
      if (typeof v === 'string') {
        if (!CONTENT_KEY.test(key || '')) return;
        const s = v.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').trim();
        if (s.length > 60 && /\s/.test(s) && !/^https?:/.test(s)) chunks.push(s);
        return;
      }
      if (Array.isArray(v)) { v.forEach((x) => walk(x, depth + 1, key)); return; }
      if (typeof v === 'object') {
        for (const k of Object.keys(v)) walk(v[k], depth + 1, k);
      }
    };
    for (const sel of ['#__NEXT_DATA__', 'script[type="application/json"]']) {
      for (const s of document.querySelectorAll(sel)) {
        try { walk(JSON.parse(s.textContent), 0, ''); } catch { /* not json */ }
      }
    }
    return chunks;
  }

  /** Scroll the document, then any inner scroller the viewer installed. */
  async function autoScroll(ms = 250) {
    const step = Math.max(innerHeight * 0.9, 600);
    const start = scrollY;
    let y = 0;
    const h = () => document.documentElement.scrollHeight;
    while (y < h()) {
      y += step;
      scrollTo(0, y);
      // Lazy mounters listen for scroll; a programmatic jump does not always
      // fire it when the page is shorter than the viewport.
      dispatchEvent(new Event('scroll'));
      await new Promise((r) => setTimeout(r, ms));
      if (y > 200000) break; // runaway guard
    }
    scrollTo(0, start);
    dispatchEvent(new Event('scroll'));

    // Some variants put the pages inside their own overflow container, where
    // scrolling the window moves nothing.
    const inner = [...document.querySelectorAll('main, [role="main"], div[class*="viewer" i], div[class*="scroll" i]')]
      .filter((el) => {
        const cs = getComputedStyle(el);
        return /auto|scroll/.test(cs.overflowY) && el.scrollHeight > el.clientHeight + 200;
      })
      .slice(0, 2);
    for (const box of inner) {
      const top = box.scrollTop;
      for (let s = 0; s <= box.scrollHeight; s += step) {
        box.scrollTop = s;
        box.dispatchEvent(new Event('scroll', { bubbles: true }));
        await new Promise((r) => setTimeout(r, ms));
      }
      box.scrollTop = top;
    }

    await new Promise((r) => setTimeout(r, 400));
  }

  function extract() {
    unlock();
    const pages = findPages();
    const blocks = [];
    let imgTotal = 0;
    let blockedTotal = 0;

    for (const p of pages) {
      const text = pageText(p);
      const { imgs, blocked } = collectImages(p);
      imgTotal += imgs.length;
      blockedTotal += blocked;
      if (text || imgs.length) blocks.push({ text, imgs });
    }

    if (blocks.length === 0 || blocks.every((b) => !b.text)) {
      const emb = embeddedText();
      if (emb.length) {
        blocks.length = 0;
        blocks.push({ text: [...new Set(emb)].join('\n\n'), imgs: [] });
        warn('fell back to embedded JSON payload');
      }
    }

    return { blocks, pages: pages.length, images: imgTotal, blocked: blockedTotal };
  }

  function toText({ blocks, blocked }) {
    const parts = [];
    blocks.forEach((b, i) => {
      if (b.text) parts.push(`=== page ${i + 1} ===\n${b.text}`);
      if (b.imgs.length) parts.push(`=== page ${i + 1} images ===\n${b.imgs.join('\n')}`);
    });
    const head = [
      document.title,
      location.href,
      blocked ? `note: ${blocked} page(s) were never sent to the browser (server-side preview images)` : '',
      '',
    ].filter(Boolean).join('\n');
    return head + '\n' + parts.join('\n\n');
  }

  // ---------------------------------------------------------------- export

  /**
   * Extract, and if the viewer has mounted page shells but not their payload
   * yet, wait for it. Slow mounts are the common failure: a click right after
   * load would otherwise export one page out of fifty.
   */
  async function ensureContent() {
    let data = extract();
    if (!data.pages) {
      for (let i = 0; i < 3 && !data.pages; i++) {
        await new Promise((r) => setTimeout(r, 400));
        data = extract();
      }
      if (!data.pages) {
        log('no pages mounted, scrolling once');
        await autoScroll(140);
        data = extract();
      }
      return data;
    }

    const starved = (d) => d.pages >= 2 && d.blocks.length <= Math.max(1, Math.floor(d.pages * 0.1));
    for (let i = 0; i < 8 && starved(data); i++) {
      await new Promise((r) => setTimeout(r, 400));
      unlock();
      data = extract();
    }
    if (starved(data)) {
      log('viewer still empty, scrolling to mount pages');
      for (let pass = 0; pass < 2 && starved(data); pass++) {
        await autoScroll(120);
        await new Promise((r) => setTimeout(r, 1200));
        data = extract();
      }
    }
    return data;
  }

  async function exportTxt() {
    const data = await ensureContent();
    if (!data.blocks.length) { warn('nothing extracted'); return 0; }
    const text = toText(data);
    download(new Blob([text], { type: 'text/plain;charset=utf-8' }), `${slug()}.txt`);
    return data.blocks.length;
  }

  async function exportHtml() {
    const data = await ensureContent();
    if (!data.blocks.length) { warn('nothing extracted'); return 0; }
    const parts = data.blocks.map((b, i) => {
      const t = b.text ? `<pre class="t">${escapeHtml(b.text)}</pre>` : '';
      const im = b.imgs.map((s) => `<img src="${s}" alt="">`).join('\n');
      return `<section class="pg">${im}${t}</section>`;
    });
    const html = `<!doctype html><html><head><meta charset="utf-8">
<title>${escapeHtml(document.title)}</title>
<style>
  @page { size: A4; margin: 10mm; }
  body { font: 12pt/1.45 Georgia, serif; margin: 0; }
  .pg { page-break-after: always; }
  .pg:last-child { page-break-after: auto; }
  .pg img { max-width: 100%; display: block; margin: 0 auto 8px; }
  .t { white-space: pre-wrap; font: inherit; margin: 0; }
  header { font: 9pt system-ui; color: #666; margin-bottom: 10px; }
  @media screen { body { max-width: 820px; margin: 24px auto; padding: 0 16px; } }
</style></head><body>
<header>${escapeHtml(document.title)} — ${escapeHtml(location.href)}</header>
${parts.join('\n')}
</body></html>`;
    download(new Blob([html], { type: 'text/html;charset=utf-8' }), `${slug()}.html`);
    return data.blocks.length;
  }

  /** Opens a print view: Ctrl+P -> Save as PDF gives the whole document. */
  async function printView() {
    const data = await ensureContent();
    if (!data.blocks.length) { warn('nothing extracted'); return 0; }
    const html = buildPrintHtml(data.blocks);
    const w = window.open('', '_blank');
    if (w) {
      w.document.open();
      w.document.write(html);
      w.document.close();
      setTimeout(() => { try { w.focus(); w.print(); } catch { /* user prints */ } }, 900);
    } else {
      const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
      window.open(url, '_blank');
      warn('popup blocked, opened blob tab instead');
    }
    return data.blocks.length;
  }

  function buildPrintHtml(blocks) {
    const parts = blocks.map((b) => {
      const im = b.imgs.map((s) => `<img src="${s}" alt="">`).join('\n');
      const t = b.text ? `<pre>${escapeHtml(b.text)}</pre>` : '';
      return `<section>${im}${t}</section>`;
    });
    return `<!doctype html><html><head><meta charset="utf-8">
<title>${escapeHtml(document.title)}</title>
<style>
  @page { size: A4; margin: 10mm; }
  body { font: 12pt/1.45 Georgia, serif; margin: 0; }
  section { page-break-after: always; }
  section:last-child { page-break-after: auto; }
  img { max-width: 100%; display: block; margin: 0 auto 8px; }
  pre { white-space: pre-wrap; font: inherit; margin: 0; }
</style></head><body>${parts.join('\n')}</body></html>`;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  async function copyText() {
    const data = await ensureContent();
    const text = toText(data);
    try {
      await navigator.clipboard.writeText(text);
      flash('copied ' + text.length + ' chars');
    } catch {
      flash('clipboard blocked');
    }
  }

  // ---------------------------------------------------------------- panel

  let panel;
  function flash(msg) {
    if (!panel) return;
    const el = panel.querySelector('.scu-status');
    el.textContent = msg;
    clearTimeout(flash._t);
    flash._t = setTimeout(() => { el.textContent = ''; }, 2200);
  }

  function buildPanel() {
    if (document.getElementById(PANEL_ID)) return;
    panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.innerHTML = `
      <div class="scu-head">
        <span>studocu unlock</span>
        <button class="scu-x" title="hide (Alt+S)">×</button>
      </div>
      <div class="scu-body">
        <button data-act="unlock">Unlock page</button>
        <button data-act="scroll">Load all pages</button>
        <button data-act="copy">Copy text</button>
        <button data-act="txt">Download .txt</button>
        <button data-act="html">Download .html</button>
        <button data-act="print">Print / Save PDF</button>
      </div>
      <div class="scu-status"></div>
    `;
    Object.assign(panel.style, {
      position: 'fixed', right: '16px', bottom: '16px', zIndex: 2147483000,
      width: '224px', background: '#141414', color: '#eee', border: '1px solid #333',
      borderRadius: '10px', font: '12px/1.4 system-ui, sans-serif',
      boxShadow: '0 8px 28px rgba(0,0,0,.45)', overflow: 'hidden'
    });
    const style = document.createElement('style');
    style.textContent = `
      #${PANEL_ID} .scu-head { display:flex; align-items:center; justify-content:space-between;
        padding:8px 10px; background:#1d1d1d; font-weight:600; letter-spacing:.02em; }
      #${PANEL_ID} .scu-x { background:none; border:0; color:#999; font-size:16px; cursor:pointer; line-height:1; }
      #${PANEL_ID} .scu-body { display:grid; gap:6px; padding:10px; }
      #${PANEL_ID} .scu-body button { padding:7px 8px; border-radius:6px; border:1px solid #3a3a3a;
        background:#232323; color:#eee; cursor:pointer; font:inherit; text-align:left; }
      #${PANEL_ID} .scu-body button:hover { background:#2e2e2e; border-color:#555; }
      #${PANEL_ID} .scu-status { min-height:16px; padding:0 10px 8px; color:#8fd18f; font-size:11px; }
    `;
    document.head.appendChild(style);

    panel.addEventListener('click', async (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.classList.contains('scu-x')) { panel.style.display = 'none'; return; }
      const act = b.dataset.act;
      b.disabled = true;
      try {
        if (act === 'unlock') { unlock(); flash('unlocked'); }
        if (act === 'scroll') { flash('loading pages…'); await autoScroll(); unlock(); flash('pages loaded'); }
        if (act === 'copy') await copyText();
        if (act === 'txt') { const n = await exportTxt(); flash(n ? `${n} pages → txt` : 'nothing found'); }
        if (act === 'html') { const n = await exportHtml(); flash(n ? `${n} pages → html` : 'nothing found'); }
        if (act === 'print') { const n = await printView(); flash(n ? `${n} pages → print` : 'nothing found'); }
      } catch (err) {
        warn(err);
        flash('error: ' + err.message);
      } finally {
        b.disabled = false;
      }
    });

    (document.body || document.documentElement).appendChild(panel);
  }

  // ---------------------------------------------------------------- wire up

  function boot() {
    unlock();
    buildPanel();

    // Viewer streams pages in; keep the blurs gone and the overlays dead.
    const mo = new MutationObserver(() => {
      if (mo._t) return;
      mo._t = setTimeout(() => { mo._t = null; clearInlineBlur(); killOverlays(); }, 300);
    });
    mo.observe(document.documentElement, { childList: true, subtree: true });

    addEventListener('keydown', (e) => {
      if (e.altKey && (e.key === 's' || e.key === 'S')) {
        e.preventDefault();
        buildPanel();
        panel.style.display = panel.style.display === 'none' ? '' : 'none';
      }
    });

    // Console entry points for when the panel is in the way.
    window.scu = { unlock, extract, exportTxt, exportHtml, printView, copyText, autoScroll, findPages };

    log('ready — panel bottom-right, Alt+S toggles, window.scu for console');
  }

  // Tampermonkey injects at idle, but a document-start injection has no
  // documentElement yet; defer until the tree exists instead of throwing.
  if (document.documentElement) {
    boot();
  } else {
    const wait = new MutationObserver((_m, obs) => {
      if (!document.documentElement) return;
      obs.disconnect();
      boot();
    });
    wait.observe(document, { childList: true, subtree: true });
  }
})();
