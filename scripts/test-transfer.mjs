// A/B 对照：同样的 Float32Array，两种传递方式，看 Worker 收到的是什么
import puppeteer from 'puppeteer-core';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EDGE_PATH = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const EXT_PATH = path.join(root, 'dist');
const PROFILE = path.join(root, '.edge-profile');

const browser = await puppeteer.launch({
  executablePath: EDGE_PATH, headless: false, userDataDir: PROFILE,
  args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, '--no-first-run'],
});
try {
  await new Promise((r) => setTimeout(r, 3000));
  const sw = browser.targets().find((t) => t.type() === 'service_worker' && t.url().includes('chrome-extension://'));
  const extId = new URL(sw.url()).hostname;
  const page = await browser.newPage();
  await page.goto(`chrome-extension://${extId}/app.html`, { waitUntil: 'networkidle0' });
  await new Promise((r) => setTimeout(r, 800));

  const out = await page.evaluate(async () => {
    const results = {};
    const call = async (label, send) => {
      const w = new Worker(chrome.runtime.getURL('offscreen/asr-worker.js'));
      results[label] = await new Promise((resolve) => {
        const t = setTimeout(() => { w.terminate(); resolve({ error: '超时' }); }, 15000);
        w.onmessage = (ev) => { if (ev.data?.type === 'asr:debug-samples-result') { clearTimeout(t); w.terminate(); resolve(ev.data.payload); } };
        w.onerror = (e) => { clearTimeout(t); w.terminate(); resolve({ error: e.message }); };
        send(w);
      });
    };
    // A: 结构化克隆（不转移）
    await call('A_不转移', (w) => {
      const s = new Float32Array([0.1, -0.2, 0.3, 0.4, 0.5]);
      w.postMessage({ type: 'asr:debug-samples', payload: { samples: s } });
    });
    // B: 带 transfer 列表
    await call('B_带转移列表', (w) => {
      const s = new Float32Array([0.1, -0.2, 0.3, 0.4, 0.5]);
      w.postMessage({ type: 'asr:debug-samples', payload: { samples: s } }, [s.buffer]);
    });
    // C: 模拟 decodeAudioData + OfflineAudioContext 出来的样本再转移（真实链路）
    await call('C_重采样后转移', async (w) => {
      const ctx = new AudioContext();
      const ab = await ctx.decodeAudioData(new Uint8Array(100).buffer);
      await ctx.close();
      const off = new OfflineAudioContext(1, 1600, 16000);
      const src = off.createBufferSource();
      const b = off.createBuffer(1, 1600, 48000);
      const d = b.getChannelData(0);
      for (let i = 0; i < 1600; i++) d[i] = Math.sin(i / 20) * 0.5;
      src.buffer = b; src.connect(off.destination); src.start();
      const rendered = await off.startRendering();
      const samples = rendered.getChannelData(0).slice();
      w.postMessage({ type: 'asr:debug-samples', payload: { samples } }, [samples.buffer]);
    });
    return results;
  });
  console.log(JSON.stringify(out, null, 2));
} finally {
  await browser.close();
}
