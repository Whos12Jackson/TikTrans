// 把真实抖音音频解码成 16k 单声道 WAV 存到 node_modules/.smoke/real16k.wav
// 用途：在 Node 里快速迭代断句规则与识别参数（不必每次都开浏览器）
import puppeteer from 'puppeteer-core';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EDGE_PATH = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const EXT_PATH = path.join(root, 'dist');
const PROFILE = path.join(root, '.edge-profile');
const OUT = path.join(root, 'node_modules', '.smoke', 'real16k.wav');

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

  const b64 = await page.evaluate(async () => {
    const openDb = () => new Promise((res) => { const rq = indexedDB.open('tiktrans'); rq.onsuccess = () => res(rq.result); rq.onerror = () => res(null); });
    const db = await openDb();
    const videos = await new Promise((res) => {
      const tx = db.transaction('videos', 'readonly');
      const rq = tx.objectStore('videos').getAll();
      rq.onsuccess = () => res(rq.result || []); rq.onerror = () => res([]);
    });
    const all = videos.flatMap((v) => v.mediaUrls || []);
    const score = (u) => (/\/play\/dash\//.test(u) ? -100 : 0) + (/weba/.test(u) ? 30 : 0) + (/\/aweme\/v1\/play\/\?/.test(u) ? 40 : 0);
    const cands = all.filter((u) => /^https?:/.test(u)).sort((a, b) => score(b) - score(a));
    for (const u of cands.slice(0, 6)) {
      try {
        const resp = await fetch(u, { credentials: 'include' });
        if (!resp.ok) continue;
        const buf = await resp.arrayBuffer();
        const ctx = new AudioContext();
        const ab = await ctx.decodeAudioData(buf.slice(0));
        await ctx.close();
        const srcLen = ab.length;
        const mono = new Float32Array(srcLen);
        for (let c = 0; c < ab.numberOfChannels; c++) {
          const d = ab.getChannelData(c);
          for (let i = 0; i < srcLen; i++) mono[i] += d[i] / ab.numberOfChannels;
        }
        const dstLen = Math.ceil((mono.length * 16000) / ab.sampleRate);
        const off = new OfflineAudioContext(1, dstLen, 16000);
        const src = off.createBufferSource();
        const b = off.createBuffer(1, mono.length, ab.sampleRate);
        b.getChannelData(0).set(mono);
        src.buffer = b; src.connect(off.destination); src.start();
        const rendered = await off.startRendering();
        const samples = rendered.getChannelData(0);
        // 编码 WAV（16bit PCM）
        const bytes = new Uint8Array(44 + samples.length * 2);
        const dv = new DataView(bytes.buffer);
        const w = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
        w(0, 'RIFF'); dv.setUint32(4, 36 + samples.length * 2, true); w(8, 'WAVEfmt ');
        dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
        dv.setUint32(24, 16000, true); dv.setUint32(28, 32000, true);
        dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
        w(36, 'data'); dv.setUint32(40, samples.length * 2, true);
        for (let i = 0; i < samples.length; i++) {
          const v = Math.max(-1, Math.min(1, samples[i]));
          dv.setInt16(44 + i * 2, v < 0 ? v * 0x8000 : v * 0x7fff, true);
        }
        const u8 = new Uint8Array(bytes.buffer);
        let bin = '';
        const CH = 8192;
        for (let i = 0; i < u8.length; i += CH) bin += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
        return { b64: btoa(bin), seconds: +(samples.length / 16000).toFixed(2) };
      } catch { /* 试下一个 */ }
    }
    return null;
  });

  if (!b64) throw new Error('没取到音频');
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, Buffer.from(b64.b64, 'base64'));
  console.log(`已保存 ${OUT}（${b64.seconds} 秒）`);
} finally {
  await browser.close();
}
