// 连转两条视频，看内存是「继续涨（泄漏）」还是「持平（复用）」
import puppeteer from 'puppeteer-core';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(root, 'dist');
const LINK = 'https://v.douyin.com/aVsReZWbgow/';

function edgeMem() {
  try {
    const out = execSync(
      `powershell -NoProfile -Command "(Get-Process msedge -ErrorAction SilentlyContinue | Measure-Object WorkingSet64 -Sum).Sum"`,
      { encoding: 'utf-8' },
    ).trim();
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
const logs = [];
const hook = async (target) => {
  try {
    const cdp = await target.createCDPSession();
    await cdp.send('Runtime.enable');
    cdp.on('Runtime.consoleAPICalled', (ev) => {
      const txt = (ev.args ?? []).map((a) => a.value ?? a.description ?? '').join(' ');
      if (txt.includes('tiktrans')) logs.push(`[${target.type()}] ${txt}`);
    });
  } catch { /* 目标可能已关闭 */ }
};
await hook(sw);
browser.on('targetcreated', (t) => { void hook(t); });
const page = await browser.newPage();
await page.goto(`chrome-extension://${extId}/app.html`, { waitUntil: 'networkidle0' });
await new Promise((r) => setTimeout(r, 1000));

console.log(`基线：${edgeMem()} MB`);

// 模型没下载就先下（约 228MB）
const hasModel = await page.evaluate(async () => {
  const c = await caches.open('tiktrans-models-v2');
  return (await c.keys()).length >= 3;
});
if (!hasModel) {
  console.log('模型缺失，先下载…');
  await page.evaluate(() => {
    Array.from(document.querySelectorAll('button')).find((b) => b.textContent.trim() === '设置')?.click();
  });
  await new Promise((r) => setTimeout(r, 500));
  await page.evaluate(() => {
    Array.from(document.querySelectorAll('button')).find((b) => b.textContent.includes('下载模型'))?.click();
  });
  for (let i = 0; i < 180; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const n = await page.evaluate(async () => (await (await caches.open('tiktrans-models-v2')).keys()).length);
    if (n >= 3) { console.log('模型下载完成'); break; }
  }
  await page.evaluate(() => {
    Array.from(document.querySelectorAll('button')).find((b) => b.textContent.trim() === '视频')?.click();
  });
  await new Promise((r) => setTimeout(r, 500));
  console.log(`下载模型后：${edgeMem()} MB`);
}

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
  let peak = 0;
  while (Date.now() - t0 < 300000) {
    await new Promise((r) => setTimeout(r, 400));
    peak = Math.max(peak, edgeMem());
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
  await new Promise((r) => setTimeout(r, 4000)); // 等释放
  const after = edgeMem();
  console.log(`${tag}：峰值 ${peak} MB，转写完成后 ${after} MB，离屏文档 ${browser.targets().filter((t) => t.url().includes('offscreen.html')).length} 个`);
}

await transcribe('第 1 条');
await transcribe('第 2 条');
await transcribe('第 3 条');
console.log(`结束：${edgeMem()} MB`);
console.log('引擎/Worker 相关日志：\n  ' + logs.filter((l) => l.includes('引擎初始化') || l.includes('Worker') || l.includes('心跳') || l.includes('pong')).join('\n  '));
console.log('全部 tiktrans 日志尾部：\n  ' + logs.slice(-12).join('\n  '));

await browser.close();
