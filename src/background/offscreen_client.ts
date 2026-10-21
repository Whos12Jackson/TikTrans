// 离屏文档客户端：确保离屏文档存在，发转写请求，等结果
import type { AsrSegment } from '../core/types';

const OFFSCREEN_URL = 'offscreen/offscreen.html';
const OFFSCREEN_REASONS = ['WORKERS', 'AUDIO_PLAYBACK'] as unknown as chrome.offscreen.Reason[];
const OFFSCREEN_JUSTIFICATION = '解码音频并在 Worker 里跑 VAD + SenseVoice 语音识别';

async function hasOffscreen(): Promise<boolean> {
  if (chrome.offscreen.hasDocument) return chrome.offscreen.hasDocument();
  // 老版本兜底
  const clients = await (self as any).clients?.matchAll?.({ includeUncontrolled: true }) ?? [];
  return clients.some((c: any) => c.url?.includes(OFFSCREEN_URL));
}

/**
 * 本次 service worker 生命周期内是否已经建过离屏文档。
 * 重要：每次转写都调 createDocument 的话，某些 Chrome/Edge 版本会把旧文档关掉再新建，
 * 于是「新建离屏文档 → 新建识别 Worker → 重新分配一套引擎内存（约 500MB）」，
 * 而旧渲染进程的内存浏览器不会还给系统——实测连转 3 条视频内存从 0.9GB 涨到 1.8GB。
 * 所以：建过就不再建。
 */
let offscreenCreated = false;

async function ensureOffscreen(): Promise<void> {
  if (offscreenCreated) return;
  if (await hasOffscreen()) { offscreenCreated = true; return; }
  try {
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_URL,
      reasons: OFFSCREEN_REASONS,
      justification: OFFSCREEN_JUSTIFICATION,
    });
  } catch (e: any) {
    if (!String(e?.message ?? e).includes('Only a single offscreen')) throw e;
  }
  offscreenCreated = true;
}

interface PendingJob {
  resolve: (s: AsrSegment[], stats: any) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}
const pending = new Map<number, PendingJob>();

// 离屏文档回的结果
chrome.runtime.onMessage.addListener((msg: any) => {
  if (msg?.type === 'offscreen:transcribe-result') {
    const p = pending.get(msg.payload.videoId);
    if (!p) return;
    clearTimeout(p.timer);
    pending.delete(msg.payload.videoId);
    if (msg.payload.error) p.reject(new Error(msg.payload.error));
    else p.resolve(msg.payload.segments as AsrSegment[], (msg.payload.stats as any) ?? null);
  }
});

/** 请求转写：音频已落库（media 表），这里只发任务号，等识别结果 */
export async function requestTranscribe(videoId: number): Promise<{ segments: AsrSegment[]; stats: any }> {
  await ensureOffscreen();
  console.log('[tiktrans] 请求转写时 hasDocument =', await hasOffscreen());

  return new Promise<{ segments: AsrSegment[]; stats: any }>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(videoId);
      reject(new Error('转写超时（10 分钟），请重试'));
    }, 10 * 60_000);
    pending.set(videoId, {
      resolve: (segs, stats) => resolve({ segments: segs, stats }),
      reject, timer,
    });

    chrome.runtime.sendMessage({
      type: 'offscreen:transcribe',
      payload: { videoId },
    }).catch((e) => {
      clearTimeout(timer);
      pending.delete(videoId);
      reject(new Error(`离屏文档通信失败：${e}`));
    });
  });
}

/** 手动拉起离屏文档（设置页/引导页预热用） */
export async function warmUpOffscreen(): Promise<void> {
  await ensureOffscreen();
}

/**
 * 销毁离屏文档，释放引擎内存。
 * wasm 的线性内存只能增长不能收缩：模型权重(228MB) + onnxruntime 的 arena 一旦加载就常驻，
 * 转写完不销毁的话这几百 MB 会一直占着（实测转写一条 3 分钟视频后常驻 +591MB 不回落）。
 * 销毁后下次转写需要重新加载模型（约 2 秒）。
 */
export async function releaseOffscreen(): Promise<void> {
  try {
    const alive = await hasOffscreen();
    console.log('[tiktrans] 释放引擎内存：hasDocument =', alive);
    if (alive) {
      await chrome.offscreen.closeDocument();
      console.log('[tiktrans] 引擎内存已释放，hasDocument =', await hasOffscreen());
    }
  } catch (e: any) {
    console.warn('[tiktrans] 释放离屏文档失败', String(e?.message ?? e));
  }
}
