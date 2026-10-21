// 链接解析：粘贴的链接 → 后台标签页 → 拿作品数据。
// 关键设计：全部状态落库 + chrome.alarms 定时——service worker 被浏览器杀掉也能继续
// （内存里的 setTimeout/promise 等待会被 SW 生命周期杀死，这是老版"永远停在等待验证"的根因）。
import type { ExtractedLink } from '../core/links';
import { parseAweFromUrl } from '../core/links';
import { db } from '../core/db';
import type { AwemeData, VideoRecord } from '../core/types';
import { enqueueByAweme, enqueueWaiting, fillWaitingRecord, onAweResolved, retryVideo, updateWaiting } from './queue';
import { getCache, setOnResolved } from './aweme_cache';

// 作品数据到达时（任意时刻、任意 SW 生命周期）→ 按库里的占位记录认领
setOnResolved((data, tabId) => {
  void onAweResolved(data, tabId);
});

const ALARM_FIRST = (id: number) => `tiktrans-resolve-${id}`;
const ALARM_SECOND = (id: number) => `tiktrans-resolve2-${id}`;

chrome.alarms.onAlarm.addListener((alarm) => {
  void handleAlarm(alarm.name);
});

async function handleAlarm(name: string): Promise<void> {
  const m1 = /^tiktrans-resolve-(\d+)$/.exec(name);
  const m2 = /^tiktrans-resolve2-(\d+)$/.exec(name);
  const videoId = Number((m1 ?? m2)?.[1] ?? NaN);
  if (!Number.isFinite(videoId)) return;

  const v = await db.videos.get(videoId);
  if (!v || v.state !== 'waiting-user') return; // 已拿到数据/已处理，忽略

  // 先主动拉取：直接问页面脚本要数据（不再依赖页面主动上报那条链路）
  if (await pullFromTab(v)) return;

  if (m1) {
    // 第一轮（约 30 秒）：页面切前台让用户看到现状，继续等第二轮
    try {
      if (v.tabId != null) {
        const tab = await chrome.tabs.get(v.tabId);
        await chrome.tabs.update(v.tabId, { active: true });
        if (tab.windowId != null) await chrome.windows.update(tab.windowId, { focused: true });
      }
    } catch { /* 标签页可能已被用户关掉 */ }
    await updateWaiting(videoId, `页面已打开但还没取到数据，正在自动重试…（${lastPullDetail}；页面上有验证码/登录框请顺手处理）`);
    chrome.alarms.create(ALARM_SECOND(videoId), { delayInMinutes: 2 });
    return;
  }

  // 第二轮：再拉一次仍无果才失败（带诊断信息）
  let tabUrl = '';
  try { if (v.tabId != null) tabUrl = (await chrome.tabs.get(v.tabId)).url ?? ''; } catch { /* 已关 */ }
  await db.videos.update(videoId, {
    state: 'failed',
    errorCode: 'timeout',
    errorMessage: `没取到作品数据（标签页停在：${tabUrl || '未知'}；${lastPullDetail}）。点「重试」会重新开页并自动拉取；仍不行请导出诊断报告。`,
    updatedAt: Date.now(),
  });
  console.warn('[tiktrans] 解析超时', { videoId, tabUrl, lastPullDetail });
}

let lastPullDetail = '';

/** 主动向标签页里的页面脚本拉取数据；脚本没响应时自动刷新一次标签页自愈 */
async function pullFromTab(v: VideoRecord): Promise<boolean> {
  const { ok, detail } = await pullOnce(v);
  lastPullDetail = detail;
  if (ok) return true;
  if (detail.includes('无响应') && !v.note?.includes('已自动刷新')) {
    await db.videos.update(v.id!, { note: '已自动刷新标签页重试', updatedAt: Date.now() });
    try { await chrome.tabs.reload(v.tabId!); console.log('[tiktrans] 页面脚本无响应，已自动刷新标签页', v.tabId); } catch { /* 已关 */ }
  }
  return false;
}

