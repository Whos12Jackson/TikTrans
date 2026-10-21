// Dexie 表定义 + 默认标签
import Dexie, { type Table } from 'dexie';
import type {
  AsrResultRecord, EditRecord, LabelRecord, LineRecord, MediaRecord, ModelChunkRecord, ModelFileRecord, VideoRecord,
} from './types';

export class TikTransDB extends Dexie {
  videos!: Table<VideoRecord, number>;
  lines!: Table<LineRecord, number>;
  labels!: Table<LabelRecord, number>;
  edits!: Table<EditRecord, number>;
  media!: Table<MediaRecord, number>;
  asrResults!: Table<AsrResultRecord, number>;
  /** 语音模型文件（存 IndexedDB 而不是 Cache Storage） */
  models!: Table<ModelFileRecord, string>;
  /** 模型下载中的分块（断点续传用） */
  modelChunks!: Table<ModelChunkRecord, [string, number]>;

  constructor(name = 'tiktrans') {
    super(name);
    this.version(1).stores({
      videos: '++id, &[platform+contentId], state, createdAt, *tags',
      lines: '++id, videoId, [videoId+idx], labelId',
      labels: '++id, &name, sort',
      edits: '++id, videoId, at',
      media: 'videoId',
      asrResults: 'videoId',
    });
    // v2：[platform+contentId] 改为非唯一——占位记录 contentId 为空串，
    // 唯一索引会导致「同时只允许一条占位」，第二条静默丢失（去重仍按查询做）
    this.version(2).stores({
      videos: '++id, [platform+contentId], state, createdAt, *tags',
    });
    // v3：新增 models 表（模型 228MB 放 Cache Storage 会读不出来/重启后丢失，改存 IndexedDB）
    this.version(3).stores({
      videos: '++id, [platform+contentId], state, createdAt, *tags',
      lines: '++id, videoId, [videoId+idx], labelId',
      labels: '++id, &name, sort',
      edits: '++id, videoId, at',
      media: 'videoId',
      asrResults: 'videoId',
      models: 'key',
      modelChunks: '[name+index], name',
    });
  }
}

export const db = new TikTransDB();

/** 默认结构标签（首次启动写入） */
export const DEFAULT_LABELS: Omit<LabelRecord, 'id'>[] = [
  { name: '钩子', color: '#e5484d', hotkey: 1, definition: '开头用来抓注意力的句子：抛问题、反常识结论、制造悬念或直接点出好处', sort: 0, archived: false },
  { name: '痛点', color: '#f76b15', hotkey: 2, definition: '描述目标观众遇到的问题、焦虑或不满', sort: 1, archived: false },
  { name: '观点', color: '#3b82f6', hotkey: 3, definition: '作者给出的判断、主张或结论', sort: 2, archived: false },
  { name: '论据', color: '#06b6d4', hotkey: 4, definition: '支撑观点的事实、数据、案例、故事或亲身经历', sort: 3, archived: false },
  { name: '方法', color: '#22c55e', hotkey: 5, definition: '可以照着做的步骤、技巧或建议', sort: 4, archived: false },
  { name: '金句', color: '#a855f7', hotkey: 6, definition: '简短有力、能单独摘出来引用的句子', sort: 5, archived: false },
  { name: '转折', color: '#eab308', hotkey: 7, definition: '话锋一转、引出下一部分的过渡句', sort: 6, archived: false },
  { name: '行动号召', color: '#ec4899', hotkey: 8, definition: '引导点赞、关注、评论、私信、购买或点链接', sort: 7, archived: false },
];

/** 首次启动写入默认标签（幂等） */
export async function ensureDefaultLabels(): Promise<void> {
  const n = await db.labels.count();
  if (n === 0) await db.labels.bulkAdd(DEFAULT_LABELS as LabelRecord[]);
}
