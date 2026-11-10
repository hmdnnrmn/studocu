// Minimal Chrome DevTools Protocol client: launch headless Chrome, attach a
// session to a target, evaluate in the page. No third-party deps.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
];

function findChrome(explicit) {
  if (explicit) return explicit;
  for (const p of CHROME) {
    try { if (existsSync(p)) return p; } catch { /* ignore */ }
  }
  return 'chrome';
}

export class CDP {
  #ws;
  #id = 0;
  #pending = new Map();
  #listeners = new Map();

  constructor(ws) {
    this.#ws = ws;
    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.id && this.#pending.has(msg.id)) {
        const { resolve, reject } = this.#pending.get(msg.id);
        this.#pending.delete(msg.id);
        msg.error ? reject(new Error(`${msg.error.message} (${msg.error.code})`)) : resolve(msg.result);
        return;
      }
      if (msg.method) {
        for (const fn of this.#listeners.get(msg.method) || []) fn(msg.params, msg.sessionId);
      }
    });
  }

  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', () => rej(new Error('ws connect failed')), { once: true });
    });
    return new CDP(ws);
  }

  send(method, params = {}, sessionId) {
    const id = ++this.#id;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#ws.send(JSON.stringify(payload));
      setTimeout(() => {
        if (this.#pending.has(id)) {
          this.#pending.delete(id);
          reject(new Error(`timeout: ${method}`));
        }
      }, 30000);
    });
  }

  once(method) {
    return new Promise((resolve) => {
      const list = this.#listeners.get(method) || [];
      const fn = (params, sid) => {
        this.#listeners.set(method, (this.#listeners.get(method) || []).filter((f) => f !== fn));
        resolve(params);
      };
      this.#listeners.set(method, [...list, fn]);
    });
  }

  on(method, fn) {
    this.#listeners.set(method, [...(this.#listeners.get(method) || []), fn]);
  }

  close() { try { this.#ws.close(); } catch { /* ignore */ } }
}

export async function launch({ port = 9222, headless = true, extraArgs = [] } = {}) {
  const profile = mkdtempSync(join(tmpdir(), 'scu-cdp-'));
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate,OptimizationHints',
    '--disable-background-networking',
    '--window-size=1440,1000',
    ...(headless ? ['--headless=new', '--hide-scrollbars'] : []),
    ...extraArgs,
    'about:blank',
  ];
  const proc = spawn(findChrome(), args, { stdio: 'ignore', detached: false });

  let version = null;
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (r.ok) { version = await r.json(); break; }
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  if (!version) { try { proc.kill(); } catch { /* ignore */ } throw new Error('chrome did not expose CDP'); }

  const cdp = await CDP.connect(version.webSocketDebuggerUrl);
  return {
    cdp,
    port,
    version,
    async newPage(url = 'about:blank') {
      const { targetId } = await cdp.send('Target.createTarget', { url });
      const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
      const page = new Page(cdp, sessionId, targetId);
      await page.init();
      return page;
    },
    async close() {
      cdp.close();
      try { proc.kill(); } catch { /* ignore */ }
      await new Promise((r) => setTimeout(r, 300));
      try { rmSync(profile, { recursive: true, force: true }); } catch { /* locked */ }
    },
  };
}

export class Page {
  constructor(cdp, sessionId, targetId) {
    this.cdp = cdp;
    this.sessionId = sessionId;
    this.targetId = targetId;
    this.console = [];
    this.requests = [];
  }

  send(method, params) { return this.cdp.send(method, params, this.sessionId); }

  async init() {
    await Promise.all([
      this.send('Page.enable'),
      this.send('Runtime.enable'),
      this.send('Network.enable', { maxTotalBufferSize: 8_000_000 }),
    ]);
    this.cdp.on('Runtime.consoleAPICalled', (p, sid) => {
      if (sid !== this.sessionId) return;
      this.console.push({
        type: p.type,
        text: (p.args || []).map((a) => a.value ?? a.description ?? a.type).join(' '),
      });
    });
    this.cdp.on('Runtime.exceptionThrown', (p, sid) => {
      if (sid !== this.sessionId) return;
      this.console.push({ type: 'exception', text: p.exceptionDetails?.exception?.description || p.exceptionDetails?.text });
    });
    this.cdp.on('Network.responseReceived', (p, sid) => {
      if (sid !== this.sessionId) return;
      this.requests.push({ url: p.response.url, status: p.response.status, type: p.type });
    });
  }

  async goto(url) {
    const loaded = this.cdp.once('Page.loadEventFired');
    await this.send('Page.navigate', { url });
    await Promise.race([loaded, new Promise((r) => setTimeout(r, 20000))]);
    await this.waitReady();
  }

  async waitReady() {
    for (let i = 0; i < 60; i++) {
      const s = await this.eval('document.readyState');
      if (s === 'complete' || s === 'interactive') return;
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  async waitFor(fnSource, timeout = 8000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const ok = await this.eval(`(() => { try { return !!(${fnSource}); } catch { return false; } })()`);
      if (ok) return true;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`waitFor timed out: ${fnSource}`);
  }

  /** Awaits promises by default; returns plain JSON. */
  async eval(expression, { awaitPromise = true } = {}) {
    const r = await this.send('Runtime.evaluate', {
      expression, awaitPromise, returnByValue: true, userGesture: true,
    });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    }
    return r.result?.value;
  }

  async addScriptOnNewDocument(source) {
    await this.send('Page.addScriptToEvaluateOnNewDocument', { source });
  }

  async injectScript(source) {
    return this.eval(source, { awaitPromise: false });
  }

  async close() {
    try { await this.cdp.send('Target.closeTarget', { targetId: this.targetId }); } catch { /* ignore */ }
  }
}
