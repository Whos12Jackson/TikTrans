// 严谨的内存测试：每轮转写都等到「引擎统计」变化（=本轮真的跑完了）再测
import puppeteer from 'puppeteer-core';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(root, 'dist');
const LINK = 'https://v.douyin.com/aVsReZWbgow/';

function edgeMem() {
  try {
    const out = execSync(`powershell -NoProfile -Command "(Get-Process msedge -ErrorAction SilentlyContinue | Measure-Object WorkingSet64 -Sum).Sum"`, { encoding: 'utf-8' }).trim();
    return Math.round(Number(out) / 1048576);
  } catch { return -1; }
}

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
await new Promise((r) => setTimeout(r, 800));

const readNote = () => page.evaluate(async () => new Promise((res) => {
  const rq = indexedDB.open('tiktrans');
  rq.onsuccess = () => {
    try {
      const tx = rq.result.transaction('videos', 'readonly');
      const r2 = tx.objectStore('videos').getAll();
      r2.onsuccess = () => {
        const v = r2.result.find((x) => x.contentId === '7671586501813874801');
        res(v ? `${v.state}/${v.stage} :: ${v.note ?? ''}` : 'none');
      };
    } catch { res('err'); }
  };
}));

for (let i = 1; i <= 3; i++) {
  const before = await readNote();
  await page.evaluate(() => {
    Array.from(document.querySelectorAll('button')).find((x) => x.textContent.trim() === '视频')?.click();
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
  let after = before;
  while (Date.now() - t0 < 240000) {
    await new Promise((r) => setTimeout(r, 2000));
    after = await readNote();
    if (after !== before && after.includes('done/ready')) break;
  }
  console.log(`第 ${i} 轮：${Math.round((Date.now() - t0) / 1000)}s  ${after}  → Edge ${edgeMem()} MB`);
}
await browser.close();
