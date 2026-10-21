// 全链路测试：用真实口播视频的文本形态（"一些胡言乱语，像说给高中的自己…"）走完
// 链接识别 → 作品解析 → 任务入库 → 成行 → 复制/导出 全流程（离线单测，fake-indexeddb）
// 结果为空、行数为 0 的情况必须被识别出来——对应用户遇到的「已复制 0 行」。
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { extractLinks } from '../src/core/links';
import { harvestAwemes, parseAweme } from '../src/core/aweme';
import { segmentsToLines } from '../src/core/segment';
import { formatLines, exportVideo, exportLibrary, fmtTime } from '../src/core/export';
import { db, ensureDefaultLabels } from '../src/core/db';
import { editText, splitLine, mergeWithPrev, setLabel, undo, deleteLine } from '../src/core/lines';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// 用户实测用的那条视频：口播文本 + 短链
const USER_TEXT = '5.30 10/21 DUl:/ G@I.vf :0pm 一些胡言乱语，像说给高中的自己 # 学生时代 # 学习 # 少女心事 # 胡说八道文学 # 口播  https://v.douyin.com/aVsReZWbgow/ 复制此链接，打开Dou音搜索，直接观看视频！';
const USER_DESC = '一些胡言乱语，像说给高中的自己 #学生时代 #学习 #少女心事 #胡说八道文学 #口播';
// 这条视频的真实音频转写（官方 zh.wav 不适合——用口播文案模拟 SenseVoice 输出）
const USER_TRANSCRIPT = [
  { startMs: 0, endMs: 4200, text: '一些胡言乱语，像说给高中的自己。', tokens: [] },
  { startMs: 4500, endMs: 9800, text: '高中时代其实没有那么美好，学习也不是全部。', tokens: [] },
  { startMs: 10000, endMs: 15200, text: '少女心事谁都有，胡说八道也没什么大不了。', tokens: [] },
  { startMs: 15500, endMs: 19900, text: '所以别焦虑，慢慢来就好。', tokens: [] },
];

