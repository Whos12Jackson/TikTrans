// 移植性测试：把离线包解压到「另一个路径」，用全新 profile 装上，验证即插即用
// 步骤：
//   1) 解压离线包到临时目录（模拟"拷到别的设备/别的路径"）
//   2) 检查包内没有绝对路径依赖、模型文件齐全
//   3) 用全新 profile 加载该目录
//   4) 验证：识别到自带模型、引导页跳过、引擎自检通过、扩展 ID 与路径无关
import puppeteer from 'puppeteer-core';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const version = process.argv[2] ?? '0.1.34';
const zip = path.join(root, `TikTrans-mvp-v${version}-离线版.zip`);
const target = path.join(root, '.portable-test', 'TikTrans-随便放个位置');

console.log('=== 1) 解压到另一个路径 ===');
fs.rmSync(path.join(root, '.portable-test'), { recursive: true, force: true });
fs.mkdirSync(target, { recursive: true });
execSync(`powershell -Command "Expand-Archive -Path '${zip}' -DestinationPath '${target}' -Force"`, { stdio: 'inherit' });

const must = [
  'manifest.json', 'background/index.js', 'offscreen/offscreen.html', 'offscreen/asr-worker.js',
  'engine/sherpa-onnx-wasm-main-vad-asr.wasm', 'model/sense-voice.onnx', 'model/tokens.txt', 'model/silero_vad.onnx',
  'sidepanel.html', 'app.html', 'icons/icon128.png',
];
console.log('=== 2) 包内容检查 ===');
let ok = true;
for (const f of must) {
  const p = path.join(target, f);
  const exists = fs.existsSync(p);
  if (!exists) ok = false;
  const size = exists ? fs.statSync(p).size : 0;
  console.log(`  ${exists ? '✅' : '❌'} ${f}${exists ? `（${(size / 1048576).toFixed(1)}MB）` : ' 缺失'}`);
}
// 检查有没有指向开发机的绝对路径
let absHits = [];
for (const f of ['manifest.json', 'background/index.js', 'offscreen/index.js', 'offscreen/asr-worker.js']) {
  const p = path.join(target, f);
  if (!fs.existsSync(p)) continue;
  const txt = fs.readFileSync(p, 'utf-8');
  const m = txt.match(/[A-Za-z]:[\\/][^"'\s]{4,}/g) || [];
  const dev = m.filter((x) => /WorkSpace|TikTrans|node_modules|\.smoke/i.test(x));
  if (dev.length) absHits.push(`${f}: ${dev.slice(0, 3).join(', ')}`);
}
console.log(`  ${absHits.length === 0 ? '✅' : '❌'} 没有指向开发机的绝对路径${absHits.length ? '：' + absHits.join(' | ') : ''}`);
if (absHits.length) ok = false;

console.log('=== 3) 全新 profile 加载（模拟新设备）===');
const profile = path.join(root, '.portable-test', 'profile');
const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  headless: false, userDataDir: profile,
  args: [`--disable-extensions-except=${target}`, `--load-extension=${target}`, '--no-first-run'],
  protocolTimeout: 600000,
});
await new Promise((r) => setTimeout(r, 5000));
const sw = browser.targets().find((t) => t.type() === 'service_worker' && t.url().includes('chrome-extension://'));
if (!sw) { console.log('❌ 扩展没有加载起来'); process.exit(1); }
const extId = new URL(sw.url()).hostname;
console.log(`  ✅ 扩展已加载，ID = ${extId}`);

const page = await browser.newPage();
await page.goto(`chrome-extension://${extId}/app.html`, { waitUntil: 'domcontentloaded', timeout: 120000 });
await new Promise((r) => setTimeout(r, 3000));

const checks = await page.evaluate(async () => {
  const out = {};
  out.引导页 = document.body.innerText.includes('下载语音模型（约 230 MB，一次性）') ? '还在' : '已跳过';
  out.模型数 = await new Promise((res) => {
    const rq = indexedDB.open('tiktrans');
    rq.onsuccess = () => {
      try {
        const tx = rq.result.transaction('models', 'readonly');
        const r2 = tx.objectStore('models').getAll();
        r2.onsuccess = () => res(r2.result.length);
      } catch { res(0); }
    };
  });
  out.自带可读 = await (async () => {
    try { const r = await fetch(chrome.runtime.getURL('model/sense-voice.onnx')); return r.ok; } catch { return false; }
  })();
  return out;
});
console.log('=== 4) 即插即用检查 ===');
console.log(`  ${checks.引导页 === '已跳过' ? '✅' : '❌'} 首次引导页：${checks.引导页}`);
console.log(`  ${checks.模型数 === 0 ? '✅' : 'ℹ '} IndexedDB 模型数：${checks.模型数}（0 = 确实没下载）`);
console.log(`  ${checks.自带可读 ? '✅' : '❌'} 自带模型文件可读取`);

const t0 = Date.now();
const selftest = await page.evaluate(async () => {
  try { return await chrome.runtime.sendMessage({ type: 'selftest' }); }
  catch (e) { return { ok: false, detail: String(e) }; }
});
console.log(`  ${selftest?.ok ? '✅' : '❌'} 引擎自检（${Math.round((Date.now() - t0) / 1000)}s）：${selftest?.detail ?? ''}`);

// 再确认一次：ID 与路径无关（用原来的 dist 路径加载，ID 应该一样）
await browser.close();
const browser2 = await puppeteer.launch({
  executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  headless: false, userDataDir: path.join(root, '.portable-test', 'profile2'),
  args: [`--disable-extensions-except=${path.join(root, 'dist')}`, `--load-extension=${path.join(root, 'dist')}`, '--no-first-run'],
});
await new Promise((r) => setTimeout(r, 5000));
const sw2 = browser2.targets().find((t) => t.type() === 'service_worker' && t.url().includes('chrome-extension://'));
const id2 = sw2 ? new URL(sw2.url()).hostname : '(没起来)';
console.log(`=== 5) 扩展 ID 与安装路径无关 ===`);
console.log(`  ${extId === id2 ? '✅' : '❌'} 另一个路径下的 ID = ${id2}（应与 ${extId} 相同）`);
await browser2.close();

console.log(`\n${ok && checks.引导页 === '已跳过' && selftest?.ok && extId === id2 ? '✅ 移植性测试全部通过' : '❌ 有项目未通过'}`);
