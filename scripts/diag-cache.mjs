// 诊断：扩展缓存里的模型文件到底在不在
import puppeteer from 'puppeteer-core';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  headless: false,
  userDataDir: path.join(root, '.edge-profile'),
  args: [`--disable-extensions-except=${path.join(root, 'dist')}`, `--load-extension=${path.join(root, 'dist')}`, '--no-first-run'],
});
await new Promise((r) => setTimeout(r, 3000));
const sw = browser.targets().find((t) => t.type() === 'service_worker' && t.url().includes('chrome-extension://'));
const extId = new URL(sw.url()).hostname;
const page = await browser.newPage();
await page.goto(`chrome-extension://${extId}/app.html`, { waitUntil: 'networkidle0' });

const info = await page.evaluate(async () => {
  const names = await caches.keys();
  const out = { names, keys: {} };
  for (const n of names) {
    const c = await caches.open(n);
    out.keys[n] = (await c.keys()).map((r) => r.url);
  }
  return out;
});
console.log('缓存列表：', JSON.stringify(info, null, 1));

// 自检结果
const selftest = await page.evaluate(async () => {
  const send = (m) => chrome.runtime.sendMessage(m);
  const r = await send({ type: 'selftest' });
  return r;
});
console.log('自检：', JSON.stringify(selftest));

await browser.close();