async function pullOnce(v: VideoRecord): Promise<{ ok: boolean; detail: string }> {
  if (v.tabId == null) return { ok: false, detail: '无标签页' };
  try {
    const resp: any = await chrome.tabs.sendMessage(v.tabId, { type: 'capture:request' });
    const list: AwemeData[] = Array.isArray(resp?.awemes) ? resp.awemes : [];
    if (!list.length) {
      return { ok: false, detail: `页面脚本在运行但没抓到作品数据（页面：${String(resp?.pageUrl ?? '').slice(0, 50)}）` };
    }
    const byId = list.find((a) => a.contentId
      && (v.contentId === a.contentId || v.webUrl.includes(a.contentId) || v.sourceText.includes(a.contentId)));
    const pageParsed = parseAweFromUrl(String(resp?.pageUrl ?? ''));
    const byPage = pageParsed ? list.find((a) => a.contentId === pageParsed.contentId) : undefined;
    const hit = byId ?? byPage ?? (list.length === 1 ? list[0] : undefined);
    if (!hit) {
      return { ok: false, detail: `页面有 ${list.length} 条作品但对不上（IDs：${list.map((a) => a.contentId).join(',')}）` };
    }
    await fillWaitingRecord(v.id!, hit);
    try { if (v.tabId != null) await chrome.tabs.remove(v.tabId); } catch { /* 已关 */ }
    console.log('[tiktrans] 主动拉取成功', { videoId: v.id, contentId: hit.contentId });
    return { ok: true, detail: 'ok' };
  } catch (e: any) {
    return { ok: false, detail: `页面脚本无响应（${String(e?.message ?? e).slice(0, 60)}）` };
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 一批链接串条处理：能直接拿到 contentId 的先查库去重；其余开后台标签页解析（立即返回，靠认领+闹钟收尾） */
export async function ingestLinks(links: ExtractedLink[], sourceText: string, tags: string[]): Promise<void> {
  for (const link of links) {
    try {
      if (link.contentId) {
        const cached = getCache(link.contentId);
        if (cached) {
          await enqueueByAweme(cached, sourceText, tags);
          continue;
        }
        const existing = await db.videos
          .where('[platform+contentId]').equals(['douyin', link.contentId]).first();
        if (existing) {
          // 已存在：失败/跳过的复活重跑；等待中/进行中的不动
          if (existing.state === 'failed' || existing.state === 'skipped') await retryVideo(existing.id!);
          continue;
        }
      }
      await startTabResolve(link.url, link.contentId, sourceText, tags);
    } catch (e) {
      console.warn('[tiktrans] 解析链接失败', link.url, e);
    }
    // 两条链接之间随机间隔 2 到 5 秒
    await sleep(2000 + Math.random() * 3000);
  }
}

async function startTabResolve(url: string, contentId: string, sourceText: string, tags: string[]): Promise<void> {
  // 占位记录先落库（拿到 videoId），再开标签页并把 tabId 记进去，最后导航——
  // 数据无论何时到达，都能按 contentId 或 tabId 认领到这条记录
  const videoId = await enqueueWaiting(sourceText, url, tags);
  const tab = await chrome.tabs.create({ url, active: false });
  await db.videos.update(videoId, { tabId: tab.id, updatedAt: Date.now() });
  chrome.alarms.create(ALARM_FIRST(videoId), { when: Date.now() + 10_000 }); // 10 秒后主动拉取
  console.log('[tiktrans] 后台标签页解析开始', { videoId, tabId: tab.id, url });
}

/** 重试一条「没解析出数据」的占位记录：重新开页解析（前台，方便用户处理验证） */
export async function retryViaTab(videoId: number): Promise<void> {
  const v = await db.videos.get(videoId);
  if (!v) return;
  await db.videos.update(videoId, {
    state: 'waiting-user',
    errorCode: '',
    errorMessage: '正在重新打开抖音页面读取作品数据…',
    updatedAt: Date.now(),
  });
  const tab = await chrome.tabs.create({ url: v.webUrl, active: true });
  await db.videos.update(videoId, { tabId: tab.id, updatedAt: Date.now() });
  chrome.alarms.create(ALARM_FIRST(videoId), { when: Date.now() + 10_000 });
  console.log('[tiktrans] 重试解析', { videoId, tabId: tab.id, url: v.webUrl });
}
