// 任务队列与阶段调度：capture → download → decode → transcribe → segment → llm → ready
// 串行处理（同一时间 1 条：满足「转写 1 条 / 下载 ≤2 / 标签页 ≤1」的并发上限）
import { db, ensureDefaultLabels } from '../core/db';
import { parseAweme } from '../core/aweme';
import { segmentsToLines, DEFAULT_SEGMENT_OPTIONS } from '../core/segment';
import { applyLexicon, mineLexicon, parseLexicon } from '../core/lexicon';
import { getSettings } from '../core/settings';
import type { AsrSegment, AwemeData, VideoRecord, VideoStage, VideoState } from '../core/types';
import { ensureRefererRule } from './download';
import { requestTranscribe } from './offscreen_client';
import { getCache } from './aweme_cache';

const STAGE_ORDER: VideoStage[] = ['capture', 'download', 'decode', 'transcribe', 'segment', 'llm', 'ready'];

function broadcast(videoId: number, stage: VideoStage, state: VideoState, progress = 0, errorMessage = '') {
  chrome.runtime.sendMessage({
    type: 'job:changed',
    payload: { videoId, stage, state, progress, errorMessage },
  }).catch(() => {});
}

/** 入库（去重后）并排队 */
export async function enqueueByAweme(data: AwemeData, sourceText: string, tags: string[]): Promise<number | null> {
  await ensureDefaultLabels();
  const existing = await db.videos.where('[platform+contentId]').equals(['douyin', data.contentId]).first();
  if (existing) {
    // 已存在：失败/跳过/等待中的记录用最新数据复活重跑（用户最常见的恢复动作就是重点一遍）；
    // 正常处理中/已完成的才静默跳到旧记录
    const stale = existing.state === 'failed' || existing.state === 'skipped'
      || existing.state === 'waiting-user' || (existing.mediaUrls ?? []).length === 0;
    if (stale) {
      await db.videos.update(existing.id!, {
        title: data.desc || existing.title,
        description: data.desc || existing.description,
        mediaUrls: [...data.audioUrls, ...data.videoUrls],
        stage: 'capture',
        state: 'queued',
        errorCode: '',
        errorMessage: '',
        updatedAt: Date.now(),
      });
      console.log('[tiktrans] 复活已有记录', existing.id);
      void pump();
    }
    return existing.id ?? null;
  }

  const now = Date.now();
  const rec: VideoRecord = {
    platform: 'douyin',
    contentId: data.contentId,
    sourceText,
    webUrl: data.webUrl,
    title: data.desc || '',
    description: data.desc || '',
    platformTags: data.hashtags,
    authorName: data.authorNickname,
    authorSecUid: data.authorSecUid,
    durationMs: data.durationMs,
    coverUrl: data.coverUrl,
    publishedAt: data.create_time ? data.create_time * 1000 : 0,
    stage: 'capture',
    state: 'queued',
    errorCode: '',
    errorMessage: '',
    attempts: 0,
    lineMode: (await getSettings()).lineMode,
    asrEngine: 'sensevoice-int8',
    llmStatus: '',
    note: '',
    tags,
    mediaUrls: [...data.audioUrls, ...data.videoUrls],
    createdAt: now,
    updatedAt: now,
  };
  const id = await db.videos.add(rec);
  console.log('[tiktrans] 入队', { id, contentId: data.contentId, title: (data.desc || '').slice(0, 20) });
  broadcast(id as number, 'capture', 'queued');
  void pump();
  return id as number;
}

/** 短链等还没有 contentId 时，先占位（解析到数据后按 contentId/tabId 认领补全） */
export async function enqueueWaiting(sourceText: string, url: string, tags: string[], tabId?: number): Promise<number> {
  const now = Date.now();
  const id = await db.videos.add({
    platform: 'douyin', contentId: '', sourceText, webUrl: url,
    title: '', description: '', platformTags: [], authorName: '', authorSecUid: '',
    durationMs: 0, coverUrl: '', publishedAt: 0,
    stage: 'capture', state: 'waiting-user', errorCode: '', errorMessage: '正在打开抖音页面读取作品数据…',
    attempts: 0, lineMode: 'sentence', asrEngine: 'sensevoice-int8', llmStatus: '', note: '',
    tags, tabId, createdAt: now, updatedAt: now,
  } as VideoRecord);
  return id as number;
}

/** 解析到作品数据后补全指定占位记录并排队（resolve 流程精确回填） */
export async function fillWaitingRecord(videoId: number, data: AwemeData): Promise<void> {
  const dup = await db.videos.where('[platform+contentId]').equals(['douyin', data.contentId]).first();
  if (dup && dup.id !== videoId) {
    // 这条作品已有正式记录：删占位，走复活逻辑
    await db.videos.delete(videoId);
    await enqueueByAweme(data, '', []);
    return;
  }
  await db.videos.update(videoId, {
    contentId: data.contentId,
    webUrl: data.webUrl,
    title: data.desc || '',
    description: data.desc || '',
    platformTags: data.hashtags,
    authorName: data.authorNickname,
    authorSecUid: data.authorSecUid,
    durationMs: data.durationMs,
    coverUrl: data.coverUrl,
    publishedAt: data.create_time ? data.create_time * 1000 : 0,
    mediaUrls: [...data.audioUrls, ...data.videoUrls],
    stage: 'capture',
    state: 'queued',
    errorCode: '',
    errorMessage: '',
    updatedAt: Date.now(),
  });
  console.log('[tiktrans] 占位记录已补全', { videoId, contentId: data.contentId });
  void pump(); // 关键：不泵队列的话记录会永远停在排队中
}

