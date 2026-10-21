// 逐个测试视频记录里的候选媒体地址：HTTP 状态 / 类型 / 大小 / 能否解码成音频
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

  const urls = await page.evaluate(async () => {
    const openDb = () => new Promise((res) => { const rq = indexedDB.open('tiktrans'); rq.onsuccess = () => res(rq.result); rq.onerror = () => res(null); });
    const db = await openDb();
    const videos = await new Promise((res) => {
      const tx = db.transaction('videos', 'readonly');
      const rq = tx.objectStore('videos').getAll();
      rq.onsuccess = () => res(rq.result || []); rq.onerror = () => res([]);
    });
    return videos.flatMap((v) => v.mediaUrls || []);
  });
  console.log(`候选地址 ${urls.length} 条：`);

  const results = await page.evaluate(async (list) => {
    const out = [];
    for (const u of list) {
      const item = { url: u.slice(0, 150) };
      try {
        const resp = await fetch(u, { credentials: 'include' });
        item.status = resp.status;
        item.type = resp.headers.get('content-type');
        item.len = resp.headers.get('content-length');
        if (!resp.ok) { out.push(item); continue; }
        const buf = await resp.arrayBuffer();
        item.bytes = buf.byteLength;
        const head = Array.from(new Uint8Array(buf.slice(0, 12))).map((c) => String.fromCharCode(c)).join('').replace(/[^\x20-\x7e]/g, '.');
        item.head = head;
        try {
          const ctx = new AudioContext();
          const ab = await ctx.decodeAudioData(buf.slice(0));
          await ctx.close();
          let peak = 0;
          for (let c = 0; c < ab.numberOfChannels; c++) {
            const d = ab.getChannelData(c);
            for (let i = 0; i < d.length; i += 11) peak = Math.max(peak, Math.abs(d[i]));
          }
          item.decoded = true; item.durationSec = +ab.duration.toFixed(2);
          item.channels = ab.numberOfChannels; item.sampleRate = ab.sampleRate; item.peak = +peak.toFixed(4);
        } catch (e) { item.decoded = false; item.decodeError = String(e.message || e).slice(0, 60); }
      } catch (e) { item.fetchError = String(e.message || e).slice(0, 80); }
      out.push(item);
    }
    return out;
  }, urls);
  console.log(JSON.stringify(results, null, 2));
} finally {
  await browser.close();
}
