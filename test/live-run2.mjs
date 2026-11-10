// Live end-to-end over several documents: click through, run the userscript,
// record what it recovered and what the server withheld.
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch } from './cdp.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(here, '..', 'studocu-unlock.user.js'), 'utf8');

const SHIM = `
  window.__dl = { names: [], blobs: [] };
  const __origCreate = URL.createObjectURL.bind(URL);
  URL.createObjectURL = (b) => { window.__dl.blobs.push(b); return __origCreate(b); };
  const __origClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    if (this.download) { window.__dl.names.push(this.download); return; }
    return __origClick.call(this);
  };
  const __origOpen = window.open;
  window.open = () => null;
`;

const browser = await launch({ port: 9437 });
const page = await browser.newPage();
await page.send('Network.setUserAgentOverride', {
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36',
  acceptLanguage: 'en-US,en;q=0.9', platform: 'Win32',
});
await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });

const report = [];
try {
  await page.goto('https://www.studocu.com/en-us/search?query=lecture%20notes');
  await page.waitFor('document.querySelectorAll(\'a[href*="/document/"]\').length > 0', 20000);
  const links = JSON.parse(await page.eval(`JSON.stringify([...new Set([...document.querySelectorAll('a[href*="/document/"]')].map(a=>a.href))].slice(0,3))`));

  for (let i = 0; i < links.length; i++) {
    const entry = { url: links[i] };
    try {
      await page.goto('https://www.studocu.com/en-us/search?query=lecture%20notes');
      await page.waitFor('document.querySelectorAll(\'a[href*="/document/"]\').length > 0', 20000);
      const box = JSON.parse(await page.eval(`(() => {
        const seen = new Set(); const list = [];
        for (const a of document.querySelectorAll('a[href*="/document/"]')) {
          if (seen.has(a.href)) continue;
          seen.add(a.href); list.push(a);
        }
        const a = list[${i}];
        if (!a) return '{"x":0}';
        a.scrollIntoView({ block: 'center' });
        const r = a.getBoundingClientRect();
        return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2, href: a.href });
      })()`));
      if (box.href) entry.url = box.href;
      if (!box || !box.x) { entry.error = 'link not found'; report.push(entry); continue; }
      for (const type of ['mousePressed', 'mouseReleased']) {
        await page.send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
      }
      await page.waitFor('document.querySelectorAll(".page-content").length > 2', 45000);
      entry.title = await page.eval('document.title');
      entry.premium = await page.eval('/premium/i.test(document.body.innerText.slice(0, 3000))');

      await page.injectScript(SHIM);
      await page.injectScript(SRC);
      await page.waitFor('!!window.scu', 8000);
      await page.eval('window.scu.autoScroll(140)');
      await new Promise((r) => setTimeout(r, 1200));

      entry.result = JSON.parse(await page.eval(`JSON.stringify((() => {
        const d = window.scu.extract();
        return {
          pages: d.pages,
          blocks: d.blocks.length,
          blocked: d.blocked,
          textChars: d.blocks.reduce((a,b)=>a+b.text.length,0),
          imgCount: d.blocks.reduce((a,b)=>a+b.imgs.length,0),
          sample: (d.blocks.find(b=>b.text) || {}).text?.replace(/\\s+/g,' ').slice(0,160) || '',
          imgs: d.blocks.flatMap(b=>b.imgs).slice(0,2).map(u => u.split('?')[0].slice(-42))
        };
      })())`));

      const txt = await page.eval(`(async () => { await window.scu.exportTxt(); const b = window.__dl.blobs.at(-1); return b ? (await b.text()).length : 0; })()`);
      entry.txtBytes = txt;
      const shot = await page.send('Page.captureScreenshot', { format: 'png' });
      writeFileSync(join(here, `real-${i}.png`), Buffer.from(shot.data, 'base64'));
      entry.shot = `real-${i}.png`;
    } catch (e) {
      entry.error = String(e.message).slice(0, 120);
    }
    report.push(entry);
  }
} finally {
  console.log(JSON.stringify(report, null, 2));
  await browser.close();
}
