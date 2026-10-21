// 验证：手动导入模型文件（网络下不动时的兜底）
import puppeteer from 'puppeteer-core';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(root, 'dist');
const SM = path.join(root, 'node_modules', '.smoke');

const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  headless: false, userDataDir: path.join(root, '.edge-profile'),
  args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`, '--no-first-run'],
  protocolTimeout: 600000,
});
await new Promise((r) => setTimeout(r, 4000));
const sw = browser.targets().find((t) => t.type() === 'service_worker' && t.url().includes('chrome-extension://'));
const extId = new URL(sw.url()).hostname;
const page = await browser.newPage();
await page.goto(`chrome-extension://${extId}/app.html`, { waitUntil: 'networkidle0' });
await new Promise((r) => setTimeout(r, 1000));

// 引导页上应该能看到「手动导入模型文件」
const onb = await page.evaluate(() => document.body.innerText.includes('手动导入模型文件'));
console.log('引导页显示手动导入入口：', onb ? '✅' : '❌');

// 直接调 importModelFile 验证（模拟用户选文件）
const res = await page.evaluate(async (sm) => {
  const out = [];
  const mod = await import('/assets/index.js').catch(() => null);
  // 扩展打包后模块路径不可直接 import，改为通过 UI 的 file input 注入
  return out;
}, SM);

// 用 CDP 给 file input 塞文件
const handles = await page.$$('input[type=file]');
console.log('页面里的 file input 数量：', handles.length);
if (handles.length >= 3) {
  await handles[0].uploadFile(path.join(SM, 'model.int8.onnx'));
  await new Promise((r) => setTimeout(r, 3000));
  await handles[1].uploadFile(path.join(SM, 'tokens.txt'));
  await new Promise((r) => setTimeout(r, 2000));
  await handles[2].uploadFile(path.join(SM, 'silero_vad.onnx'));
  await new Promise((r) => setTimeout(r, 3000));
}

const sizes = await page.evaluate(async () => new Promise((res) => {
  const rq = indexedDB.open('tiktrans');
  rq.onsuccess = () => {
    try {
      const tx = rq.result.transaction('models', 'readonly');
      const r2 = tx.objectStore('models').getAll();
      r2.onsuccess = () => res(r2.result.map((r) => `${r.key}=${r.size}`));
    } catch (e) { res(['err:' + e]); }
  };
}));
console.log('导入后的模型表：', JSON.stringify(sizes));
const ok = sizes.includes('model=239233841') && sizes.includes('tokens=315894') && sizes.includes('vad=643854');
console.log(ok ? '✅ 三个文件都导入成功' : '❌ 导入不完整');
await browser.close();
