// 扩展内部消息定义（chrome.runtime.sendMessage / tabs.sendMessage）
import type { AsrSegment, VideoStage, VideoState } from './types';

export interface AwemeSeenMsg {
  type: 'aweme:seen';
  payload: {
    aweme: unknown;          // 作品 JSON 原文（后台再 parse）
    mediaUrls: string[];     // 页面播放器请求过的媒体地址
  };
}

export interface ExtractCurrentMsg {
  type: 'extract:current';
  payload: {
    awemeId: string;
    pageUrl: string;
    /** 兜底：JSON 抓不到时用页面播放器的地址 */
    videoSrc?: string;
    title?: string;
  };
}

export interface IngestTextMsg {
  type: 'ingest:text';
  payload: { text: string; tags: string[] };
}

export interface JobChangedMsg {
  type: 'job:changed';
  payload: {
    videoId: number;
    stage: VideoStage;
    state: VideoState;
    progress: number;        // 0..1，transcribe 阶段用
    errorMessage?: string;
  };
}

export interface AsrRunMsg {
  type: 'asr:run';
  payload: { videoId: number };
}

export interface AsrProgressMsg {
  type: 'asr:progress';
  payload: { videoId: number; secondsDone: number; secondsTotal: number };
}

/** 离屏文档 → 后台：下载音频的进度（长视频文件大，界面要能看到在动） */
export interface AsrDownloadProgressMsg {
  type: 'asr:download-progress';
  payload: { videoId: number; loaded: number; total: number };
}

export interface PlayerSeekMsg {
  type: 'player:seek';
  payload: { awemeId: string; ms: number };
}

export interface PlayerTimeMsg {
  type: 'player:time';
  payload: { awemeId: string; ms: number; playing: boolean };
}

/** 界面 → 后台：给某条视频补数据/重试等 */
export interface VideoActionMsg {
  type: 'video:action';
  payload: { action: 'retry' | 'delete' | 'resync'; videoId: number };
}

/** 界面 → 后台：引擎自检 */
export interface SelfTestMsg {
  type: 'selftest';
  payload?: Record<string, never>;
}

/** 界面 → 后台：诊断用，强制释放引擎内存 */
export interface DiagReleaseMsg {
  type: 'diag:release';
  payload?: Record<string, never>;
}

/** 诊断：对比各上下文看到的 Cache Storage */
export interface DiagCacheMsg {
  type: 'diag:cache';
  payload?: Record<string, never>;
}

/** 离屏文档 → 后台：代取模型字节（Worker 读不到缓存时） */
export interface AsrModelBytesMsg {
  type: 'asr:model-bytes';
  payload: { key: 'model' | 'tokens' | 'vad' };
}

export type AnyMsg =
  | AwemeSeenMsg
  | ExtractCurrentMsg
  | IngestTextMsg
  | JobChangedMsg
  | AsrRunMsg
  | AsrProgressMsg
  | AsrDownloadProgressMsg
  | PlayerSeekMsg
  | PlayerTimeMsg
  | VideoActionMsg
  | SelfTestMsg
  | DiagReleaseMsg
  | DiagCacheMsg
  | AsrModelBytesMsg;

/** 后台 → 界面广播 job:changed */
export function jobChanged(payload: JobChangedMsg['payload']): JobChangedMsg {
  return { type: 'job:changed', payload };
}
