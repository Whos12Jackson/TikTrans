import { describe, expect, it } from 'vitest';
import {
  exportAll, exportLibrary, exportVideo, formatLines, fmtSrtTime, fmtTime, parseImportAll,
} from '../src/core/export';
import type { LabelRecord, LineRecord, VideoRecord } from '../src/core/types';

const mkLine = (id: number, idx: number, text: string, startMs: number, endMs: number): LineRecord => ({
  id, videoId: 1, idx, startMs, endMs, textAsr: text, textAi: '', text,
  edited: false, tokens: null, labelId: null, labelSource: null, updatedAt: 0,
});

const video: VideoRecord = {
  id: 1, platform: 'douyin', contentId: '7354181234567890123', sourceText: '',
  webUrl: 'https://www.douyin.com/video/7354181234567890123', title: '测试视频',
  description: '', platformTags: [], authorName: '张三', authorSecUid: '', durationMs: 61000,
  coverUrl: '', publishedAt: 0, stage: 'ready', state: 'done', errorCode: '', errorMessage: '',
  attempts: 1, lineMode: 'sentence', asrEngine: 'sensevoice-int8', llmStatus: '', note: '',
  tags: ['竞品'], createdAt: 0, updatedAt: 0,
};

const lines = [
  mkLine(1, 0, '大家好。', 12_340, 15_020),
  mkLine(2, 1, '今天讲三件事。', 15_020, 20_000),
];

describe('时间格式', () => {
  it('mm:ss / h:mm:ss', () => {
    expect(fmtTime(0)).toBe('00:00');
    expect(fmtTime(12_340)).toBe('00:12');
    expect(fmtTime(61_000)).toBe('01:01');
    expect(fmtTime(3_723_000)).toBe('1:02:03');
  });
  it('SRT 时间格式', () => {
    expect(fmtSrtTime(12_340)).toBe('00:00:12,340');
    expect(fmtSrtTime(3_723_456)).toBe('01:02:03,456');
  });
});

describe('复制格式', () => {
  it('纯文本', () => {
    expect(formatLines(lines, 'text')).toBe('大家好。\n今天讲三件事。');
  });
  it('带时间', () => {
    expect(formatLines(lines, 'text_ts')).toBe('[00:12] 大家好。\n[00:15] 今天讲三件事。');
  });
});

describe('导出', () => {
  it('单条视频 srt 已按要求移除', () => {
    expect(() => exportVideo(video, lines, 'srt' as never)).toThrow();
  });
  it('txt（无时间轴）：顶部带来源信息，正文不带时间戳', () => {
    const f = exportVideo(video, lines, 'txt');
    expect(f.filename).toBe('测试视频.txt');
    // 来源：标题 / 作者 / 链接 / 时长
    expect(f.content).toContain('标题：测试视频');
    expect(f.content).toContain('作者：张三');
    expect(f.content).toContain('来源：https://www.douyin.com/video/7354181234567890123');
    expect(f.content).toContain('时长：01:01');
    // 链接必须在正文之前
    expect(f.content.indexOf('来源：')).toBeLessThan(f.content.indexOf('大家好。'));
    // 正文不带时间戳
    expect(f.content).toContain('大家好。\n今天讲三件事。');
    expect(f.content).not.toContain('[00:12]');
  });
  it('txt_ts（带时间轴）：同样带来源信息，正文每行带时间戳', () => {
    const f = exportVideo(video, lines, 'txt_ts');
    expect(f.filename).toBe('测试视频_带时间轴.txt'); // 与无时间轴的 txt 文件名要区分
    expect(f.filename).not.toBe(exportVideo(video, lines, 'txt').filename);
    expect(f.content).toContain('来源：https://www.douyin.com/video/7354181234567890123');
    expect(f.content).toContain('[00:12] 大家好。');
    expect(f.content.indexOf('来源：')).toBeLessThan(f.content.indexOf('[00:12]'));
  });
  it('短链也会规范成标准作品链接', () => {
    const short = { ...video, contentId: '', webUrl: 'https://v.douyin.com/aVsReZWbgow/' };
    const f = exportVideo(short, lines, 'txt');
    expect(f.content).toContain('来源：https://v.douyin.com/aVsReZWbgow/');
    const withId = { ...video, webUrl: 'https://v.douyin.com/aVsReZWbgow/' };
    expect(exportVideo(withId, lines, 'txt').content).toContain('来源：https://www.douyin.com/video/7354181234567890123');
  });
  it('md 已按要求移除', () => {
    expect(() => exportVideo(video, lines, 'md' as never)).toThrow();
  });
  it('json 带 sourceUrl 与完整元数据', () => {
    const f = exportVideo(video, lines, 'json');
    const data = JSON.parse(f.content);
    expect(data.sourceUrl).toBe('https://www.douyin.com/video/7354181234567890123');
    expect(data.lines).toHaveLength(2);
  });
  it('CSV 带 UTF-8 BOM', () => {
    const f = exportLibrary([{ video, line: lines[0] }], 'csv');
    expect(f.content.charCodeAt(0)).toBe(0xfeff);
    expect(f.content).toContain('视频标题,作者,原链接,时间,标签,文本');
    expect(f.content).toContain('"测试视频"');
  });
  it('导出全部 / 导入解析', () => {
    const f = exportAll([video], lines, []);
    const data = parseImportAll(f.content);
    expect(data.videos).toHaveLength(1);
    expect(data.lines).toHaveLength(2);
    expect(() => parseImportAll('{"version":2}')).toThrow();
  });
});
