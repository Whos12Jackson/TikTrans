// 后台 service worker：消息路由、任务调度、入口（图标/右键菜单/侧边栏）
import { db, ensureDefaultLabels } from '../core/db';
import type { AnyMsg } from '../core/messages';
import { extractLinks } from '../core/links';
import { parseAweme, harvestAwemes } from '../core/aweme';
import type { AwemeData } from '../core/types';
import { enqueueByAweme, pump, deleteVideo, retryVideo } from './queue';
import { ensureRefererRule } from './download';
import { ingestLinks, retryViaTab } from './resolve';
import { warmUpOffscreen } from './offscreen_client';
import { cacheAweme, getCache } from './aweme_cache';
import { getSettings } from '../core/settings';

// ---------- 作品缓存（页面钩子送来的）→ 见 aweme_cache.ts ----------

// ---------- 消息路由 ----------
chrome.runtime.onMessage.addListener((msg: AnyMsg, sender, sendResponse) => {
  void handle(msg, sender).then((r) => sendResponse(r)).catch((e) => sendResponse({ error: String(e) }));
  return true; // 异步响应
});

async function handle(msg: AnyMsg, sender: chrome.runtime.MessageSender): Promise<unknown> {
  switch (msg?.type) {
    case 'aweme:seen': {
      const list = harvestAwemes(msg.payload.aweme as Record<string, any>);
      console.log('[tiktrans] 后台收到作品数据', list.map((a) => a.aweme_id));
      for (const raw of list) {
        const data = parseAweme(raw);
        if (data) cacheAweme(data, msg.payload.mediaUrls ?? [], sender.tab?.id);
      }
      return { ok: true };
    }
    case 'extract:current': {
      console.log('[tiktrans] 收到提取请求', msg.payload.awemeId);
      let data = getCache(msg.payload.awemeId);
      if (!data && msg.payload.videoSrc) {
        // 兜底：作品 JSON 没抓到，直接用页面正在播放的视频地址
        data = {
          contentId: msg.payload.awemeId,
          desc: msg.payload.title || '',
          create_time: 0,
          authorNickname: '',
          authorSecUid: '',
          durationMs: 0,
          coverUrl: '',
          hashtags: [],
          isImagePost: false,
          webUrl: `https://www.douyin.com/video/${msg.payload.awemeId}`,
          audioUrls: [],
          videoUrls: [msg.payload.videoSrc],
        };
        cacheAweme(data, [msg.payload.videoSrc]);
      }
      if (!data) return { error: '页面数据还没到，请刷新页面后再点一次' };
      await enqueueByAweme(data, '', []);
      // 打开侧边栏（需要用户手势，被浏览器拒绝时提示用户点工具栏图标）
      let panelOk = true;
      try {
        await chrome.sidePanel.open({ windowId: (await chrome.windows.getCurrent()).id! });
      } catch {
        panelOk = false;
      }
      return { ok: true, panelOk };
    }
    case 'ingest:text': {
      const links = extractLinks(msg.payload.text);
      if (links.length === 0) return { error: '没认出链接或作品 ID' };
      // 立即回包；解析在后台继续（每条短链可能要几十秒，期间靠 job:changed 广播进度）
      void ingestLinks(links, msg.payload.text, msg.payload.tags ?? []);
      return { ok: true, count: links.length };
    }
    case 'video:action': {
      const { action, videoId } = msg.payload;
      if (action === 'delete') await deleteVideo(videoId);
      else {
        // 没解析出数据 / 下载失败（地址过期）的记录：重试=重新开页取新数据；其余=重跑管线
        const v = await db.videos.get(videoId);
        if (v && v.webUrl && (!v.contentId || v.stage === 'download')) await retryViaTab(videoId);
        else await retryVideo(videoId);
      }
      return { ok: true };
    }
    case 'selftest': {
      await warmUpOffscreen();
      const r = await chrome.runtime.sendMessage({ type: 'offscreen:selftest' });
      return r ?? { ok: false, detail: '离屏文档没有响应' };
    }
    case 'asr:progress': {
      // 转发给界面
      chrome.runtime.sendMessage({ type: 'job:changed', payload: {
        videoId: msg.payload.videoId, stage: 'transcribe', state: 'running',
        progress: msg.payload.secondsTotal ? msg.payload.secondsDone / msg.payload.secondsTotal : 0,
      }}).catch(() => {});
      return { ok: true };
    }
    case 'asr:download-progress': {
      // 下载音频的进度（长视频文件大，界面要能看到在动）
      chrome.runtime.sendMessage({ type: 'job:changed', payload: {
        videoId: msg.payload.videoId, stage: 'download', state: 'running',
        progress: msg.payload.total ? msg.payload.loaded / msg.payload.total : 0,
        detail: `${(msg.payload.loaded / 1048576).toFixed(1)} / ${(msg.payload.total / 1048576).toFixed(1)} MB`,
      }}).catch(() => {});
      return { ok: true };
    }
    case 'player:time': {
      // 转发给界面（侧边栏/全屏页监听高亮）
      chrome.runtime.sendMessage(msg).catch(() => {});
      return { ok: true };
    }
    case 'diag:release': {
      // 诊断用：强制释放引擎内存
      const { releaseOffscreen } = await import('./offscreen_client');
      await releaseOffscreen();
      const alive = chrome.offscreen.hasDocument ? await chrome.offscreen.hasDocument() : false;
      return { ok: true, alive };
    }
    case 'diag:cache': {
      // 诊断：分别看后台 / 离屏文档 / 页面看到的 Cache Storage
      const bg = await caches.keys();
      const bgOut: Record<string, string[]> = {};
      for (const n of bg) bgOut[n] = (await (await caches.open(n)).keys()).map((r) => r.url);
      let doc: unknown = null;
      try {
        await warmUpOffscreen();
        doc = await chrome.runtime.sendMessage({ type: 'diag:cache-inner' });
      } catch (e) { doc = { error: String(e) }; }
      return { ok: true, 后台: bgOut, 离屏文档: doc };
    }
    case 'asr:model-bytes': {
      // 离屏文档/Worker 读不到 Cache Storage 里的模型时，由后台代取
      const { readModelFile } = await import('../core/models');
      const bytes = await readModelFile(msg.payload.key);
      return { ok: !!bytes, bytes: bytes ?? undefined };
    }
    default:
      return { ok: false, error: 'unknown message' };
  }
}

