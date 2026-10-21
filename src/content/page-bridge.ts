// 页面脚本（隔离 world）——按用户决定精简：
// 1) 转发页面钩子抓到的作品数据给后台（粘贴链接解析用）
// 2) 响应后台的主动拉取 capture:request（解析的可靠通道）
// 3) 播放联动：点时间戳跳转、进度回传（高亮当前行）
// 页面上的「提取口播」按钮已裁剪：只保留粘贴链接入口，认领更准确、少一半出错面。
import { harvestAwemes, parseAweme } from '../core/aweme';
import { parseAweFromUrl } from '../core/links';
import type { AwemeData } from '../core/types';

const TAG = 'tiktrans-hook';
const log = (...args: unknown[]) => console.log('[tiktrans]', ...args);

const aweById = new Map<string, AwemeData>();
let mediaUrls: string[] = [];   // 播放器请求过的媒体地址（作兜底素材）
let lastSeenAt = 0;             // 最近一次收到作品数据的时间（诊断用）

window.addEventListener('message', (ev) => {
  const data = ev.data;
  if (!data || data.source !== TAG) return;
  if (data.type === 'aweme:seen') {
    for (const raw of harvestAwemes(data.payload as Record<string, any>)) {
      const parsed = parseAweme(raw);
      if (!parsed) continue;
      lastSeenAt = Date.now();
      log('抓到作品数据', parsed.contentId);
      aweById.set(parsed.contentId, parsed);
      chrome.runtime.sendMessage({
        type: 'aweme:seen',
        payload: { aweme: raw, mediaUrls },
      }).catch(() => {});
    }
  } else if (data.type === 'media:url') {
    const url = String(data.payload);
    if (/^https?:/i.test(url) && !mediaUrls.includes(url)) {
      mediaUrls = [url, ...mediaUrls].slice(0, 50);
    }
  }
});

// ---------- 后台应答 / 播放联动 ----------
chrome.runtime.onMessage.addListener((msg: any, _sender, sendResponse) => {
  if (msg?.type === 'capture:request') {
    // 后台主动来要数据（解析的主要通道）：交出本页缓存的全部作品
    sendResponse({ ok: true, pageUrl: location.href, lastSeenAt, awemes: [...aweById.values()] });
    // 交完数据就把页面的视频停掉并释放解码缓冲：
    // 抖音页面在后台标签页里会一直播，1080p 视频的解码缓冲几百 MB，
    // 标签页关掉后渲染进程还留着这块内存（实测每解析一条视频 Edge 多占 ~500MB 且不回落）。
    try {
      for (const v of Array.from(document.querySelectorAll('video'))) {
        v.pause();
        v.removeAttribute('src');
        // 置空 source 后 load() 会释放已解码的帧
        v.load();
      }
    } catch { /* 忽略 */ }
    return;
  }
  if (msg?.type === 'player:seek') {
    // 只在能确认身份的作品页联动（URL 里有作品 ID）
    const parsed = parseAweFromUrl(location.href);
    if (parsed && parsed.contentId === msg.payload.awemeId) {
      const video = document.querySelector('video') as HTMLVideoElement | null;
      if (video) {
        video.currentTime = msg.payload.ms / 1000;
        void video.play();
      }
    }
    return;
  }
});

// 播放进度 → 界面（高亮当前行）
setInterval(() => {
  const parsed = parseAweFromUrl(location.href);
  const video = document.querySelector('video') as HTMLVideoElement | null;
  if (!parsed || !video) return;
  chrome.runtime.sendMessage({
    type: 'player:time',
    payload: { awemeId: parsed.contentId, ms: video.currentTime * 1000, playing: !video.paused },
  }).catch(() => {});
}, 250);
