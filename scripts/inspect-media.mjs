// 检查已下载音频：读 IndexedDB 的 media 表 → 解码 → 统计峰值/RMS/时长
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

  const info = await page.evaluate(async () => {
    const openDb = () => new Promise((res, rej) => {
      const rq = indexedDB.open('tiktrans');
      rq.onsuccess = () => res(rq.result);
      rq.onerror = () => rej(rq.error);
    });
    const db = await openDb();
    const all = (store) => new Promise((res) => {
      try {
        const tx = db.transaction(store, 'readonly');
        const rq = tx.objectStore(store).getAll();
        rq.onsuccess = () => res(rq.result || []);
        rq.onerror = () => res([]);
      } catch { res([]); }
    });
    const media = await all('media');
    const out = [];
    for (const m of media) {
      const blob = m.blob;
      const item = { videoId: m.videoId, size: blob?.size ?? 0, type: blob?.type ?? '?', };
      if (!blob) { out.push(item); continue; }
      const buf = await blob.arrayBuffer();
      const head = Array.from(new Uint8Array(buf.slice(0, 12)))
        .map((c) => String.fromCharCode(c)).join('');
      item.head = head.replace(/[^\x20-\x7e]/g, '.');
      try {
        const ctx = new AudioContext();
        const ab = await ctx.decodeAudioData(buf.slice(0));
        await ctx.close();
        let peak = 0, sum = 0, n = 0;
        for (let c = 0; c < ab.numberOfChannels; c++) {
          const d = ab.getChannelData(c);
          for (let i = 0; i < d.length; i += 7) { const a = Math.abs(d[i]); if (a > peak) peak = a; sum += d[i] * d[i]; n++; }
        }
        item.channels = ab.numberOfChannels;
        item.sampleRate = ab.sampleRate;
        item.durationSec = +ab.duration.toFixed(2);
        item.peak = +peak.toFixed(5);
        item.rms = +Math.sqrt(sum / Math.max(1, n)).toFixed(5);
        item.silent = peak < 0.001;
      } catch (e) {
        item.decodeError = String(e.message || e);
      }
      out.push(item);
    }
    return out;
  });
  console.log(JSON.stringify(info, null, 2));
} finally {
  await browser.close();
}
