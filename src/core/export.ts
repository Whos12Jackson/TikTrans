// 导出 / 复制格式
import type { LabelRecord, LineRecord, VideoRecord } from './types';

export type CopyFormat = 'text' | 'text_ts';
export type VideoExportFormat = 'txt' | 'txt_ts' | 'json';

export function fmtTime(ms: number, withMs = false): string {
  const total = Math.max(0, Math.round(ms));
  const h = Math.floor(total / 3600000);
  const m = Math.floor((total % 3600000) / 60000);
  const s = Math.floor((total % 60000) / 1000);
  const msPart = total % 1000;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  const base = h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
  return withMs ? `${base}.${String(msPart).padStart(3, '0')}` : base;
}

export function fmtSrtTime(ms: number): string {
  const total = Math.max(0, Math.round(ms));
  const h = Math.floor(total / 3600000);
  const m = Math.floor((total % 3600000) / 60000);
  const s = Math.floor((total % 60000) / 1000);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(total % 1000).padStart(3, '0')}`;
}

function labelPrefix(label: LabelRecord | undefined): string {
  return label ? `【${label.name}】` : '';
}

/**
 * 规范化的作品链接：优先用作品 ID 拼抖音标准链接
 * （粘贴的可能是短链 v.douyin.com/xxx，统一成 douyin.com/video/<id> 更好追溯）
 */
export function canonicalVideoUrl(video: VideoRecord): string {
  if (video.contentId && /^\d{15,20}$/.test(video.contentId)) {
    return `https://www.douyin.com/video/${video.contentId}`;
  }
  return video.webUrl || '';
}

/**
 * 导出文件顶部的「来源信息」：标题 / 作者 / 链接 / 时长 / 导出时间。
 * 目的：过几个月再看这个 txt，还记得它是从哪条视频来的。
 */
export function sourceHeader(video: VideoRecord): string {
  const url = canonicalVideoUrl(video);
  const rows: string[] = [];
  rows.push(`标题：${video.title || '(无标题)'}`);
  if (video.authorName) rows.push(`作者：${video.authorName}`);
  if (url) rows.push(`来源：${url}`);
  if (video.durationMs > 0) rows.push(`时长：${fmtTime(video.durationMs)}`);
  rows.push(`导出时间：${new Date().toLocaleString('zh-CN')}`);
  return `${rows.join('\n')}\n${'—'.repeat(24)}\n\n`;
}

/** 复制格式（选中行 / 全部行通用） */
export function formatLines(
  lines: LineRecord[],
  format: CopyFormat,
  labels: Map<number, LabelRecord> = new Map(),
): string {
  switch (format) {
    case 'text':
      return lines.map((l) => l.text).join('\n');
    case 'text_ts':
      return lines.map((l) => `[${fmtTime(l.startMs)}] ${l.text}`).join('\n');
  }
}

/** 单条视频导出 */
export function exportVideo(
  video: VideoRecord,
  lines: LineRecord[],
  format: VideoExportFormat,
  labels: Map<number, LabelRecord> = new Map(),
): { filename: string; content: string; mime: string } {
  const safeTitle = (video.title || video.contentId || 'video').replace(/[\\/:*?"<>|]/g, '_').slice(0, 80);
  switch (format) {
    case 'txt':
      // 纯文本：顶部带来源信息，正文不带时间轴
      return {
        filename: `${safeTitle}.txt`,
        content: `${sourceHeader(video)}${formatLines(lines, 'text')}`,
        mime: 'text/plain',
      };
    case 'txt_ts':
      // 带时间轴：顶部同样带来源信息，正文每行前面加 [mm:ss]
      return {
        filename: `${safeTitle}_带时间轴.txt`,
        content: `${sourceHeader(video)}${formatLines(lines, 'text_ts')}`,
        mime: 'text/plain',
      };
    case 'json':
      return {
        filename: `${safeTitle}.json`,
        content: JSON.stringify({ sourceUrl: canonicalVideoUrl(video), video, lines }, null, 2),
        mime: 'application/json',
      };
    default:
      throw new Error(`不支持的导出格式：${format}`);
  }
}

/** 素材库导出（筛选后的行）——按用户要求只保留 CSV */
export function exportLibrary(
  rows: { video: VideoRecord; line: LineRecord }[],
  _format: 'csv' = 'csv',
  labels: Map<number, LabelRecord> = new Map(),
): { filename: string; content: string; mime: string } {
  const esc = (s: string) => `"${(s ?? '').replace(/"/g, '""')}"`;
  const header = '视频标题,作者,原链接,时间,标签,文本';
  const body = rows.map((r) =>
    [
      esc(r.video.title),
      esc(r.video.authorName),
      esc(r.video.webUrl),
      esc(fmtTime(r.line.startMs)),
      esc(labels.get(r.line.labelId ?? -1)?.name ?? ''),
      esc(r.line.text),
    ].join(','),
  );
  // UTF-8 BOM，Excel 不乱码
  return {
    filename: '素材库.csv',
    content: '\ufeff' + [header, ...body].join('\n'),
    mime: 'text/csv',
  };
}

/** 全部数据导出（不含音频），可在另一台机器导入 */
export interface ExportAll {
  version: 1;
  exportedAt: number;
  videos: VideoRecord[];
  lines: LineRecord[];
  labels: LabelRecord[];
}

export function exportAll(
  videos: VideoRecord[],
  lines: LineRecord[],
  labels: LabelRecord[],
): { filename: string; content: string; mime: string } {
  const data: ExportAll = { version: 1, exportedAt: Date.now(), videos, lines, labels };
  return {
    filename: `tiktrans-export-${new Date().toISOString().slice(0, 10)}.json`,
    content: JSON.stringify(data),
    mime: 'application/json',
  };
}

export function parseImportAll(text: string): ExportAll {
  const data = JSON.parse(text) as ExportAll;
  if (!data || data.version !== 1 || !Array.isArray(data.videos)) {
    throw new Error('不是 TikTrans 导出文件（缺少 version/videos）');
  }
  return data;
}