/** 作品数据到达时认领等待记录：URL/粘贴文本含该作品 ID，或数据来自该占位记录的标签页 */
export async function onAweResolved(data: AwemeData, tabId?: number): Promise<void> {
  const waiting = await db.videos.where('state').equals('waiting-user').toArray();
  for (const w of waiting) {
    const byId = (w.webUrl && w.webUrl.includes(data.contentId))
      || (w.sourceText && w.sourceText.includes(data.contentId));
    const byTab = tabId != null && w.tabId === tabId;
    if (!(byId || byTab)) continue;
    await fillWaitingRecord(w.id!, data);
    return;
  }
}

/** 更新等待中占位记录的提示文案（resolve 流程里给用户看进度） */
export async function updateWaiting(videoId: number, message: string): Promise<void> {
  await db.videos.update(videoId, { errorMessage: message, updatedAt: Date.now() });
  const v = await db.videos.get(videoId);
  if (v) broadcast(videoId, v.stage, v.state, 0, message);
}

let pumping = false;

export async function pump(): Promise<void> {
  if (pumping) return;
  pumping = true;
  try {
    for (;;) {
      const next = await db.videos.where('state').equals('queued').first();
      if (!next || !next.id) break;
      await processVideo(next);
    }
  } finally {
    pumping = false;
  }
}

async function fail(id: number, stage: VideoStage, errorCode: string, errorMessage: string): Promise<void> {
  console.warn('[tiktrans] 任务失败', { id, stage, errorCode, errorMessage });
  await db.videos.update(id, {
    stage, state: 'failed', errorCode, errorMessage, updatedAt: Date.now(),
  });
  broadcast(id, stage, 'failed', 0, errorMessage);
}

