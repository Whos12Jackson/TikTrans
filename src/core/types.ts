// 全局类型定义（与数据模型章节一致）

export type Platform = 'douyin';

export type VideoStage = 'capture' | 'download' | 'decode' | 'transcribe' | 'segment' | 'llm' | 'ready';
export type VideoState = 'queued' | 'running' | 'failed' | 'done' | 'skipped' | 'waiting-user';
export type LineMode = 'sentence' | 'clause';
export type LabelSource = 'ai' | 'user';

export interface VideoRecord {
  id?: number;
  platform: Platform;
  contentId: string;            // aweme_id，解析完成前为空串
  sourceText: string;           // 用户贴进来的原文
  webUrl: string;
  title: string;
  description: string;
  platformTags: string[];       // 抖音话题
  authorName: string;
  authorSecUid: string;
  durationMs: number;
  coverUrl: string;
  publishedAt: number;          // epoch ms，未知为 0
  stage: VideoStage;
  state: VideoState;
  errorCode: string;
  errorMessage: string;
  attempts: number;
  lineMode: LineMode;
  asrEngine: string;
  llmStatus: '' | 'ok' | 'failed' | 'skipped';
  note: string;
  tags: string[];               // 视频标签（自由文本）
  /** 媒体地址（不入索引）：后台重启后重试仍能下载 */
  mediaUrls?: string[];
  /** 粘贴解析用的后台标签页 id（不入索引）：数据到达时按它认领占位记录 */
  tabId?: number;
  createdAt: number;
  updatedAt: number;
}

export interface LineRecord {
  id?: number;
  videoId: number;
  idx: number;                  // 视频内顺序，从 0 起
  startMs: number;
  endMs: number;
  textAsr: string;
  textAi: string;
  text: string;
  edited: boolean;
  tokens: TokenTuple[] | null;  // [[词元, startMs, endMs], ...]
  labelId: number | null;
  labelSource: LabelSource | null;
  updatedAt: number;
}

export type TokenTuple = [string, number, number];

export interface LabelRecord {
  id?: number;
  name: string;
  color: string;
  hotkey: number;               // 1..9
  definition: string;
  sort: number;
  archived: boolean;
}

export type EditKind = 'text' | 'label' | 'split' | 'merge' | 'delete' | 'revert';

export interface EditRecord {
  id?: number;
  videoId: number;
  lineId: number | null;
  kind: EditKind;
  before: LineRecord[];         // 受影响行在操作前的完整快照
  after: number[];              // 操作后的行 id
  /** 改字类操作里「被替换的片段」：oldText 是识别出来的错词，newText 是用户改成的正词 */
  oldText?: string;
  newText?: string;
  at: number;
}

export interface MediaRecord {
  videoId: number;  blob: Blob;
  mime: string;
  size: number;
  savedAt: number;
}

/**
 * 语音模型文件（存 IndexedDB）。
 * 为什么不用 Cache Storage：228MB 的大文件放进去后，其他上下文（Worker/离屏文档）读不到，
 * 浏览器重启后连页面也读不到（实测），会报「模型文件缺失」。
 */
export interface ModelFileRecord {
  key: 'model' | 'tokens' | 'vad';
  blob: Blob;
  size: number;
  savedAt: number;
}

/** 模型下载中的分块（断点续传） */
export interface ModelChunkRecord {
  name: string;
  index: number;
  blob: Blob;
  size: number;
  savedAt: number;
}

export interface AsrResultRecord {
  videoId: number;
  engine: string;
  result: AsrSegment[];         // 按段保存的文本和带时间的词元
}

/** 一个语音段的识别结果（绝对时间，毫秒） */
export interface AsrSegment {
  startMs: number;
  endMs: number;
  text: string;
  tokens: TokenTuple[];
}

/** 挖到的作品数据（capture 阶段产物） */
export interface AwemeData {
  contentId: string;
  desc: string;
  create_time: number;
  authorNickname: string;
  authorSecUid: string;
  durationMs: number;
  coverUrl: string;
  hashtags: string[];
  isImagePost: boolean;
  webUrl: string;
  audioUrls: string[];          // 按优先级排好的媒体地址（纯音频优先）
  videoUrls: string[];
}
