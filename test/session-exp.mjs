// Does a cold session get the full document? Three isolated cookie jars,
// each opening the same search result, then a repeat visit in the first jar.
import { launch } from './cdp.mjs';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36';
const browser = await launch({ port: 9469 });
const out = [];

function measureExpr() {
  return `JSON.stringify((() => {
    const pages = [...document.querySelectorAll('.page-content')];
    const detail = pages.map(p => ({
      text: (p.innerText || '').trim().length,
      img: [...p.querySelectorAll('img')].map(i => ({ w: i.naturalWidth, blur: /blurred/i.test(i.alt || i.src) }))
        .filter(i => i.w > 0 || i.blur)[0] || null
    }));
    const real = detail.filter(d => d.text > 40 || (d.img && d.img.w > 400 && !d.img.blur)).length;
    const blurredThumbs = detail.filter(d => d.img && d.img.blur).length;
    return {
      title: document.title.slice(0, 70),
      url: location.href.split('?')[0],
      pages: pages.length,
      real,
      blurredThumbs,
      textChars: detail.reduce((a, d) => a + d.text, 0),
      cookies: document.cookie.split(';').map(c => c.trim().split('=')[0]).filter(Boolean).slice(0, 12)
    };
  })())`;
}

async function openDoc(ctxId, label) {
  const { targetId } = await browser.cdp.send('Target.createTarget', { url: 'about:blank', browserContextId: ctxId });
  const { sessionId } = await browser.cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const page = new (await import('./cdp.mjs')).Page(browser.cdp, sessionId, targetId);
  await page.init();
  await page.send('Network.setUserAgentOverride', { userAgent: UA, acceptLanguage: 'en-US,en;q=0.9', platform: 'Win32' });
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });

  const row = { label };
  try {
    await page.goto('https://www.studocu.com/en-us/search?query=marketing%20notes');
    await page.waitFor('document.querySelectorAll(\'a[href*="/document/"]\').length > 0', 25000);
    const box = JSON.parse(await page.eval(`(() => {
      const seen = new Set(); const list = [];
      for (const a of document.querySelectorAll('a[href*="/document/"]')) { if (seen.has(a.href)) continue; seen.add(a.href); list.push(a); }
      const a = list[0]; a.scrollIntoView({ block: 'center' });
      const r = a.getBoundingClientRect();
      return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2, href: a.href });
    })()`));
    row.target = box.href.split('?')[0].slice(-46);
    for (const type of ['mousePressed', 'mouseReleased']) {
      await page.send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
    }
    await page.waitFor('document.querySelectorAll(".page-content").length > 2', 45000);
    await new Promise((r) => setTimeout(r, 4000));
    Object.assign(row, JSON.parse(await page.eval(measureExpr())));
    row.premium = await page.eval('/\\bpremium\\b/i.test(document.body.innerText.slice(0, 2000))');
  } catch (e) {
    row.error = String(e.message).slice(0, 90);
  }
  await browser.cdp.send('Target.closeTarget', { targetId }).catch(() => {});
  out.push(row);
}

try {
  for (const n of [1, 2, 3]) {
    const { browserContextId } = await browser.cdp.send('Target.createBrowserContext', {});
    await openDoc(browserContextId, `fresh jar #${n}`);
  }
} finally {
  console.log(JSON.stringify(out, null, 2));
  await browser.close();
}
