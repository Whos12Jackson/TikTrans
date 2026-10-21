// 专测模型下载：本地服务器模拟「一次只给 1MB」的 CDN，验证能循环拉完
import puppeteer from 'puppeteer-core';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(root, 'dist');
const BASE = 'http://127.0.0.1:8788';

const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  headless: false, userDataDir: path.join(root, '.edge-profile'),
  args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`, '--no-first-run'],
  protocolTimeout: 900000,
});
await new Promise((r) => setTimeout(r, 4000));
const sw = browser.targets().find((t) => t.type() === 'service_worker' && t.url().includes('chrome-extension://'));
const extId = new URL(sw.url()).hostname;
const page = await browser.newPage();
await page.goto(`chrome-extension://${extId}/app.html`, { waitUntil: 'networkidle0' });
await new Promise((r) => setTimeout(r, 800));

// 指向本地服务器（并清空兜底地址，保证只试这一个地址，测试结果确定）
await page.evaluate(async (base) => {
  const KEY = 'settings-v2';
  const cur = (await chrome.storage.local.get(KEY))[KEY] ?? {};
  await chrome.storage.local.set({
    [KEY]: {
      ...cur,
      model: {
        ...(cur.model ?? {}),
        modelUrl: `${base}/model.int8.onnx`,
        tokensUrl: `${base}/tokens.txt`,
        vadUrl: `${base}/silero_vad.onnx`,
        modelSha256: '',
        modelFallbackUrls: {
          // 备用地址指向本地服务器（正常文件）——用来验证「主地址卡死 → 自动换备用地址」
          model: [`${base}/model.int8.onnx`],
          tokens: [],
          vad: [],
        },
      },
    },
  });
}, BASE);
await page.reload({ waitUntil: 'networkidle0' });
await new Promise((r) => setTimeout(r, 1000));
await page.evaluate(() => {
  Array.from(document.querySelectorAll('button')).find((b) => b.textContent.trim() === '设置')?.click();
});
await new Promise((r) => setTimeout(r, 600));

const readSizes = () => page.evaluate(async () => new Promise((res) => {
  const rq = indexedDB.open('tiktrans');
  rq.onsuccess = () => {
    try {
      const tx = rq.result.transaction('models', 'readonly');
      const r2 = tx.objectStore('models').getAll();
      r2.onsuccess = () => res(r2.result.map((r) => `${r.key}=${r.size}`));
    } catch { res(['err']); }
  };
}));

await page.evaluate(() => {
  Array.from(document.querySelectorAll('button')).find((b) => b.textContent.includes('下载模型'))?.click();
});
const t0 = Date.now();
let last = '';
for (let i = 0; i < 30; i++) {
  await new Promise((r) => setTimeout(r, 2000));
  const sizes = await readSizes();
  const toast = await page.evaluate(() => document.querySelector('.toast')?.textContent?.trim() ?? '');
  const line = `${Math.round((Date.now() - t0) / 1000)}s ${sizes.join(' ')}`;
  if (line !== last) { console.log(line, toast ? `提示：${toast}` : ''); last = line; }
  if (sizes.some((s) => s.includes('model=239233841'))) { console.log('✅ 主模型下载完整（239,233,841 字节）'); break; }
  if (toast) { console.log('❌ 界面提示：', toast); break; }
}
console.log('最终：', await readSizes());
await browser.close();
