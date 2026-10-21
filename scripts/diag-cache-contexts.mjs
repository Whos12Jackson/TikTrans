// 查清：模型缓存在「页面 / 后台 / 离屏文档 / Worker」四个上下文里分别能不能看到，
// 以及浏览器重启后还在不在。
import puppeteer from 'puppeteer-core';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(root, 'dist');
const PROFILE = path.join(root, '.edge-profile');

async function launch() {
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
  return { browser, page, extId };
}

async function pageCache(page) {
  return page.evaluate(async () => {
    const names = await caches.keys();
    const out = {};
    for (const n of names) out[n] = (await (await caches.open(n)).keys()).map((r) => r.url.replace('https://tiktrans.local/', ''));
    return out;
  });
}

async function downloadModel(page) {
  await page.evaluate(() => {
    Array.from(document.querySelectorAll('button')).find((b) => b.textContent.trim() === '设置')?.click();
  });
  await new Promise((r) => setTimeout(r, 500));
  await page.evaluate(() => {
    Array.from(document.querySelectorAll('button')).find((b) => b.textContent.includes('下载模型'))?.click();
  });
  for (let i = 0; i < 240; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const c = await pageCache(page);
    const n = Object.values(c).flat().length;
    if (n >= 3) return true;
  }
  return false;
}

// ---------- 第 1 轮：新会话 ----------
{
  const { browser, page } = await launch();
  console.log('【第1轮 新会话】页面缓存：', JSON.stringify(await pageCache(page)));
  if (Object.values(await pageCache(page)).flat().length < 3) {
    console.log('  下载模型…', await downloadModel(page));
    console.log('  下载后页面缓存：', JSON.stringify(await pageCache(page)));
  }
  // 触发 Worker 里的引擎初始化（会打印 Worker 看到的缓存）
  const logs = [];
  const sw = browser.targets().find((t) => t.type() === 'service_worker' && t.url().includes('chrome-extension://'));
  const cdp = await sw.createCDPSession();
  await cdp.send('Runtime.enable');
  cdp.on('Runtime.consoleAPICalled', (ev) => {
    const txt = (ev.args ?? []).map((a) => a.value ?? a.description ?? '').join(' ');
    if (txt.includes('缓存') || txt.includes('引擎初始化') || txt.includes('模型')) logs.push(txt.slice(0, 160));
  });
  browser.on('targetcreated', async (t) => {
    try {
      const c2 = await t.createCDPSession();
      await c2.send('Runtime.enable');
      c2.on('Runtime.consoleAPICalled', (ev) => {
        const txt = (ev.args ?? []).map((a) => a.value ?? a.description ?? '').join(' ');
        if (txt.includes('缓存') || txt.includes('引擎初始化') || txt.includes('模型')) logs.push(txt.slice(0, 160));
      });
    } catch { /* 忽略 */ }
  });
  await page.evaluate(() => chrome.runtime.sendMessage({ type: 'selftest' }).catch(() => null));
  await new Promise((r) => setTimeout(r, 8000));
  console.log('  Worker/后台日志：');
  for (const l of logs.slice(0, 8)) console.log('    ' + l);
  await browser.close();
}

// ---------- 第 2 轮：重启后 ----------
{
  const { browser, page } = await launch();
  console.log('\n【第2轮 重启浏览器后】页面缓存：', JSON.stringify(await pageCache(page)));
  const logs = [];
  const sw = browser.targets().find((t) => t.type() === 'service_worker' && t.url().includes('chrome-extension://'));
  const cdp = await sw.createCDPSession();
  await cdp.send('Runtime.enable');
  cdp.on('Runtime.consoleAPICalled', (ev) => {
    const txt = (ev.args ?? []).map((a) => a.value ?? a.description ?? '').join(' ');
    if (txt.includes('缓存') || txt.includes('引擎初始化') || txt.includes('模型')) logs.push(txt.slice(0, 160));
  });
  browser.on('targetcreated', async (t) => {
    try {
      const c2 = await t.createCDPSession();
      await c2.send('Runtime.enable');
      c2.on('Runtime.consoleAPICalled', (ev) => {
        const txt = (ev.args ?? []).map((a) => a.value ?? a.description ?? '').join(' ');
        if (txt.includes('缓存') || txt.includes('引擎初始化') || txt.includes('模型')) logs.push(txt.slice(0, 160));
      });
    } catch { /* 忽略 */ }
  });
  await page.evaluate(() => chrome.runtime.sendMessage({ type: 'selftest' }).catch(() => null));
  await new Promise((r) => setTimeout(r, 8000));
  console.log('  Worker/后台日志：');
  for (const l of logs.slice(0, 8)) console.log('    ' + l);
  await browser.close();
}
