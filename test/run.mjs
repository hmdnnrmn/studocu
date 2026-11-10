// Live browser verification for studocu-unlock.user.js.
// Serves deterministic Studocu-shaped fixtures, drives real headless Chrome over
// CDP, injects the userscript exactly as Tampermonkey would, then asserts.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { launch } from './cdp.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const USERSCRIPT = readFileSync(join(here, '..', 'studocu-unlock.user.js'), 'utf8');

const PAGE_HEAD = (title) => `<!doctype html><html><head><meta charset="utf-8">
<title>${title} | Studocu</title></head><body>`;

const LONG = 'The mitochondrion is the site of oxidative phosphorylation and ATP synthesis in eukaryotic cells. ';

// ------------------------------------------------------------------ fixtures

const FIXTURES = {
  // A: class-applied blur, modal paywall, three text pages, junk upsell copy.
  '/v1': PAGE_HEAD('Cell Biology Final Notes') + `
<style>.blurred-page { filter: blur(9px); opacity: .45; }</style>
<div class="document-viewer">
  <div data-testid="paywall" class="paywall-modal">
    <h2>Unlock the full document</h2><button>Sign up</button>
  </div>
  <div class="page" id="page-1" data-page-index="0">
    <div class="page-content blurred-page">
      <p>${LONG}</p><p>Page one paragraph about glycolysis and the Krebs cycle.</p>
      <p>Unlock the full document</p>
    </div>
  </div>
  <div class="page" id="page-2" data-page-index="1">
    <div class="page-content blurred-page">
      <p>Page two covers the electron transport chain and chemiosmosis in detail.</p>
    </div>
  </div>
  <div class="page" id="page-3" data-page-index="2">
    <div class="page-content blurred-page">
      <p>Page three lists exam questions with worked answers for chapter seven.</p>
    </div>
  </div>
</div></body></html>`,

  // B: blur via inline style, overlay is an unclassed-positioned sibling that
  // only the geometry sweep can catch once it gets a class hint.
  '/v2': PAGE_HEAD('Anatomy Lecture 4') + `
<div class="viewer">
  <div class="modal-scrim" style="position:fixed;top:0;left:0;right:0;bottom:0;background:#fff;z-index:99">
    <p>Continue reading with a free account</p>
  </div>
  <section class="document-page">
    <div class="page-content" style="filter: blur(12px); opacity: 0.3">
      <p>Skeletal muscle fibers are multinucleated and striated.</p>
    </div>
  </section>
  <section class="document-page">
    <div class="page-content" style="filter: grayscale(1) blur(4px)">
      <p>Cardiac muscle cells are joined by intercalated discs.</p>
    </div>
  </section>
</div></body></html>`,

  // C: scanned slides — no text at all, responsive srcset, data-src lazy attr.
  '/v3': PAGE_HEAD('Organic Chemistry Slides') + `
<div class="viewer">
  <div class="page" data-page-index="0">
    <img srcset="https://cdn.example/p1-320.jpg 320w, https://cdn.example/p1-1600.jpg 1600w" src="https://cdn.example/p1-thumb.jpg">
  </div>
  <div class="page" data-page-index="1">
    <img data-src="https://cdn.example/p2-full.jpg" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">
  </div>
  <div class="page" data-page-index="2">
    <img src="https://cdn.example/logo.svg"><img srcset="https://cdn.example/p3-2048.jpg 2048w" src="https://cdn.example/p3-thumb.jpg">
  </div>
</div></body></html>`,

  // D: no page containers at all; content only inside the Next.js payload.
  '/v4': `<!doctype html><html><head><meta charset="utf-8"><title>Economics Summary | Studocu</title>
<script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"document":{"content":"Marginal utility declines as consumption of a good increases, which explains the downward sloping demand curve and consumer surplus.","title":"Economics Summary"}}}}</script>
</head><body><div id="__next"><div class="shell">preview only</div></div></body></html>`,

  // E: viewer streams pages in after load; blur is re-applied to each new page.
  '/v5': PAGE_HEAD('Physics Problem Set') + `
<style>.lazy-blur { filter: blur(5px); }</style>
<div class="viewer" id="viewer">
  <div class="page" data-page-index="0"><div class="page-content lazy-blur"><p>Newton's second law relates force, mass and acceleration.</p></div></div>
</div>
<script>
  let n = 1;
  const t = setInterval(() => {
    if (n > 3) return clearInterval(t);
    const d = document.createElement('div');
    d.className = 'page';
    d.dataset.pageIndex = String(n);
    d.innerHTML = '<div class="page-content lazy-blur"><p>Streamed page ' + (n + 1) + ': momentum is conserved in closed systems.</p></div>';
    document.getElementById('viewer').appendChild(d);
    n++;
  }, 250);
</script></body></html>`,

  // F: premium-shaped document — decoy `[id^="page-"]` wrapper, text on the
  // free page, 140px blurred previews for the rest.
  '/v6': PAGE_HEAD('Advanced Pharmacology Premium') + `
<div class="viewer">
  <div id="page-container-wrapper" class="pageContainer">
    <div id="page-container">
      <div class="page-content"><p>Pharmacokinetics describes how a drug is absorbed and distributed.</p></div>
      <div data-page-index="0" class="page-content blurredImageWrapper" style="filter:blur(2px)">
        <img alt="blurred_content_of_page_2" src="https://doc-assets.example/html/pages/blurred/page2.webp">
      </div>
      <div data-page-index="1" class="page-content blurredImageWrapper" style="filter:blur(2px)">
        <img alt="blurred_content_of_page_3" src="https://doc-assets.example/html/pages/blurred/page3.webp">
      </div>
      <div data-page-index="2" class="page-content">
        <img alt="" src="https://doc-assets.example/html/bg4.png">
        <p>Why is this page out of focus?</p>
        <p>This is a Premium document. Become Premium to read the whole document.</p>
      </div>
    </div>
  </div>
</div></body></html>`,

  // G: pages rendered as CSS background images instead of <img> nodes.
  '/v7': PAGE_HEAD('Rendered Deck') + `
<div class="viewer">
  <div class="page-content"><div class="pc pc1" style="background-image:url('https://doc-assets.example/html/bg1.png')"></div></div>
  <div class="page-content"><div class="pc pc2" style="background-image:url('https://doc-assets.example/html/bg2.png')"></div></div>
</div></body></html>`,

  // I: mid-size gate modal with a hashed class plus a cookie banner.
  '/v9': PAGE_HEAD('Biology Summary Premium') + `
<div class="viewer">
  <div class="page-content"><p>Cell theory states that all living organisms are composed of cells.</p></div>
</div>
<div class="Xk2_panel" style="position:fixed;top:20%;left:20%;width:800px;height:420px;background:#fff;z-index:50">
  <h2>This is a preview</h2>
  <p>Do you want full access? Go Premium and unlock all 12 pages</p>
  <button>Free Trial</button>
</div>
<div class="cookieNote" style="position:fixed;bottom:0;left:0;right:0;height:120px;background:#eee;z-index:60">
  <p>Cookies give you a personalised experience</p><button>Accept all cookies</button>
</div></body></html>`,

  // H: pages exist but stay empty until they are scrolled into view.
  '/v8': PAGE_HEAD('Lazy Mounted Notes') + `
<div class="viewer">
  <div class="page-content" data-page-index="0"></div>
  <div class="page-content" data-page-index="1"></div>
  <div class="page-content" data-page-index="2"></div>
</div>
<script>
  let filled = false;
  addEventListener('scroll', () => {
    if (filled) return; filled = true;
    document.querySelectorAll('.page-content').forEach((el, i) => {
      el.textContent = 'Mounted page ' + (i + 1) + ': the citric acid cycle oxidises acetyl-CoA.';
    });
  });
</script></body></html>`,
};