async function processVideo(v: VideoRecord): Promise<void> {
  const id = v.id!;
  const settings = await getSettings();

  // 图文作品：无口播
  const data = await ensureCaptureData(v);
  if (!data) {
    await fail(id, 'capture', 'no-data',
      '没拿到这条作品的数据。若是页面提取：请先刷新抖音页面再点「提取口播」；若是粘贴链接：请看打开的抖音标签页是否停在验证/登录页，处理好后点「重试」。');
    return;
  }
  if (data.isImagePost) {
    await db.videos.update(id, { state: 'skipped', errorMessage: '图文没有口播', updatedAt: Date.now() });
    broadcast(id, 'capture', 'skipped', 0, '图文没有口播');
    return;
  }

  try {
    // ---- download ----
    // 下载 + 解码 + 验声由离屏文档一体完成（只有它能解码、发现「200 但静音」的文件并自动换地址），
    // 这里只把候选地址交给它，并确保防盗链 Referer 规则已生效。
    await db.videos.update(id, { state: 'running', stage: 'download', attempts: v.attempts + 1, updatedAt: Date.now() });
    broadcast(id, 'download', 'running');
    const urls = [...data.audioUrls, ...data.videoUrls];
    if (urls.length === 0) throw new Error('这条作品没有可下载的媒体地址');
    await ensureRefererRule();
    await db.videos.update(id, { mediaUrls: urls, updatedAt: Date.now() });

    // ---- decode + transcribe（离屏文档里跑）----
    if (settings.maxDurationMin > 0 && v.durationMs > settings.maxDurationMin * 60_000) {
      await fail(id, 'transcribe', 'too-long',
        `时长 ${Math.round(v.durationMs / 60000)} 分钟，超过 ${settings.maxDurationMin} 分钟上限（设置里可改）。`
        + '注意：浏览器内解码长视频很吃内存，超过 30 分钟建议分段处理。');
      return;
    }
    await db.videos.update(id, { stage: 'decode', state: 'running', updatedAt: Date.now() });
    broadcast(id, 'decode', 'running');
    const { segments, stats } = await requestTranscribe(id);
    await db.videos.update(id, { stage: 'transcribe', state: 'running', updatedAt: Date.now() });
    await db.asrResults.put({ videoId: id, engine: 'sensevoice-int8', result: segments });
    // 诊断：把识别段数/长度写进备注，空结果时能一眼看出是转写还是成行出的问题
    const segCount = segments.length;
    const totalText = segments.reduce((a, s) => a + (s.text || '').length, 0);
    console.log('[tiktrans] 转写结果', { videoId: id, segCount, totalText, durationMs: v.durationMs, stats });

    // ---- 易错词表纠正（同音字：模型层面改不动，只能后处理）----
    // 用户词表 + 从改字记录里自动学到的词表（同一处改过 2 次以上就认定为规律）
    const manualPairs = parseLexicon(settings.lexicon ?? '');
    const learnedPairs = mineLexicon(await db.edits.toArray());
    const pairs = [...learnedPairs, ...manualPairs];
    if (pairs.length) {
      let fixed = 0;
      for (const s of segments) {
        const before = s.text;
        const after = applyLexicon(before, pairs);
        if (after !== before) { s.text = after; fixed++; }
      }
      console.log('[tiktrans] 词表纠正', { videoId: id, 手动词条: manualPairs.length, 自动学到: learnedPairs.length, 命中段数: fixed });
    }

    // ---- segment ----
    await db.videos.update(id, { stage: 'segment', state: 'running', updatedAt: Date.now() });
    broadcast(id, 'segment', 'running');
    const opts = {
      ...DEFAULT_SEGMENT_OPTIONS,
      lineMode: settings.lineMode,
      maxLineChars: settings.maxLineChars,
      pauseBreakMs: settings.pauseBreakMs,
      maxLineSec: settings.maxLineSec,
    };
    const rawLines = segmentsToLines(segments, opts);
    await db.lines.where('videoId').equals(id).delete();
    await db.lines.bulkAdd(rawLines.map((l, i) => ({ ...l, videoId: id, idx: i, updatedAt: Date.now() })));
    console.log('[tiktrans] 成行结果', { videoId: id, rawLines: rawLines.length });

    if (segments.length === 0) {
      // 一个字也没识别出来：直接进 ready，不建行
      await db.videos.update(id, {
        stage: 'ready', state: 'done', updatedAt: Date.now(),
        note: `诊断：转写0段（音频 ${(v.durationMs / 1000).toFixed(1)}s，可能是引擎/模型/音频问题）`,
      });
      broadcast(id, 'ready', 'done', 1, '未识别到人声');
      return;
    }
    if (rawLines.length === 0) {
      await db.videos.update(id, {
        stage: 'ready', state: 'done', updatedAt: Date.now(),
        note: `诊断：转写${segCount}段${totalText}字，但成行0条（成行规则问题）`,
      });
    }

    // ---- llm（一期没配置就跳过）----
    await db.videos.update(id, { stage: 'llm', state: 'running', updatedAt: Date.now() });
    if (!settings.llmBaseUrl || !settings.llmKey || !settings.llmModel) {
      await db.videos.update(id, { llmStatus: 'skipped', updatedAt: Date.now() });
    }

    // ---- ready ----
    const statTxt = stats ? ` | 引擎：初始化${stats.initCount}次 wasm ${stats.wasmMB}MB` : '';
    await db.videos.update(id, {
      stage: 'ready', state: 'done', updatedAt: Date.now(),
      note: `完成于 ${new Date().toLocaleTimeString('zh-CN')}${statTxt}`,
    });
    broadcast(id, 'ready', 'done', 1);
  } catch (e: any) {
    const stage = (await db.videos.get(id))?.stage ?? 'download';
    await fail(id, stage, 'error', String(e?.message ?? e));
  } finally {
    // 音频保留策略：0 表示转写完就删
    const s = await getSettings();
    if (s.audioKeepDays === 0) await db.media.delete(id);
    // 注意：这里【不要】销毁离屏文档。实测每销毁一次，下次转写就新建一套引擎（模型+arena 约 500MB），
    // 而旧渲染进程的内存浏览器不会还给系统——连转 3 条视频内存从 1.0GB 涨到 2.1GB。
    // 保留引擎反而是"内存不涨"的方案（见交付说明）。
    void pump(); // 继续下一条
  }
}

/** capture 数据：优先内存缓存；占位记录解析到 contentId 后重建 */
async function ensureCaptureData(v: VideoRecord): Promise<AwemeData | null> {
  if (v.contentId) {
    const cached = getCache(v.contentId);
    if (cached) return cached;
    // 内存缓存没有（SW 重启过）：从库里已存字段兜底
    if (v.title || v.durationMs || (v.mediaUrls && v.mediaUrls.length)) {
      return {
        contentId: v.contentId, desc: v.description, create_time: v.publishedAt / 1000,
        authorNickname: v.authorName, authorSecUid: v.authorSecUid, durationMs: v.durationMs,
        coverUrl: v.coverUrl, hashtags: v.platformTags, isImagePost: false, webUrl: v.webUrl,
        audioUrls: v.mediaUrls ?? [], videoUrls: [],
      };
    }
    return null;
  }
  return null;
}

export async function retryVideo(videoId: number): Promise<void> {
  await db.videos.update(videoId, { state: 'queued', errorMessage: '', updatedAt: Date.now() });
  void pump();
}

export async function deleteVideo(videoId: number): Promise<void> {
  await db.transaction('rw', db.videos, db.lines, db.edits, db.media, db.asrResults, async () => {
    await db.lines.where('videoId').equals(videoId).delete();
    await db.edits.where('videoId').equals(videoId).delete();
    await db.media.delete(videoId);
    await db.asrResults.delete(videoId);
    await db.videos.delete(videoId);
  });
}
