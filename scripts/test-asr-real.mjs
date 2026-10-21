// 真实抖音音频直连测试：网页内下载 → 解码 → 重采样 → 喂识别 Worker，并打印波形统计
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
  page.on('console', (m) => { const t = m.text(); if (/tiktrans|sherpa/i.test(t)) console.log('  [pg]', t); });
  await page.goto(`chrome-extension://${extId}/app.html`, { waitUntil: 'networkidle0' });
  await new Promise((r) => setTimeout(r, 800));

  const result = await page.evaluate(async () => {
    // 1) 从库里取候选地址
    const openDb = () => new Promise((res) => { const rq = indexedDB.open('tiktrans'); rq.onsuccess = () => res(rq.result); rq.onerror = () => res(null); });
    const db = await openDb();
    const videos = await new Promise((res) => {
      const tx = db.transaction('videos', 'readonly');
      const rq = tx.objectStore('videos').getAll();
      rq.onsuccess = () => res(rq.result || []); rq.onerror = () => res([]);
    });
    const all = videos.flatMap((v) => v.mediaUrls || []);
    const score = (u) => (/\/play\/dash\//.test(u) ? -100 : 0) + (/weba/.test(u) ? 30 : 0) + (/\/aweme\/v1\/play\/\?/.test(u) ? 20 : 0);
    const cands = all.filter((u) => /^https?:/.test(u)).sort((a, b) => score(b) - score(a));

    const stats = (d) => {
      let peak = 0, sum = 0, n = 0, nan = 0;
      for (let i = 0; i < d.length; i += 7) {
        const v = d[i];
        if (!Number.isFinite(v)) { nan++; continue; }
        const a = Math.abs(v); if (a > peak) peak = a; sum += v * v; n++;
      }
      return { peak: +peak.toFixed(4), rms: +Math.sqrt(sum / Math.max(1, n)).toFixed(4), nan, len: d.length };
    };

    const attempts = [];
    for (const u of cands.slice(0, 10)) {
      try {
        const resp = await fetch(u, { credentials: 'include' });
        if (!resp.ok) { attempts.push({ url: u.slice(0, 70), status: resp.status }); continue; }
        const buf = await resp.arrayBuffer();
        const ctx = new AudioContext();
        const ab = await ctx.decodeAudioData(buf.slice(0));
        await ctx.close();
        const st = stats(ab.getChannelData(0));
        attempts.push({ url: u.slice(0, 70), bytes: buf.byteLength, dur: +ab.duration.toFixed(1), ch: ab.numberOfChannels, rate: ab.sampleRate, ...st });
      } catch (e) { attempts.push({ url: u.slice(0, 70), error: String(e.message || e).slice(0, 60) }); }
    }
    return { attempts };
  });
  console.log(JSON.stringify(result, null, 2).slice(0, 4000));
} finally {
  await browser.close();
}
