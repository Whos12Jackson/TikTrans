// Edge 全链路 E2E：粘贴真实抖音链接 → 自动解析 → 下载 → 解码 → 转写 → 分行 → 复制
// 用法：node scripts/test-e2e.mjs [链接文本]
//      环境变量 EXT_PATH=<扩展目录> PROFILE=<profile 目录> 可指定别的扩展/配置（移植测试用）
import puppeteer from 'puppeteer-core';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EDGE_PATH = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const EXT_PATH = process.env.EXT_PATH || path.join(root, 'dist');
const PROFILE = process.env.PROFILE || path.join(root, '.edge-profile');

const LINK = process.argv[2] ?? '5.30 10/21 DUl:/ G@I.vf :0pm 一些胡言乱语，像说给高中的自己 # 学生时代 # 学习 # 少女心事 # 胡说八道文学 # 口播  https://v.douyin.com/aVsReZWbgow/ 复制此链接，打开Dou音搜索，直接观看视频！';

const log = (...a) => console.log(...a);

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

try {
  await new Promise((r) => setTimeout(r, 3000));
  const sw = browser.targets().find((t) => t.type() === 'service_worker' && t.url().includes('chrome-extension://'));
  if (!sw) throw new Error('未找到扩展');
  const extId = new URL(sw.url()).hostname;
  log(`[e2e] 扩展 ID: ${extId}`);
  await browser.defaultBrowserContext().overridePermissions(`chrome-extension://${extId}`, ['clipboard-read', 'clipboard-write']);

  const page = await browser.newPage();
  const consoleLines = [];
  page.on('console', (m) => { const t = m.text(); consoleLines.push(t); if (/tiktrans|wasm|abort|候选/i.test(t)) log(`  [pg] ${t}`); });
  page.on('pageerror', (e) => log(`  [pg-err] ${e.message}`));
  await page.goto(`chrome-extension://${extId}/app.html`, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await new Promise((r) => setTimeout(r, 2000));

  // 挂 CDP 日志（离屏文档 + 识别 Worker 都要看到）
  const attached = new Set();
  const attach = async () => {
    for (const t of browser.targets()) {
      if (attached.has(t._targetId)) continue;
      attached.add(t._targetId);
      try {
        const c = await t.createCDPSession();
        await c.send('Runtime.enable'); await c.send('Log.enable');
        const tag = `${t.type()}:${(t.url().split('/').pop() || '?').slice(0, 24)}`;
        c.on('Runtime.consoleAPICalled', (e) => {
          const text = (e.args ?? []).map((a) => a.value ?? a.description ?? a.type).join(' ');
          if (/tiktrans|wasm|abort|候选|sherpa/i.test(text)) log(`  [${tag}] ${text}`);
        });
        c.on('Log.entryAdded', (e) => {
          if (/tiktrans|wasm|abort|候选|sherpa/i.test(e.entry.text)) log(`  [${tag}] ${e.entry.text}`);
        });
      } catch { /* ignore */ }
    }
  };
  await attach();
  setInterval(() => { void attach(); }, 2000);

  // 清空历史记录（保留模型缓存），并清掉旧设置（让新默认值生效）
  await page.evaluate(async () => {
    await chrome.storage.local.remove(['settings', 'settings-v2']);
    // 预置易错词表：验证词表纠正链路
    await chrome.storage.local.set({
      'settings-v2': { lexicon: '美誉=美玉\n瓦丽=瓦砾\n切懦=怯懦\n真视=珍视\n事快=这块\n疏联=疏离' },
    });
    const openDb = () => new Promise((res) => { const rq = indexedDB.open('tiktrans'); rq.onsuccess = () => res(rq.result); rq.onerror = () => res(null); });
    const db = await openDb();
    for (const s of ['videos', 'lines', 'edits', 'media', 'asrResults']) {
      await new Promise((res) => { try { const tx = db.transaction(s, 'readwrite'); tx.objectStore(s).clear(); tx.oncomplete = () => res(); tx.onerror = () => res(); } catch { res(); } });
    }
  });
  log('[e2e] 已清空历史记录（模型缓存保留）');

  // ---- 模型：没下载就先下载（E2E 脚本自包含）----
  await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('button')).find((x) => x.textContent.trim() === '设置');
    b?.click();
  });
  await new Promise((r) => setTimeout(r, 500));
  const modelState = await page.evaluate(() => {
    const h = Array.from(document.querySelectorAll('.hint')).find((x) => x.textContent.trim().startsWith('模型状态'));
    return h?.textContent?.trim() ?? '未知';
  });
  log(`[e2e] ${modelState}`);
  // 离线包自带模型（不在 IndexedDB 里）→ 不用下载
  const hasBundled = await page.evaluate(async () => {
    try { const r = await fetch(chrome.runtime.getURL('model/sense-voice.onnx')); return r.ok; }
    catch { return false; }
  });
  if (hasBundled) log('[e2e] 检测到扩展自带模型，跳过下载');
  if (modelState.includes('未下载') && !hasBundled) {
    log('[e2e] 下载模型中（226MB）...');
    await page.evaluate(() => {
      Array.from(document.querySelectorAll('button')).find((b) => b.textContent.includes('下载模型'))?.click();
    });
    const dl = await page.evaluate(async () => {
      for (let i = 0; i < 1800; i++) {
        await new Promise((r) => setTimeout(r, 100));
        const t = document.querySelector('.toast')?.textContent || '';
        if (t.includes('完成') || t.includes('失败')) return t.trim();
      }
      return '超时';
    });
    log(`[e2e] 模型下载：${dl}`);
  }
  await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('button')).find((x) => x.textContent.trim() === '视频');
    b?.click();
  });
  await new Promise((r) => setTimeout(r, 500));

  // 填链接 + 点「提取口播」
  log('[e2e] 粘贴链接并提交…');
  await page.evaluate((link) => {
    const ta = document.querySelector('textarea');
    if (!ta) throw new Error('找不到粘贴框');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, link);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  }, LINK);
  await new Promise((r) => setTimeout(r, 300));
  await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('button'))
      .find((b) => ['提取', '提取口播'].includes(b.textContent.trim()));
    if (!btn) {
      const all = Array.from(document.querySelectorAll('button')).map((b) => b.textContent.trim());
      throw new Error('找不到提取按钮，现有按钮：' + all.join(' | '));
    }
    btn.click();
  });
  log('[e2e] 已提交，开始轮询任务状态…');

  // 轮询 IndexedDB
  const readDb = () => page.evaluate(async () => {
    const open = () => new Promise((res, rej) => {
      const req = indexedDB.open('tiktrans');
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });
    const db = await open();
    const all = (store) => new Promise((res) => {
      try {
        const tx = db.transaction(store, 'readonly');
        const rq = tx.objectStore(store).getAll();
        rq.onsuccess = () => res(rq.result || []);
        rq.onerror = () => res([]);
      } catch { res([]); }
    });
    const videos = await all('videos');
    const lines = await all('lines');
    const asr = await all('asrResults');
    return {
      videos: videos.map((v) => ({
        id: v.id, state: v.state, stage: v.stage, title: (v.title || '').slice(0, 30),
        contentId: v.contentId, dur: Math.round((v.durationMs || 0) / 1000),
        err: (v.errorMessage || '').slice(0, 120), note: (v.note || '').slice(0, 80),
      })),
      lineCount: lines.length,
      sampleLines: lines.slice(0, 5).map((l) => `${(l.startMs / 1000).toFixed(1)}s ${l.text}`),
      asrSegs: asr.map((a) => ({ videoId: a.videoId, n: a.result?.length ?? 0, chars: (a.result ?? []).reduce((s, x) => s + (x.text || '').length, 0) })),
    };
  });

  const t0 = Date.now();
  let last = '';
  let done = false;
  while (Date.now() - t0 < 600000) {
    const st = await readDb();
    const v = st.videos[st.videos.length - 1];
    const key = v ? `${v.state}/${v.stage} lines=${st.lineCount} asr=${JSON.stringify(st.asrSegs)}` : '无记录';
    if (key !== last) {
      last = key;
      log(`[e2e ${((Date.now() - t0) / 1000).toFixed(0)}s] ${key} | 标题="${v?.title ?? ''}" | 错误=${v?.err ?? ''} | 备注=${v?.note ?? ''}`);
    }
    if (v && (v.state === 'done' || v.state === 'failed' || v.state === 'skipped') && (st.asrSegs.length || v.err)) { done = true; break; }
    await new Promise((r) => setTimeout(r, 2000));
  }

  const final = await readDb();
  log('\n[e2e] ===== 最终结果 =====');
  log(JSON.stringify(final, null, 2));

  // 导出原始 ASR 分段（含词元时间），用于离线分析断句
  const asrDump = await page.evaluate(async () => {
    const openDb = () => new Promise((res) => { const rq = indexedDB.open('tiktrans'); rq.onsuccess = () => res(rq.result); rq.onerror = () => res(null); });
    const db = await openDb();
    const rows = await new Promise((res) => {
      const tx = db.transaction('asrResults', 'readonly');
      const rq = tx.objectStore('asrResults').getAll();
      rq.onsuccess = () => res(rq.result || []); rq.onerror = () => res([]);
    });
    return rows.map((r) => ({ videoId: r.videoId, result: r.result }));
  });
  fs.writeFileSync(path.join(root, '.asr-dump.json'), JSON.stringify(asrDump, null, 1));
  log(`[e2e] 原始 ASR 分段已存 .asr-dump.json（${asrDump[0]?.result?.length ?? 0} 段）`);

  if (done && final.lineCount > 0) {
    // 先在左侧任务列表里选中这条视频，再验证复制
    await page.evaluate(() => {
      const el = Array.from(document.querySelectorAll('*')).find((e) =>
        e.children.length === 0 && (e.textContent || '').includes('一些胡言乱语'));
      (el?.closest('div') ?? el)?.click();
    });
    await new Promise((r) => setTimeout(r, 1000));
    const copied = await page.evaluate(async () => {
      const btn = Array.from(document.querySelectorAll('button')).find((b) => b.textContent.includes('复制全部'));
      if (!btn) {
        const all = Array.from(document.querySelectorAll('button')).map((b) => b.textContent.trim());
        return { error: '没有复制按钮，现有按钮：' + all.join(' | ') };
      }
      btn.click();
      await new Promise((r) => setTimeout(r, 800));
      const toast = document.querySelector('.toast')?.textContent ?? '';
      let clip = '';
      try { clip = await navigator.clipboard.readText(); } catch (e) { clip = `读取剪贴板失败: ${e.message}`; }
      return { toast, clipLen: clip.length, clip: clip.slice(0, 160) };
    });
    log('\n[e2e] 复制结果: ' + JSON.stringify(copied, null, 2));

    // ---- 导出验证：拦截下载，直接读文件内容 ----
    const dlDir = path.join(root, '.e2e-downloads');
    fs.rmSync(dlDir, { recursive: true, force: true });
    fs.mkdirSync(dlDir, { recursive: true });
    const cdp = await page.createCDPSession();
    await cdp.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: dlDir });

    for (const [label, file] of [['纯文本', '纯文本'], ['带时间轴', '带时间轴']]) {
      await page.evaluate((want) => {
        const btn = Array.from(document.querySelectorAll('button')).find((b) => b.textContent.trim() === want);
        btn?.click();
      }, file);
      await new Promise((r) => setTimeout(r, 2500));
    }
    const files = fs.readdirSync(dlDir).filter((f) => f.endsWith('.txt'));
    log(`\n[e2e] 导出文件：${files.join(' | ') || '（无）'}`);
    for (const f of files) {
      const content = fs.readFileSync(path.join(dlDir, f), 'utf-8');
      const head = content.split('\n').slice(0, 9).join('\n');
      log(`\n[e2e] —— ${f} ——\n${head}\n（总行数 ${content.split('\n').length}）`);
      log(`[e2e] 含来源链接：${/来源：https?:\/\/\S+/.test(content) ? '✅' : '❌'}`);
      log(`[e2e] 链接在正文之前：${content.indexOf('来源：') < content.search(/[^\s【\[（]/m) + 0 ? '✅' : '（检查）'}`);
    }

    log(done ? '\n[e2e] ✅ 全链路通过' : '\n[e2e] ❌ 未完成');
  } else {
    log('\n[e2e] ❌ 全链路未通过（见上方状态）');
  }
} catch (e) {
  console.error('[e2e] 异常:', e);
} finally {
  await browser.close();
}