// ---------- 入口 ----------
// 防盗链：常驻 Referer 会话规则（对整个扩展生效，离屏文档下载候选地址也因此不 403）
void ensureRefererRule().catch((e) => console.warn('[tiktrans] Referer 规则建立失败', e));

chrome.runtime.onInstalled.addListener(() => {
  void ensureDefaultLabels();
  void ensureRefererRule().catch(() => {});
  // removeAll 后重建，避免扩展更新时 duplicate id 报错
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'tiktrans-extract-link',
      title: '提取口播',
      contexts: ['link'],
      documentUrlPatterns: ['https://*.douyin.com/*', 'https://*.iesdouyin.com/*'],
    });
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'tiktrans-extract-link' && info.linkUrl) {
    void ingestLinks(extractLinks(info.linkUrl), info.linkUrl, []);
  }
});

// 点工具栏图标打开侧边栏
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

// service worker 被唤醒/启动：把上次被杀时留在 running 的任务重置回 queued，继续处理
async function recoverAndPump(): Promise<void> {
  const stuck = await db.videos.where('state').equals('running').toArray();
  if (stuck.length) {
    await db.videos.where('state').equals('running').modify({ state: 'queued', updatedAt: Date.now() });
    console.log('[tiktrans] 恢复被中断的任务', stuck.map((v) => v.id));
  }
  void pump();
}

chrome.runtime.onStartup.addListener(() => {
  void recoverAndPump();
});
void recoverAndPump();

// ---------- 音频清理（设置里的「音频保留天数」）----------
const CLEANUP_ALARM = 'tiktrans-cleanup-audio';

/** 删除超过保留期的音频文件（只删 media 表，不动转写结果） */
async function cleanupOldAudio(): Promise<void> {
  const settings = await getSettings();
  const days = settings.audioKeepDays;
  if (days <= 0) return; // 0 = 转写完就删（队列里已经处理）
  const cutoff = Date.now() - days * 86400_000;
  const all = await db.media.toArray();
  let n = 0;
  for (const m of all) {
    if ((m.savedAt ?? 0) < cutoff) { await db.media.delete(m.videoId); n++; }
  }
  if (n) console.log('[tiktrans] 清理过期音频', n, '条');
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === CLEANUP_ALARM) void cleanupOldAudio();
});
// 每天清理一次（浏览器启动时也检查一次）
chrome.alarms.create(CLEANUP_ALARM, { periodInMinutes: 60 * 24, delayInMinutes: 5 });
void cleanupOldAudio();
