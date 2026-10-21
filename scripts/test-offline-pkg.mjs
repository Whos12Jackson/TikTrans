// 验证离线包：全新 profile、**完全不下载模型**，引擎自检能否直接用自带模型
import puppeteer from 'puppeteer-core';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(root, 'dist');

const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  headless: false, userDataDir: path.join(root, '.edge-profile'),
  args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`, '--no-first-run'],
  protocolTimeout: 600000,
});
await new Promise((r) => setTimeout(r, 4000));
const sw = browser.targets().find((t) => t.type() === 'service_worker' && t.url().includes('chrome-extension://'));
const extId = new URL(sw.url()).hostname;
const logs = [];
const hook = async (target) => {
  try {
    const cdp = await target.createCDPSession();
    await cdp.send('Runtime.enable');
    cdp.on('Runtime.consoleAPICalled', (ev) => {
      const txt = (ev.args ?? []).map((a) => a.value ?? a.description ?? '').join(' ');
      if (txt.includes('tiktrans') || txt.includes('自带') || txt.includes('模型')) logs.push(`[${target.type()}] ${txt.slice(0, 200)}`);
    });
  } catch { /* 目标可能已关闭 */ }
};
for (const t of browser.targets()) await hook(t);
browser.on('targetcreated', (t) => { void hook(t); });
setInterval(() => { for (const t of browser.targets()) void hook(t); }, 1500);
const page = await browser.newPage();
await page.goto(`chrome-extension://${extId}/app.html`, { waitUntil: 'domcontentloaded', timeout: 120000 });
await new Promise((r) => setTimeout(r, 3000));

// 1) 不该出现引导页（自带模型）
const onb = await page.evaluate(() => document.body.innerText.includes('下载语音模型（约 230 MB，一次性）'));
console.log('出现下载引导页：', onb ? '❌ 不该出现' : '✅ 已跳过（自带模型）');

// 2) IndexedDB 里不该有模型（说明确实没下载）
const inDb = await page.evaluate(async () => new Promise((res) => {
  const rq = indexedDB.open('tiktrans');
  rq.onsuccess = () => {
    try {
      const tx = rq.result.transaction('models', 'readonly');
      const r2 = tx.objectStore('models').getAll();
      r2.onsuccess = () => res(r2.result.length);
    } catch { res(0); }
  };
}));
console.log('IndexedDB 里的模型数（应为 0，说明没下载）：', inDb);

// 2b) 页面里能不能 fetch 到自带文件
const probe = await page.evaluate(async () => {
  const out = {};
  for (const f of ['model/tokens.txt', 'model/sense-voice.onnx']) {
    try {
      const r = await fetch(chrome.runtime.getURL(f));
      out[f] = `HTTP ${r.status}, length=${r.headers.get('content-length')}`;
    } catch (e) { out[f] = 'ERR ' + String(e); }
  }
  return out;
});
console.log('页面 fetch 自带文件：', JSON.stringify(probe));

// 3) 引擎自检：应该直接用自带模型成功（直接等消息返回，别靠 toast）
const t0 = Date.now();
const selftest = await page.evaluate(async () => {
  try {
    return await chrome.runtime.sendMessage({ type: 'selftest' });
  } catch (e) {
    return { ok: false, detail: String(e) };
  }
});
console.log(`引擎自检（${Math.round((Date.now() - t0) / 1000)}s）：`, JSON.stringify(selftest));
console.log(selftest?.ok ? '✅ 自带模型可直接使用' : '❌ 自检失败');
console.log('后台/Worker 日志：\n  ' + (logs.slice(-12).join('\n  ') || '(无)'));
await browser.close();
