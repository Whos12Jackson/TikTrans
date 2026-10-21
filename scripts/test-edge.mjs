// Edge 真机诊断器：加载扩展 → 抓 worker/页面全部 console → 引擎自检 → 真机 ASR（zh.wav）
// 用法：node scripts/test-edge.mjs [--keep]
import puppeteer from 'puppeteer-core';
import path from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EDGE_PATH = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const EXT_PATH = path.join(root, 'dist');
const PROFILE = path.join(root, '.edge-profile');
const WAV = path.join(root, 'node_modules', '.smoke', 'zh.wav');

const logs = [];
const log = (...a) => { const s = a.join(' '); logs.push(s); console.log(s); };

console.log('[edge] 启动 Edge（持久化 profile，模型只下一次）→', EXT_PATH);
const browser = await puppeteer.launch({
  executablePath: EDGE_PATH,
  headless: false,
  userDataDir: PROFILE,
  args: [
    `--disable-extensions-except=${EXT_PATH}`,
    `--load-extension=${EXT_PATH}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate',
  ],
});

/** 给所有 target（含 offscreen 文档、识别 Worker）挂 CDP 日志 */
const attached = new Set();
async function attachLogs() {
  for (const t of browser.targets()) {
    if (attached.has(t._targetId)) continue;
    attached.add(t._targetId);
    try {
      const client = await t.createCDPSession();
      await client.send('Runtime.enable');
      await client.send('Log.enable');
      const tag = `${t.type()}:${t.url().split('/').pop() || '?'}`.slice(0, 60);
      client.on('Runtime.consoleAPICalled', (e) => {
        const text = (e.args ?? []).map((a) => a.value ?? a.description ?? a.type).join(' ');
        log(`[${tag}] console.${e.type}: ${text}`);
      });
      client.on('Runtime.exceptionThrown', (e) => {
        const d = e.exceptionDetails;
        const desc = d.exception?.description ?? d.text;
        log(`[${tag}] EXCEPTION: ${desc}`);
      });
      client.on('Log.entryAdded', (e) => {
        log(`[${tag}] log.${e.entry.level}: ${e.entry.text}`);
      });
    } catch { /* 某些 target 不支持 CDP，忽略 */ }
  }
}
// 持续给新出现的 target（尤其识别 Worker）挂日志
const logTimer = setInterval(() => { void attachLogs(); }, 2000);

try {
  await new Promise((r) => setTimeout(r, 3000));
  await attachLogs();

  const swTarget = browser.targets().find((t) => t.type() === 'service_worker' && t.url().includes('chrome-extension://'));
  if (!swTarget) throw new Error('未找到扩展 Service Worker');
  const extId = new URL(swTarget.url()).hostname;
  log(`[edge] 扩展 ID: ${extId}`);

  const page = await browser.newPage();
  await page.goto(`chrome-extension://${extId}/app.html`, { waitUntil: 'networkidle0', timeout: 20000 });
  await new Promise((r) => setTimeout(r, 800));
  await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('button')).find((x) => x.textContent.trim() === '设置');
    b?.click();
  });
  await new Promise((r) => setTimeout(r, 500));

  // ---- 模型状态 ----
  const modelState = await page.evaluate(() => {
    const hint = Array.from(document.querySelectorAll('.hint'))
      .find((h) => h.textContent.trim().startsWith('模型状态'));
    return hint?.textContent?.trim() ?? '未知';
  });
  log(`[edge] ${modelState}`);

  if (modelState.includes('未下载')) {
    log('[edge] 下载模型中...');
    await page.evaluate(() => {
      Array.from(document.querySelectorAll('button')).find((b) => b.textContent.includes('下载模型'))?.click();
    });
    const dl = await page.evaluate(async () => {
      for (let i = 0; i < 1200; i++) {
        await new Promise((r) => setTimeout(r, 100));
        const t = document.querySelector('.toast')?.textContent || '';
        if (t.includes('完成') || t.includes('失败')) return t.trim();
      }
      return '超时';
    });
    log(`[edge] 模型下载: ${dl}`);
  }

  // ---- 引擎自检 ----
  log('[edge] 引擎自检...');
  const selftest = await page.evaluate(async () => {
    const b = Array.from(document.querySelectorAll('button')).find((x) => x.textContent.includes('引擎自检'));
    if (!b) return '找不到自检按钮';
    const old = document.querySelector('.toast');
    if (old) old.textContent = '';
    b.click();
    for (let i = 0; i < 200; i++) {
      await new Promise((r) => setTimeout(r, 100));
      const t = document.querySelector('.toast')?.textContent || '';
      if (t && (t.includes('正常') || t.includes('失败') || t.includes('崩溃'))) return t.trim();
    }
    return '20秒无结果';
  });
  log(`[edge] 自检结果: ${selftest}`);

  // ---- 真机 ASR（zh.wav）----
  if (existsSync(WAV)) {
    log('[edge] 真机 ASR 测试（zh.wav）...');
    const wav = readFileSync(WAV);
    const dv = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
    let off = 12, fmt = null, dataOff = -1, dataLen = 0;
    while (off + 8 <= wav.length) {
      const id = String.fromCharCode(wav[off], wav[off + 1], wav[off + 2], wav[off + 3]);
      const size = dv.getUint32(off + 4, true);
      if (id === 'fmt ') fmt = { channels: dv.getUint16(off + 10, true), rate: dv.getUint32(off + 12, true), bits: dv.getUint16(off + 22, true) };
      if (id === 'data') { dataOff = off + 8; dataLen = size; }
      off += 8 + size + (size % 2);
    }
    const n = Math.floor(dataLen / (fmt.bits / 8));
    const mono = new Float32Array(n / fmt.channels);
    for (let i = 0; i < mono.length; i++) {
      let acc = 0;
      for (let c = 0; c < fmt.channels; c++) acc += dv.getInt16(dataOff + (i * fmt.channels + c) * 2, true) / 32768;
      mono[i] = acc / fmt.channels;
    }
    const pcmB64 = Buffer.from(mono.buffer).toString('base64');
    log(`[edge] wav: ${mono.length} 样本 @${fmt.rate}Hz（${(mono.length / fmt.rate).toFixed(2)}s）`);

    // 拼成 3 分钟音频，测真实耗时
    const REPEAT = Math.max(1, Math.round(180 / (mono.length / fmt.rate)));
    const total = mono.length * REPEAT;
    const long3min = new Float32Array(total);
    for (let i = 0; i < REPEAT; i++) long3min.set(mono, i * mono.length);
    const longB64 = Buffer.from(long3min.buffer).toString('base64');
    log(`[edge] 3 分钟音频: ${REPEAT} 段拼接 = ${(total / fmt.rate).toFixed(1)}s`);

    const runAsr = async (b64, label) => {
      const r = await page.evaluate(async (b) => {
        const w = new Worker(chrome.runtime.getURL('offscreen/asr-worker.js'));
        return await new Promise((resolve) => {
          const timer = setTimeout(() => { w.terminate(); resolve({ error: '300 秒无响应' }); }, 300000);
          w.onmessage = (ev) => {
            if (ev.data?.type === 'asr:debug-wav-result') { clearTimeout(timer); w.terminate(); resolve(ev.data.payload); }
          };
          w.onerror = (e) => { clearTimeout(timer); w.terminate(); resolve({ error: `worker error: ${e.message}` }); };
          w.postMessage({ type: 'asr:debug-wav', payload: { pcmBase64: b } });
        });
      }, b64);
      const audioSec = label.includes('3分钟') ? (total / fmt.rate) : (mono.length / fmt.rate);
      const rtf = r.msTotal ? (r.msTotal / 1000 / audioSec).toFixed(2) : '?';
      log(`[edge] ${label}: ${JSON.stringify(r)}  → 实时率 RTF=${rtf}（越小越快）`);
      return r;
    };

    const envInfo = await page.evaluate(() => ({
      coi: window.crossOriginIsolated, sab: typeof SharedArrayBuffer !== 'undefined',
      cores: navigator.hardwareConcurrency,
    }));
    log(`[edge] 页面环境: ${JSON.stringify(envInfo)}`);

    await runAsr(pcmB64, '5.6秒音频');
    await runAsr(longB64, '3分钟音频');
  } else {
    log('[edge] 缺少 zh.wav，跳过 ASR 测试');
  }

  log('\n[edge] ===== 全部日志结束 =====');
} catch (e) {
  console.error('[edge] 测试异常:', e);
} finally {
  await browser.close();
}
