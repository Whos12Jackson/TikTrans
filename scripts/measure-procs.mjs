// 逐进程定位内存增长：转写前/后各进程的工作集，找出谁在涨
import puppeteer from 'puppeteer-core';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(root, 'dist');
const LINK = 'https://v.douyin.com/aVsReZWbgow/';

function procs() {
  try {
    return execSync(`powershell -NoProfile -ExecutionPolicy Bypass -File "${path.join(root, 'scripts', 'procs.ps1')}"`, { encoding: 'utf-8' });
  } catch { return 'err'; }
}

function total() {
  try {
    const out = execSync(`powershell -NoProfile -Command "(Get-Process msedge -ErrorAction SilentlyContinue | Measure-Object WorkingSet64 -Sum).Sum"`, { encoding: 'utf-8' }).trim();
    return Math.round(Number(out) / 1048576);
  } catch { return -1; }
}

const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  headless: false, userDataDir: path.join(root, '.edge-profile'),
  args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`, '--no-first-run'],
});
await new Promise((r) => setTimeout(r, 3000));
const sw = browser.targets().find((t) => t.type() === 'service_worker' && t.url().includes('chrome-extension://'));
const extId = new URL(sw.url()).hostname;
const page = await browser.newPage();
await page.goto(`chrome-extension://${extId}/app.html`, { waitUntil: 'networkidle0' });
await new Promise((r) => setTimeout(r, 1000));
console.log(`基线 ${total()} MB\n${procs()}`);

async function transcribe(tag) {
  await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('button')).find((x) => x.textContent.trim() === '视频');
    b?.click();
  });
  await new Promise((r) => setTimeout(r, 400));
  await page.evaluate((link) => {
    const ta = document.querySelector('textarea');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, link);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  }, LINK);
  await new Promise((r) => setTimeout(r, 300));
  await page.evaluate(() => {
    Array.from(document.querySelectorAll('button')).find((b) => b.textContent.trim() === '提取')?.click();
  });
  const t0 = Date.now();
  while (Date.now() - t0 < 300000) {
    await new Promise((r) => setTimeout(r, 400));
    const st = await page.evaluate(async () => new Promise((res) => {
      const rq = indexedDB.open('tiktrans');
      rq.onsuccess = () => {
        try {
          const tx = rq.result.transaction('videos', 'readonly');
          const r2 = tx.objectStore('videos').getAll();
          r2.onsuccess = () => res(r2.result.filter((v) => v.state === 'done' || v.state === 'failed').length);
        } catch { res(-1); }
      };
      rq.onerror = () => res(-1);
    }));
    if (st >= 1) break;
  }
  await new Promise((r) => setTimeout(r, 5000));
  console.log(`--- ${tag} 后：${total()} MB ---\n${procs()}`);
}

await transcribe('第 1 条');
await transcribe('第 2 条');
await browser.close();
