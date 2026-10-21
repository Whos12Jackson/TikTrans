// 离线全链路验证（用本地模型服务器）：
//   1) 下载模型（存 IndexedDB）
//   2) 转写一条视频 → 看行数
//   3) 关掉浏览器重开 → 再转写（验证模型跨会话还能读到）
//   4) 连转 3 条，看内存是否还暴涨
import puppeteer from 'puppeteer-core';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(root, 'dist');
const PROFILE = path.join(root, '.edge-profile');
const PORT = 8788;
const BASE = `http://127.0.0.1:${PORT}`;
const LINK = 'https://v.douyin.com/aVsReZWbgow/';

function edgeMem() {
  try {
    const out = execSync(`powershell -NoProfile -Command "(Get-Process msedge -ErrorAction SilentlyContinue | Measure-Object WorkingSet64 -Sum).Sum"`, { encoding: 'utf-8' }).trim();
    return Math.round(Number(out) / 1048576);
  } catch { return -1; }
}

async function launch() {
  const browser = await puppeteer.launch({
    executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    headless: false, userDataDir: PROFILE,
    args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`, '--no-first-run'],
    protocolTimeout: 600000,
  });
  await new Promise((r) => setTimeout(r, 4000));
  const sw = browser.targets().find((t) => t.type() === 'service_worker' && t.url().includes('chrome-extension://'));
  if (!sw) throw new Error('找不到后台 service worker');
  const extId = new URL(sw.url()).hostname;
  const page = await browser.newPage();
  await page.goto(`chrome-extension://${extId}/app.html`, { waitUntil: 'networkidle0' });
  await new Promise((r) => setTimeout(r, 800));
  // 抓所有上下文的控制台（引擎初始化次数、Worker 创建次数）
  const logs = [];
  const hook = async (target) => {
    try {
      const cdp = await target.createCDPSession();
      await cdp.send('Runtime.enable');
      cdp.on('Runtime.consoleAPICalled', (ev) => {
        const txt = (ev.args ?? []).map((a) => a.value ?? a.description ?? '').join(' ');
        if (txt.includes('引擎初始化') || txt.includes('Worker #') || txt.includes('模型文件')) logs.push(txt.slice(0, 120));
      });
    } catch { /* 忽略 */ }
  };
  for (const t of browser.targets()) await hook(t);
  browser.on('targetcreated', (t) => { void hook(t); });
  setInterval(() => { for (const t of browser.targets()) void hook(t); }, 2000);
  (browser).__logs = logs;
  return { browser, page, extId };
}

/** 把模型地址指向本地服务器，并下载 */
async function setupModel(page) {
  await page.evaluate(async (base) => {
    const KEY = 'settings-v2';
    const cur = (await chrome.storage.local.get(KEY))[KEY] ?? {};
    const next = {
      ...cur,
      model: {
        ...(cur.model ?? {}),
        modelUrl: `${base}/model.int8.onnx`,
        tokensUrl: `${base}/tokens.txt`,
        vadUrl: `${base}/silero_vad.onnx`,
        modelSha256: '',
      },
    };
    await chrome.storage.local.set({ [KEY]: next });
  }, BASE);
  await page.reload({ waitUntil: 'networkidle0' });
  await new Promise((r) => setTimeout(r, 800));
  await page.evaluate(() => {
    Array.from(document.querySelectorAll('button')).find((b) => b.textContent.trim() === '设置')?.click();
  });
  await new Promise((r) => setTimeout(r, 600));
  const has = await page.evaluate(async () => {
    const db = await new Promise((res) => { const rq = indexedDB.open('tiktrans'); rq.onsuccess = () => res(rq.result); });
    return new Promise((res) => {
      try {
        const tx = db.transaction('models', 'readonly');
        const rq = tx.objectStore('models').getAll();
        rq.onsuccess = () => res(rq.result.map((r) => `${r.key}:${r.size}`));
      } catch (e) { res('ERR ' + e); }
    });
  });
  console.log('  模型表内容：', JSON.stringify(has));
  if (Array.isArray(has) && has.length >= 3) { console.log('  模型已就绪'); return; }

  await page.evaluate(() => {
    Array.from(document.querySelectorAll('button')).find((b) => b.textContent.includes('下载模型'))?.click();
  });
  const t0 = Date.now();
  while (Date.now() - t0 < 240000) {
    await new Promise((r) => setTimeout(r, 2000));
    const n = await page.evaluate(async () => {
      const db = await new Promise((res) => { const rq = indexedDB.open('tiktrans'); rq.onsuccess = () => res(rq.result); });
      return new Promise((res) => {
        try {
          const tx = db.transaction('models', 'readonly');
          const rq = tx.objectStore('models').getAll();
          rq.onsuccess = () => res(rq.result.length);
        } catch { res(0); }
      });
    });
    if (n >= 3) { console.log(`  模型下载完成（${Math.round((Date.now() - t0) / 1000)}s）`); break; }
  }
}

async function transcribe(page, tag) {
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
  // 记录转写前的行数，等「新的一轮」完成（同一视频重复转写时 done 数不变）
  const before = await page.evaluate(async () => new Promise((res) => {
    const rq = indexedDB.open('tiktrans');
    rq.onsuccess = () => {
      try {
        const tx = rq.result.transaction('lines', 'readonly');
        const r2 = tx.objectStore('lines').getAll();
        r2.onsuccess = () => res(r2.result.length);
      } catch { res(0); }
    };
  }));
  let done = 0;
  let lines = before;
  while (Date.now() - t0 < 300000) {
    await new Promise((r) => setTimeout(r, 500));
    done = await page.evaluate(async () => new Promise((res) => {
      const rq = indexedDB.open('tiktrans');
      rq.onsuccess = () => {
        try {
          const tx = rq.result.transaction('videos', 'readonly');
          const r2 = tx.objectStore('videos').getAll();
          r2.onsuccess = () => res(r2.result.filter((v) => v.state === 'done').length);
        } catch { res(0); }
      };
      rq.onerror = () => res(0);
    }));
    // 等这一轮的成行结果落库（行数变化或视频被重新处理完成）
    const st = await page.evaluate(async () => new Promise((res) => {
      const rq = indexedDB.open('tiktrans');
      rq.onsuccess = () => {
        try {
          const tx = rq.result.transaction('videos', 'readonly');
          const r2 = tx.objectStore('videos').getAll();
          r2.onsuccess = () => {
            const v = r2.result.find((x) => x.contentId === '7671586501813874801');
            res(v ? `${v.state}/${v.stage}` : 'none');
          };
        } catch { res('none'); }
      };
    }));
    if (st === 'done/ready') break;
  }
  await new Promise((r) => setTimeout(r, 2000));
  lines = await page.evaluate(async () => new Promise((res) => {
    const rq = indexedDB.open('tiktrans');
    rq.onsuccess = () => {
      try {
        const tx = rq.result.transaction('lines', 'readonly');
        const r2 = tx.objectStore('lines').getAll();
        r2.onsuccess = () => res(r2.result.length);
      } catch { res(-1); }
    };
  }));
  // 引擎统计（wasm 内存多大、初始化几次）
  const stats = await page.evaluate(async () => new Promise((res) => {
    const rq = indexedDB.open('tiktrans');
    rq.onsuccess = () => {
      try {
        const tx = rq.result.transaction('asrResults', 'readonly');
        const r2 = tx.objectStore('asrResults').getAll();
        r2.onsuccess = () => res(r2.result.length);
      } catch { res(-1); }
    };
  }));
  console.log(`  ${tag}：${Math.round((Date.now() - t0) / 1000)}s，行数 ${lines}，ASR 记录 ${stats}，Edge 内存 ${edgeMem()} MB`);
  return lines;
}
function dumpLogs(browser, label) {
  const logs = browser.__logs ?? [];
  console.log(`  [${label}] 引擎/Worker 日志：`);
  for (const l of logs.slice(-10)) console.log('    ' + l);
  logs.length = 0;
}

// ===== 第 1 轮：新会话，下载模型 + 转写 =====
{
  console.log('【第1轮】新会话');
  const { browser, page } = await launch();
  await setupModel(page);
  await transcribe(page, '第 1 条');
  await browser.close();
}

// ===== 第 2 轮：重启浏览器（验证模型跨会话）+ 连转 3 条看内存 =====
{
  console.log('\n【第2轮】重启浏览器后');
  const { browser, page } = await launch();
  await setupModel(page);   // 只改地址，已下载则跳过
  await transcribe(page, '第 1 条');
  dumpLogs(browser, '第1条');
  await transcribe(page, '第 2 条');
  dumpLogs(browser, '第2条');
  await transcribe(page, '第 3 条');
  dumpLogs(browser, '第3条');
  await browser.close();
}
console.log('\n离线全链路验证完成');
