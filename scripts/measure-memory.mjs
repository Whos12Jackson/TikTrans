// 内存实测：转写一条 3 分钟视频，全程采样 Edge 的内存占用
import puppeteer from 'puppeteer-core';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EDGE_PATH = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const EXT_PATH = path.join(root, 'dist');
const PROFILE = path.join(root, '.edge-profile');
const LINK = 'https://v.douyin.com/aVsReZWbgow/';

/** Edge 全部进程的工作集总和（MB） */
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
  executablePath: EDGE_PATH, headless: false, userDataDir: PROFILE,
  args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, '--no-first-run'],
});

const samples = [];
const sampler = setInterval(() => samples.push({ t: Date.now(), mb: edgeMem() }), 1000);

try {
  await new Promise((r) => setTimeout(r, 3000));
  const sw = browser.targets().find((t) => t.type() === 'service_worker' && t.url().includes('chrome-extension://'));
  const extId = new URL(sw.url()).hostname;
  // 抓后台与离屏文档的控制台
  const logs = [];
  const hookTarget = async (target) => {
    try {
      const cdp = await target.createCDPSession();
      await cdp.send('Runtime.enable');
      cdp.on('Runtime.consoleAPICalled', (ev) => {
        const txt = (ev.args ?? []).map((a) => a.value ?? a.description ?? '').join(' ');
        if (txt.includes('tiktrans') || txt.includes('释放') || txt.includes('失败')) logs.push(`[${target.type()}] ${txt}`);
      });
    } catch { /* 目标可能已关闭 */ }
  };
  await hookTarget(sw);
  browser.on('targetcreated', (t) => { void hookTarget(t); });
  const page = await browser.newPage();
  await page.goto(`chrome-extension://${extId}/app.html`, { waitUntil: 'networkidle0' });
  await new Promise((r) => setTimeout(r, 1000));

  // 采样离屏文档的 JS 堆
  const cdp = await page.createCDPSession();
  await cdp.send('Performance.enable');
  const heap = async () => {
    const { metrics } = await cdp.send('Performance.getMetrics');
    const get = (n) => metrics.find((m) => m.name === n)?.value ?? 0;
    return { heapMB: +(get('JSHeapUsedSize') / 1048576).toFixed(1), heapTotalMB: +(get('JSHeapTotalSize') / 1048576).toFixed(1) };
  };

  console.log(`启动后：Edge 合计 ${edgeMem()} MB`);
  // 预热：先跑一次自检（加载模型 + 建会话），看这一步吃掉多少
  await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('button')).find((x) => x.textContent.trim() === '设置');
    b?.click();
  });
  await new Promise((r) => setTimeout(r, 400));
  const beforeSelf = edgeMem();
  await page.evaluate(async () => {
    const b = Array.from(document.querySelectorAll('button')).find((x) => x.textContent.includes('引擎自检'));
    b?.click();
    for (let i = 0; i < 300; i++) {
      await new Promise((r) => setTimeout(r, 100));
      const t = document.querySelector('.toast')?.textContent || '';
      if (t.includes('正常') || t.includes('失败')) return t;
    }
  });
  const afterSelf = edgeMem();
  console.log(`引擎自检（= 加载 228MB 模型 + 建会话）：${beforeSelf} MB → ${afterSelf} MB  (+${afterSelf - beforeSelf} MB)`);
  console.log(`  JS 堆：${JSON.stringify(await heap())}`);

  // 跑一条真实转写
  await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('button')).find((x) => x.textContent.trim() === '视频');
    b?.click();
  });
  await new Promise((r) => setTimeout(r, 400));
  const beforeRun = edgeMem();
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

  // 等转写完成
  const t0 = Date.now();
  let peak = 0;
  while (Date.now() - t0 < 240000) {
    await new Promise((r) => setTimeout(r, 500));
    const st = await page.evaluate(async () => {
      const dbs = await indexedDB.databases();
      if (!dbs.length) return null;
      return new Promise((res) => {
        const rq = indexedDB.open('tiktrans');
        rq.onsuccess = () => {
          const db = rq.result;
          try {
            const tx = db.transaction('videos', 'readonly');
            const r2 = tx.objectStore('videos').getAll();
            r2.onsuccess = () => res(r2.result.map((v) => `${v.state}/${v.stage}`).join(','));
          } catch { res(null); }
        };
        rq.onerror = () => res(null);
      });
    });
    if (st && st.includes('done')) break;
  }
  const afterRun = edgeMem();
  console.log(`转写一条 3 分 17 秒视频：${beforeRun} MB → ${afterRun} MB  (+${afterRun - beforeRun} MB)`);
  console.log(`  JS 堆：${JSON.stringify(await heap())}`);

  // 离屏文档还在吗？
  const offscreenAlive = browser.targets().filter((t) => t.url().includes('offscreen.html')).length;
  console.log(`  离屏文档存活数：${offscreenAlive}`);
  console.log(`  后台日志：\n    ${logs.slice(-12).join('\n    ') || '（无）'}`);

  // 强制销毁后再看内存
  await page.evaluate(() => chrome.runtime.sendMessage({ type: 'diag:release' }).catch(() => {}));
  await new Promise((r) => setTimeout(r, 3000));
  console.log(`  强制释放后：${edgeMem()} MB（离屏文档存活数 ${browser.targets().filter((t) => t.url().includes('offscreen.html')).length}）`);

  const peakMb = Math.max(...samples.map((s) => s.mb));
  console.log(`\n全程 Edge 内存峰值：${peakMb} MB`);
  // 打印时间线（每 5 秒一个点）
  const line = [];
  for (let i = 0; i < samples.length; i += 5) line.push(`${Math.round((samples[i].t - samples[0].t) / 1000)}s:${samples[i].mb}MB`);
  console.log('时间线：' + line.join('  '));
} finally {
  clearInterval(sampler);
  await browser.close();
}
