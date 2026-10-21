// 单独测模型下载：在外部轮询进度（避开 puppeteer 的协议超时）
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
await new Promise((r) => setTimeout(r, 3000));
const sw = browser.targets().find((t) => t.type() === 'service_worker' && t.url().includes('chrome-extension://'));
const extId = new URL(sw.url()).hostname;
const page = await browser.newPage();
await page.goto(`chrome-extension://${extId}/app.html`, { waitUntil: 'networkidle0' });
await new Promise((r) => setTimeout(r, 800));
await page.evaluate(() => {
  Array.from(document.querySelectorAll('button')).find((b) => b.textContent.trim() === '设置')?.click();
});
await new Promise((r) => setTimeout(r, 600));

const state = await page.evaluate(async () => {
  const { hasModels } = await import('/assets/index.js').catch(() => ({}));
  return document.body.innerText.slice(0, 200);
});
console.log('设置页状态：', state.replace(/\n+/g, ' | ').slice(0, 160));

await page.evaluate(() => {
  Array.from(document.querySelectorAll('button')).find((b) => b.textContent.includes('下载模型'))?.click();
});
page.on('console', (m) => { console.log('[页面]', m.text().slice(0, 200)); });
page.on('pageerror', (e) => { console.log('[页面错误]', String(e).slice(0, 300)); });
const t0 = Date.now();
let last = '';
for (let i = 0; i < 120; i++) {
  await new Promise((r) => setTimeout(r, 3000));
  const s = await page.evaluate(() => {
    const hints = [...document.querySelectorAll('.hint')].map((x) => x.textContent.trim());
    const toast = document.querySelector('.toast')?.textContent?.trim() ?? '';
    return { hints: hints.filter((h) => h.includes('下载') || h.includes('MB') || h.includes('模型')).join(' | '), toast };
  });
  const line = `${Math.round((Date.now() - t0) / 1000)}s ${s.hints.slice(0, 120)} ${s.toast}`;
  if (line !== last) { console.log(line); last = line; }
  if (s.toast.includes('完成') || s.toast.includes('失败')) break;
}
console.log('最终用时：', Math.round((Date.now() - t0) / 1000), '秒');
await browser.close();
