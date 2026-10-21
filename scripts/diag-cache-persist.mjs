// 实验：模型缓存在「扩展重新加载 / 版本升级」后还在不在
import puppeteer from 'puppeteer-core';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(root, 'dist');
const PROFILE = path.join(root, '.edge-profile');

async function checkCache(label) {
  const browser = await puppeteer.launch({
    executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    headless: false, userDataDir: PROFILE,
    args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`, '--no-first-run'],
  });
  await new Promise((r) => setTimeout(r, 3000));
  const sw = browser.targets().find((t) => t.type() === 'service_worker' && t.url().includes('chrome-extension://'));
  const extId = new URL(sw.url()).hostname;
  const page = await browser.newPage();
  await page.goto(`chrome-extension://${extId}/app.html`, { waitUntil: 'networkidle0' });
  const state = await page.evaluate(async () => {
    const names = await caches.keys();
    const out = {};
    for (const n of names) out[n] = (await (await caches.open(n)).keys()).map((r) => r.url.replace('https://tiktrans.local/', ''));
    return out;
  });
  console.log(`${label}：${JSON.stringify(state)}`);

  // 顺便把模型下下来（如果缺）
  const has = Object.values(state).some((k) => k.includes('model'));
  if (!has && process.argv.includes('--download')) {
    console.log('  → 模型缺失，开始下载（约 228MB）…');
    await page.evaluate(() => {
      Array.from(document.querySelectorAll('button')).find((b) => b.textContent.trim() === '设置')?.click();
    });
    await new Promise((r) => setTimeout(r, 500));
    await page.evaluate(() => {
      Array.from(document.querySelectorAll('button')).find((b) => b.textContent.includes('下载模型'))?.click();
    });
    for (let i = 0; i < 120; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      const done = await page.evaluate(async () => {
        const c = await caches.open('tiktrans-models-v2');
        return (await c.keys()).length;
      });
      if (done >= 3) { console.log('  → 下载完成'); break; }
    }
    const after = await page.evaluate(async () => {
      const c = await caches.open('tiktrans-models-v2');
      return (await c.keys()).map((r) => r.url.replace('https://tiktrans.local/', ''));
    });
    console.log(`  下载后缓存：${JSON.stringify(after)}`);
  }
  await browser.close();
}

await checkCache('步骤1 启动后');

// 模拟「升级」：改 manifest 版本号
const mf = path.join(DIST, 'manifest.json');
const raw = readFileSync(mf, 'utf-8');
const ver = (raw.match(/"version":\s*"([^"]+)"/) ?? [])[1] ?? '0.0.0';
const [maj, min, pat] = ver.split('.').map(Number);
writeFileSync(mf, raw.replace(`"version": "${ver}"`, `"version": "${maj}.${min}.${pat + 1}"`), 'utf-8');
console.log(`步骤2 已把 manifest 版本改成 ${maj}.${min}.${pat + 1}（模拟扩展升级）`);

await checkCache('步骤3 升级后重新启动');