// ------------------------------------------------------------------ harness

const results = [];
function check(name, pass, detail = '') {
  results.push({ name, pass, detail });
  const mark = pass ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m';
  console.log(`  ${mark}  ${name}${detail ? '  \x1b[90m' + detail + '\x1b[0m' : ''}`);
}

const DOWNLOAD_SHIM = `
window.__dl = { names: [], blobs: [] };
URL.createObjectURL = (b) => { window.__dl.blobs.push(b); return 'blob:shim-' + window.__dl.blobs.length; };
URL.revokeObjectURL = () => {};
HTMLAnchorElement.prototype.click = function () { window.__dl.names.push(this.download); };
window.open = () => null;
true;`;

async function setup(page, url) {
  await page.goto(url);
  await page.injectScript(DOWNLOAD_SHIM);
  await page.injectScript(USERSCRIPT);
  await page.eval('typeof window.scu === "object" && !!document.getElementById("scu-panel")');
}

// ------------------------------------------------------------------ main

const server = createServer((req, res) => {
  const path = req.url.split('?')[0];
  const body = FIXTURES[path];
  if (!body) { res.writeHead(404).end('nope'); return; }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(body);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
console.log(`fixtures on ${base}\n`);

const browser = await launch({ port: 9333 });
console.log(`chrome ${browser.version.Browser} over CDP ${browser.version['Protocol-Version']}\n`);

const page = await browser.newPage();

try {
  // ---- v1: class blur, modal paywall, text pages
  console.log('v1  class blur + paywall modal + 3 text pages');
  await setup(page, `${base}/v1`);
  check('panel mounted', await page.eval('!!document.getElementById("scu-panel")'));
  check('paywall node removed', await page.eval('!document.querySelector(\'[data-testid="paywall"]\')'));
  check('class blur defeated (computed filter)', (await page.eval(
    'getComputedStyle(document.querySelector(".page-content")).filter'
  )) === 'none',
    'filter=' + await page.eval('getComputedStyle(document.querySelector(".page-content")).filter'));
  check('class blur opacity restored', Number(await page.eval(
    'getComputedStyle(document.querySelector(".page-content")).opacity'
  )) === 1);
  check('3 pages found', (await page.eval('window.scu.findPages().length')) === 3);

  const v1 = await page.eval('JSON.stringify(window.scu.extract().blocks.map(b => b.text))');
  const blocks = JSON.parse(v1);
  check('page 1 text captured', /oxidative phosphorylation/.test(blocks[0] || ''));
  check('upsell line stripped', !/Unlock the full document/i.test(blocks.join('\n')));
  check('page 3 text captured', /worked answers/.test(blocks[2] || ''));

  const txt = await page.eval(`(async () => { await window.scu.exportTxt(); return await window.__dl.blobs[0].text(); })()`);
  check('.txt download fired', (await page.eval('window.__dl.names.length')) === 1,
    await page.eval('window.__dl.names.join(",")'));
  check('.txt has page markers', /=== page 1 ===/.test(txt) && /=== page 3 ===/.test(txt));
  check('.txt has source url', txt.includes('127.0.0.1'));
  check('.txt filename slugged', /^cell-biology-final-notes/.test(await page.eval('window.__dl.names[0]')));

  const html = await page.eval(`(async () => { await window.scu.exportHtml(); return await window.__dl.blobs[window.__dl.blobs.length-1].text(); })()`);
  check('.html export valid shell', html.startsWith('<!doctype html>') && /@page/.test(html));

  // ---- v2: inline blur + geometry-agnostic scrim
  console.log('\nv2  inline-style blur + fixed scrim overlay');
  await setup(page, `${base}/v2`);
  const f2 = await page.eval('[getComputedStyle(document.querySelectorAll(".page-content")[0]).filter, getComputedStyle(document.querySelectorAll(".page-content")[1]).filter]');
  check('inline blur cleared (page 1)', f2[0] === 'none', 'filter=' + f2[0]);
  check('grayscale+blur cleared (page 2)', f2[1] === 'none', 'filter=' + f2[1]);
  check('scrim removed', await page.eval('!document.querySelector(".modal-scrim")'));
  check('inline opacity restored', Number(await page.eval('getComputedStyle(document.querySelectorAll(".page-content")[0]).opacity')) === 1);

  // ---- v3: image-only deck
  console.log('\nv3  scanned slides, srcset + data-src');
  await setup(page, `${base}/v3`);
  const ex3 = JSON.parse(await page.eval('JSON.stringify(window.scu.extract())'));
  check('3 image pages captured', ex3.blocks.length === 3, 'blocks=' + ex3.blocks.length);
  check('srcset largest wins', ex3.blocks[0].imgs[0] === 'https://cdn.example/p1-1600.jpg', ex3.blocks[0].imgs[0]);
  check('data-src resolved', ex3.blocks[1].imgs[0] === 'https://cdn.example/p2-full.jpg', ex3.blocks[1].imgs[0]);
  check('logo filtered out', !(ex3.blocks[2]?.imgs || []).some((u) => /logo/.test(u)), JSON.stringify(ex3.blocks[2]?.imgs));
  check('placeholder gif never exported', !JSON.stringify(ex3).includes('data:image'));

  const h3 = await page.eval(`(async () => { await window.scu.exportHtml(); return await window.__dl.blobs[window.__dl.blobs.length-1].text(); })()`);
  check('.html embeds slide images', /p1-1600\.jpg/.test(h3) && /p3-2048\.jpg/.test(h3));

  // ---- v4: JSON-payload fallback
  console.log('\nv4  no page containers, __NEXT_DATA__ payload');
  await setup(page, `${base}/v4`);
  const ex4 = JSON.parse(await page.eval('JSON.stringify(window.scu.extract())'));
  check('embedded payload used', /Marginal utility/.test(ex4.blocks[0]?.text || ''), (ex4.blocks[0]?.text || '').slice(0, 40));

  // ---- v5: streamed pages, observer keeps unlocking
  console.log('\nv5  streamed pages + observer re-unlock');
  await setup(page, `${base}/v5`);
  await page.waitFor('document.querySelectorAll(".page").length === 4', 6000);
  await new Promise((r) => setTimeout(r, 900));
  const f5 = await page.eval('[...document.querySelectorAll(".page-content")].map(e => getComputedStyle(e).filter)');
  check('all 4 streamed pages found', (await page.eval('window.scu.findPages().length')) === 4, 'filters=' + JSON.stringify(f5));
  check('late pages unblurred too', f5.every((f) => f === 'none'), JSON.stringify(f5));

  // ---- injection-timing + idempotency
  console.log('\nv6  early injection (document-start) + double-inject guard');
  const p6 = await browser.newPage();
  await p6.addScriptOnNewDocument(USERSCRIPT);
  await p6.goto(`${base}/v1`);
  await p6.waitFor('!!window.scu');
  check('survives document-start injection', await p6.eval('!!window.scu && !!document.getElementById("scu-panel")'));
  await p6.injectScript(USERSCRIPT);
  check('double inject is a no-op', (await p6.eval('document.querySelectorAll("#scu-panel").length')) === 1);
  check('no uncaught exceptions on start path', !p6.console.some((c) => c.type === 'exception' || c.type === 'error'),
    JSON.stringify(p6.console.filter((c) => c.type === 'exception').slice(0, 1)));
  await p6.close();

  // ---- v6: premium shape
  console.log('\nv6  premium shape: decoy wrapper, blurred previews, upsell text');
  await setup(page, `${base}/v6`);
  const ex6 = JSON.parse(await page.eval('JSON.stringify(window.scu.extract())'));
  check('picks page nodes, not the whole wrapper', (await page.eval('window.scu.findPages().length')) >= 3
    && (await page.eval('window.scu.findPages().length')) < 10,
    'pages=' + await page.eval('window.scu.findPages().length'));
  check('no duplicated body text', (JSON.stringify(ex6).match(/Pharmacokinetics/g) || []).length === 1);
  check('free page text kept', /Pharmacokinetics/.test(ex6.blocks.map((b) => b.text).join('\n')));
  check('blurred previews excluded from images', !JSON.stringify(ex6).includes('/blurred/'));
  check('blurred previews counted', ex6.blocked === 2, 'blocked=' + ex6.blocked);
  check('upsell copy stripped', !/out of focus|Become Premium/i.test(JSON.stringify(ex6)));
  const txt6 = await page.eval(`(async () => { await window.scu.exportTxt(); return await window.__dl.blobs[window.__dl.blobs.length-1].text(); })()`);
  check('.txt discloses blocked pages', /2 page\(s\) were never sent/.test(txt6));

  // ---- v7: background-image pages
  console.log('\nv7  pages rendered as CSS background images');
  await setup(page, `${base}/v7`);
  const ex7 = JSON.parse(await page.eval('JSON.stringify(window.scu.extract())'));
  check('background pages captured', ex7.blocks.length === 2 && ex7.imgCount !== 0, JSON.stringify(ex7.blocks.map((b) => b.imgs)));
  check('background urls absolute', ex7.blocks.every((b) => b.imgs.every((u) => u.startsWith('http'))));

  // ---- v8: lazy mounted pages
  console.log('\nv8  pages mount only after scroll (ensureContent retry)');
  await setup(page, `${base}/v8`);
  check('empty viewer detected', (await page.eval('window.scu.extract().blocks.length')) === 0);
  const txt8 = await page.eval(`(async () => { await window.scu.exportTxt(); const b = window.__dl.blobs.at(-1); return b ? await b.text() : ''; })()`);
  check('retry scrolls and recovers content', /citric acid cycle/.test(txt8), txt8.length + ' bytes');

  // ---- v9: hashed modal + cookie banner
  console.log('\nv9  mid-size hashed gate modal + cookie banner');
  await setup(page, `${base}/v9`);
  check('gate modal removed by copy match', await page.eval('!document.querySelector(".Xk2_panel")'));
  check('cookie banner removed', await page.eval('!document.querySelector(".cookieNote")'));
  check('document text survives', /Cell theory/.test(await page.eval('document.body.innerText')));

  // ---- page errors across all runs
  const bad = page.console.filter((c) => c.type === 'exception' || (c.type === 'error' && !/ERR_/.test(c.text)));
  check('no page exceptions overall', bad.length === 0, bad.map((b) => b.text).slice(0, 2).join(' | '));
} finally {
  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  await browser.close();
  server.close();
  process.exitCode = failed.length ? 1 : 0;
}
