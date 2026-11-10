// Why does one document yield pages but no payload? Dump per-page facts.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch } from './cdp.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(here, '..', 'studocu-unlock.user.js'), 'utf8');
const idx = Number(process.argv[2] ?? 1);

const browser = await launch({ port: 9459 });
const page = await browser.newPage();
await page.send('Network.setUserAgentOverride', {
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36',
  acceptLanguage: 'en-US,en;q=0.9', platform: 'Win32',
});
await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });

const out = {};
try {
  await page.goto('https://www.studocu.com/en-us/search?query=lecture%20notes');
  await page.waitFor('document.querySelectorAll(\'a[href*="/document/"]\').length > 0', 25000);
  const box = JSON.parse(await page.eval(`(() => {
    const seen = new Set(); const list = [];
    for (const a of document.querySelectorAll('a[href*="/document/"]')) { if (seen.has(a.href)) continue; seen.add(a.href); list.push(a); }
    const a = list[${idx}]; if (!a) return '{"x":0}';
    a.scrollIntoView({ block: 'center' });
    const r = a.getBoundingClientRect();
    return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2, href: a.href });
  })()`));
  out.url = box.href;
  for (const type of ['mousePressed', 'mouseReleased']) await page.send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
  await page.waitFor('document.querySelectorAll(".page-content").length > 3', 45000);

  if (process.argv[3] === 'shim') {
    await page.injectScript(`
      window.__dl = { names: [], blobs: [] };
      const __origCreate = URL.createObjectURL.bind(URL);
      URL.createObjectURL = (b) => { window.__dl.blobs.push(b); return __origCreate(b); };
      const __origClick = HTMLAnchorElement.prototype.click;
      HTMLAnchorElement.prototype.click = function () { if (this.download) { window.__dl.names.push(this.download); return; } return __origClick.call(this); };
      window.open = () => null;
    `);
  }
  await page.injectScript(SRC);
  await page.waitFor('!!window.scu', 8000);
  await page.eval('window.scu.autoScroll(120)');
  await page.eval('window.scu.autoScroll(120)');
  await new Promise((r) => setTimeout(r, 4000));

  out.diag = JSON.parse(await page.eval(`JSON.stringify((() => {
    const pages = window.scu.findPages();
    return {
      counts: {
        pageContent: document.querySelectorAll('.page-content').length,
        dataPage: document.querySelectorAll('[data-page-index]').length,
        imgs: document.querySelectorAll('img').length
      },
      foundPages: pages.length,
      perPage: pages.slice(0, 5).map(p => ({
        cls: String(p.className).slice(0, 45),
        textLen: (p.innerText || '').length,
        imgCount: p.querySelectorAll('img').length,
        imgSrcs: [...p.querySelectorAll('img')].slice(0, 2).map(i => ({ alt: i.alt, nw: i.naturalWidth, src: i.src.split('?')[0].slice(-28) }))
      })),
      blocks: window.scu.extract().blocks.slice(0, 4),
      blocked: window.scu.extract().blocked
    };
  })())`));
  out.diag.blocks = out.diag.blocks.map((b) => ({ text: (b.text || '').slice(0, 60), imgs: b.imgs.map((u) => u.split('?')[0].slice(-24)) }));
} catch (e) {
  out.error = String(e.message).slice(0, 160);
} finally {
  console.log(JSON.stringify(out, null, 2));
  await browser.close();
}
