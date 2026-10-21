import { describe, expect, it } from 'vitest';
import { mergeTexts, segmentsToLines, splitTimeAt, splitTokensAt } from '../src/core/segment';
import type { AsrSegment } from '../src/core/types';

const seg = (startMs: number, endMs: number, text: string, chars: [number, number][] = []): AsrSegment => {
  // chars: 每个字的 [startMs, endMs]
  const tokens = chars.map((t, i) => [`▁${text[i]}`, t[0], t[1]] as [string, number, number]);
  return { startMs, endMs, text, tokens };
};

describe('成行', () => {
  it('短句模式：一个短句一行', () => {
    const s = [seg(0, 2000, '你好，世界。', [
      [0, 300], [300, 600], [600, 900], [900, 1200], [1200, 1500], [1500, 2000],
    ])];
    const lines = segmentsToLines(s, { lineMode: 'clause' });
    expect(lines.length).toBe(2);
    expect(lines[0].text).toBe('你好，');
    expect(lines[1].text).toBe('世界。');
  });

  it('整句模式：合到句号为止', () => {
    const s = [seg(0, 3000, '你好，世界。再见！', [])];
    const lines = segmentsToLines(s, { lineMode: 'sentence' });
    expect(lines.map((l) => l.text)).toEqual(['你好，世界。', '再见！']);
  });

  it('语音段之间有换气停顿也不该把一句话切两半', () => {
    // 同一句话被 VAD 分成两段，段尾模型各补了一个句号
    const a = seg(0, 2000, '我觉得是你总能发现你自己的感受，', []);
    const b = seg(2600, 5000, '自己的痛苦，在很早之前就被说清楚了。', []);
    const lines = segmentsToLines([a, b], { lineMode: 'sentence' });
    expect(lines.length).toBe(1);
    expect(lines[0].text).toBe('我觉得是你总能发现你自己的感受，自己的痛苦，在很早之前就被说清楚了。');
  });

  it('段边界的短句（假句号）并入下一句', () => {
    const a = seg(0, 800, '所以。', []);
    const b = seg(1200, 2500, '别怕。', []); // 间隔 400ms < sentenceGapMs
    const lines = segmentsToLines([a, b], { lineMode: 'sentence' });
    expect(lines.length).toBe(1);
    expect(lines[0].text).toBe('所以，别怕。');
  });

  it('段边界的句号在说话人真的停顿时才算句子边界', () => {
    const a = seg(0, 2000, '这一句说完了。', []);
    const b = seg(4000, 5000, '下一句开始了。', []); // 停顿 2000ms
    const lines = segmentsToLines([a, b], { lineMode: 'sentence' });
    expect(lines.length).toBe(2);
  });

  it('段内的句号是真句子边界（断行）', () => {
    const s = [seg(0, 4000, '前面半句，后面半句。', [])];
    const lines = segmentsToLines(s, { lineMode: 'sentence' });
    expect(lines.length).toBe(1);
    expect(lines[0].text).toBe('前面半句，后面半句。');
  });

  it('间隔很长的两段仍是两行（真句子边界）', () => {
    const a = seg(0, 1000, '第一句。', []);
    const b = seg(5000, 6000, '第二句。', []); // 停顿 4000ms
    const lines = segmentsToLines([a, b], { lineMode: 'sentence' });
    expect(lines.length).toBe(2);
  });

  it('超过每行最多字数就换行', () => {
    const text = '一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十';
    const s = [seg(0, 40000, text, [])];
    const lines = segmentsToLines(s, { lineMode: 'sentence', maxLineChars: 32 });
    expect(lines.length).toBeGreaterThan(1);
    for (const l of lines) expect(l.text.replace(/[^\p{L}\p{N}]/gu, '').length).toBeLessThanOrEqual(32);
  });

  it('停顿超过换行停顿就换行（短句模式仍然按停顿断）', () => {
    const a = seg(0, 1000, '第一句，', []);
    const b = seg(5000, 6000, '第二句。', []); // 停顿 4000ms > 1200
    const lines = segmentsToLines([a, b], { lineMode: 'clause' });
    expect(lines.length).toBe(2);
  });

  it('跨语音段合并', () => {
    const a = seg(0, 1000, '上半句，', []);
    const b = seg(1100, 2000, '下半句。', []);
    const lines = segmentsToLines([a, b], { lineMode: 'sentence' });
    expect(lines.length).toBe(1);
    expect(lines[0].text).toBe('上半句，下半句。');
    expect(lines[0].startMs).toBe(0);
    expect(lines[0].endMs).toBe(2000);
  });

  it('空输入', () => {
    expect(segmentsToLines([], {})).toEqual([]);
    expect(segmentsToLines([{ startMs: 0, endMs: 10, text: '  ', tokens: [] }], {})).toEqual([]);
  });

  it('超长短句在 30%~70% 处拆开', () => {
    const text = '一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十';
    const s = [seg(0, 40000, text, [])];
    const lines = segmentsToLines(s, { lineMode: 'clause', maxLineChars: 20 });
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.reduce((a, l) => a + l.text, '')).toBe(text);
  });
});

describe('拆行时间和合并', () => {
  it('精确路径：有词元时间且未改过', () => {
    const line = {
      startMs: 0,
      endMs: 3000,
      text: '你好世界',
      textAsr: '你好世界',
      tokens: [
        ['▁你', 0, 700],
        ['▁好', 700, 1400],
        ['▁世', 1400, 2100],
        ['▁界', 2100, 3000],
      ] as [string, number, number][],
    };
    const { t, precise } = splitTimeAt(line, 2);
    expect(precise).toBe(true);
    expect(t).toBe(1400);
  });

  it('插值路径：改过字', () => {
    const line = { startMs: 0, endMs: 3000, text: '你好世界', textAsr: '不是这句', tokens: null };
    const { t, precise } = splitTimeAt(line, 2);
    expect(precise).toBe(false);
    expect(t).toBe(1500);
  });

  it('tokens 拆分与合并', () => {
    const tokens: [string, number, number][] = [
      ['▁你', 0, 700], ['▁好', 700, 1400], ['▁世', 1400, 2100], ['▁界', 2100, 3000],
    ];
    const [l, r] = splitTokensAt({ text: '你好世界', tokens }, 2, true);
    expect(l).toHaveLength(2);
    expect(r).toHaveLength(2);
    const [l2, r2] = splitTokensAt({ text: '你好世界', tokens }, 2, false);
    expect(l2).toBeNull();
    expect(r2).toBeNull();
  });

  it('合并文本只在英文/数字边界补空格', () => {
    expect(mergeTexts('你好，', '世界。')).toBe('你好，世界。');
    expect(mergeTexts('hello', 'world')).toBe('hello world');
    expect(mergeTexts('版本 A', '是 1')).toBe('版本 A是 1');
    expect(mergeTexts('说 hello', '好')).toBe('说 hello好');
  });
});