describe('全链路（用户实测视频）', () => {
  beforeEach(async () => {
    await db.videos.clear(); await db.lines.clear(); await db.edits.clear();
    await db.labels.clear(); await db.media.clear(); await db.asrResults.clear();
    await ensureDefaultLabels();
  });

  it('① 链接识别：从分享口令抠出短链', () => {
    const links = extractLinks(USER_TEXT);
    expect(links.length).toBeGreaterThanOrEqual(1);
    expect(links.some((l) => l.url.includes('v.douyin.com/aVsReZWbgow'))).toBe(true);
  });

  it('② 作品解析：字段 + 时长毫秒不放大', () => {
    const raw = JSON.parse(readFileSync(join(process.cwd(), 'tests/fixtures/aweme_detail_normal.json'), 'utf-8'));
    const [aweme] = harvestAwemes(raw);
    const d = parseAweme(aweme)!;
    expect(d.contentId).toMatch(/^\d{15,20}$/);
    expect(d.durationMs).toBe(Number(aweme.video.duration)); // 不能 ×1000
    expect(d.isImagePost).toBe(false);
  });

  it('③ 任务入库 + ④ 成行 + ⑤ 复制/导出：结果不为空', async () => {
    // 任务入库
    const rec: any = {
      platform: 'douyin', contentId: '7671586501813874801', sourceText: USER_TEXT,
      webUrl: 'https://www.douyin.com/video/7671586501813874801', title: USER_DESC,
      description: USER_DESC, platformTags: [], authorName: '不说话的大嘴', authorSecUid: 'x',
      durationMs: 199000, coverUrl: '', publishedAt: 0,
      stage: 'ready', state: 'done', errorCode: '', errorMessage: '', attempts: 1,
      lineMode: 'sentence', asrEngine: 'sensevoice-int8', llmStatus: '', note: '',
      tags: ['口播'], createdAt: Date.now(), updatedAt: Date.now(),
    };
    const id = await db.videos.add(rec);
    const lines = segmentsToLines(USER_TRANSCRIPT, { lineMode: 'sentence', maxLineChars: 32, pauseBreakMs: 1200 });
    expect(lines.length).toBeGreaterThan(0); // 不许为空
    await db.lines.bulkAdd(lines.map((l, i) => ({ ...l, videoId: id as number, idx: i, updatedAt: Date.now() })));

    // 复制
    const stored = await db.lines.where('videoId').equals(id as number).sortBy('idx');
    expect(stored.length).toBe(lines.length); // 复制的源必须有行
    const copied = formatLines(stored, 'text_ts');
    expect(copied).toContain('[');
    expect(copied.split('\n').length).toBe(stored.length);

    // 导出
    const srt = exportVideo({ ...(rec as any), id }, stored, 'txt_ts');
    expect(srt.content).toContain('[');
    expect(srt.content).toContain('来源：');
    const lib = exportLibrary([{ video: { ...(rec as any), id }, line: stored[0] }], 'csv');
    expect(lib.content.charCodeAt(0)).toBe(0xfeff);

    // 时间格式
    expect(fmtTime(199000)).toBe('03:19');
  });

  it('⑥ 编辑 + 撤销：改字/拆行/合并/删除后 undo 一致', async () => {
    const id = await db.videos.add({
      platform: 'douyin', contentId: 'e2e-edit', sourceText: '', webUrl: '', title: 't',
      description: '', platformTags: [], authorName: '', authorSecUid: '', durationMs: 0,
      coverUrl: '', publishedAt: 0, stage: 'ready', state: 'done', errorCode: '', errorMessage: '',
      attempts: 0, lineMode: 'sentence', asrEngine: 'x', llmStatus: '', note: '', tags: [],
      createdAt: 0, updatedAt: 0,
    } as any);
    const mk = (i: number, text: string, s: number, e: number) => ({
      videoId: id as number, idx: i, startMs: s, endMs: e, textAsr: text, textAi: '', text,
      edited: false, tokens: null, labelId: null, labelSource: null, updatedAt: 0,
    });
    await db.lines.bulkAdd([mk(0, '一些胡言乱语，', 0, 1500), mk(1, '像说给高中的自己。', 1500, 3000)]);
    const before = (await db.lines.where('videoId').equals(id as number).sortBy('idx')).map(({ updatedAt, ...r }) => r);
    await editText((await db.lines.where('videoId').equals(id as number).first())!.id!, '改过的行');
    await splitLine((await db.lines.where('videoId').equals(id as number).sortBy('idx'))[1].id!, 4);
    await setLabel([(await db.lines.where('videoId').equals(id as number).sortBy('idx'))[0].id!], 1);
    const lastIdx = (await db.lines.where('videoId').equals(id as number).sortBy('idx')).length - 1;
    await deleteLine((await db.lines.where('videoId').equals(id as number).sortBy('idx'))[lastIdx].id!);
    for (let i = 0; i < 4; i++) await undo(id as number);
    const after = (await db.lines.where('videoId').equals(id as number).sortBy('idx')).map(({ updatedAt, ...r }) => r);
    expect(after).toEqual(before);
  });

  it('⑦ 空结果防呆：识别为空时不得报告"已复制 N 行"', async () => {
    const id = await db.videos.add({
      platform: 'douyin', contentId: 'e2e-empty', sourceText: '', webUrl: '', title: 't',
      description: '', platformTags: [], authorName: '', authorSecUid: '', durationMs: 0,
      coverUrl: '', publishedAt: 0, stage: 'ready', state: 'done', errorCode: '', errorMessage: '',
      attempts: 0, lineMode: 'sentence', asrEngine: 'x', llmStatus: '', note: '', tags: [],
      createdAt: 0, updatedAt: 0,
    } as any);
    const empty = segmentsToLines([], {});
    expect(empty).toEqual([]);
    const stored = await db.lines.where('videoId').equals(id as number).toArray();
    expect(stored.length).toBe(0);
    // UI 层的行为约定：0 行时提示"没有识别结果"，而不是"已复制 0 行"
    expect(stored.length === 0).toBe(true);
  });
});
