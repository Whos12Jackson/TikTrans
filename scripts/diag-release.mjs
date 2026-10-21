// 聚焦测试：设置值 + 离屏文档释放是否真的生效
import puppeteer from 'puppeteer-core';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(root, 'dist');
const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  headless: false, userDataDir: path.join(root, '.edge-profile'),
  args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`, '--no-first-run'],
});
await new Promise((r) => setTimeout(r, 3000));
const sw = browser.targets().find((t) => t.type() === 'service_worker' && t.url().includes('chrome-extension://'));
const extId = new URL(sw.url()).hostname;
const logs = [];
{
  const cdp = await sw.createCDPSession();
  await cdp.send('Runtime.enable');
  cdp.on('Runtime.consoleAPICalled', (ev) => {
    const txt = (ev.args ?? []).map((a) => a.value ?? a.description ?? '').join(' ');
    logs.push(txt);
  });
  cdp.on('Runtime.exceptionThrown', (ev) => logs.push('EXC ' + JSON.stringify(ev.exceptionDetails?.text ?? '')));
}
browser.on('targetcreated', (t) => {
  void (async () => {
    try {
      const cdp = await t.createCDPSession();
      await cdp.send('Runtime.enable');
      cdp.on('Runtime.consoleAPICalled', (ev) => {
        const txt = (ev.args ?? []).map((a) => a.value ?? a.description ?? '').join(' ');
        logs.push(`[${t.type()}] ${txt}`);
      });
    } catch { /* 忽略 */ }
  })();
});
const page = await browser.newPage();
await page.goto(`chrome-extension://${extId}/app.html`, { waitUntil: 'networkidle0' });

const stored = await page.evaluate(async () => await chrome.storage.local.get(null));
const srcInfo = await page.evaluate(async () => {
  const t = await (await fetch(chrome.runtime.getURL('background/index.js'))).text();
  return {
    长度: t.length,
    含diag_release: t.includes('diag:release'),
    含freeEngine: t.includes('freeEngineAfterTranscribe'),
    含释放引擎: t.includes('释放引擎内存'),
    含候选体积: t.includes('候选体积'),
  };
});
console.log('运行中 background 源码：', JSON.stringify(srcInfo));
console.log('运行中的 manifest 版本：', await page.evaluate(() => chrome.runtime.getManifest().version));
console.log('磁盘上 dist 的版本：', JSON.parse(await (await import('node:fs/promises')).readFile(path.join(DIST, 'manifest.json'), 'utf-8')).version);
console.log('存储的设置：', JSON.stringify(stored['settings-v2'] ?? null));
console.log('存储的旧设置：', JSON.stringify(stored['settings'] ?? null));

// 先造一个离屏文档
await page.evaluate(() => chrome.runtime.sendMessage({ type: 'selftest' }).catch(() => null));
await new Promise((r) => setTimeout(r, 3000));
console.log('离屏文档数：', browser.targets().filter((t) => t.url().includes('offscreen.html')).length);

const rel = await page.evaluate(async () => {
  try {
    return await chrome.runtime.sendMessage({ type: 'diag:cache' });
  } catch (e) { return { error: String(e) }; }
});
console.log('各上下文看到的缓存：', JSON.stringify(rel, null, 1));
console.log('页面看到的缓存：', JSON.stringify(await page.evaluate(async () => {
  const names = await caches.keys();
  const out = {};
  for (const n of names) out[n] = (await (await caches.open(n)).keys()).map((r) => r.url);
  return out;
}), null, 1));
await new Promise((r) => setTimeout(r, 2000));
console.log('释放后离屏文档数：', browser.targets().filter((t) => t.url().includes('offscreen.html')).length);
console.log('后台控制台：\n  ' + logs.slice(-15).join('\n  '));

await browser.close();
