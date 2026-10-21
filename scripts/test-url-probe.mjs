// 验证「测试下载源」诊断功能
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
  protocolTimeout: 600000,
});
await new Promise((r) => setTimeout(r, 4000));
const sw = browser.targets().find((t) => t.type() === 'service_worker' && t.url().includes('chrome-extension://'));
const extId = new URL(sw.url()).hostname;
const page = await browser.newPage();
await page.goto(`chrome-extension://${extId}/app.html`, { waitUntil: 'networkidle0' });
await new Promise((r) => setTimeout(r, 1000));

// 把模型地址都指向本地服务器（一个能连、一个 404）
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
        modelFallbackUrls: {
          model: [`${base}/not-exist.int8.onnx`],
          tokens: [`${base}/tokens.txt`],
          vad: [],
        },
      },
    },
  });
}, BASE);
await page.reload({ waitUntil: 'networkidle0' });
await new Promise((r) => setTimeout(r, 1200));

const logs = [];
page.on('console', (m) => logs.push(m.text()));
await page.evaluate(() => {
  Array.from(document.querySelectorAll('button')).find((b) => b.textContent.trim() === '设置')?.click();
});
await new Promise((r) => setTimeout(r, 600));
await page.evaluate(() => {
  Array.from(document.querySelectorAll('button')).find((b) => b.textContent.includes('测试下载源'))?.click();
});
await new Promise((r) => setTimeout(r, 6000));
const out = logs.filter((l) => l.includes('下载源测试结果') || l.includes('✅') || l.includes('❌')).join('\n');
console.log(out || '(没抓到控制台输出)');
await browser.close();
