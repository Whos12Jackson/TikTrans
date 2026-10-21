import { describe, expect, it } from 'vitest';
import { applyLexicon, diffFragment, lexiconStats, mineLexicon, parseLexicon } from '../src/core/lexicon';

describe('易错词表', () => {
  it('解析：忽略空行/注释/不等长', () => {
    const pairs = parseLexicon([
      '# 注释',
      '',
      '美誉=美玉',
      ' 瓦丽 = 瓦砾 ',
      '太长=不等长会被跳过',
      '没有等号',
      '同样=同样',
    ].join('\n'));
    expect(pairs).toEqual([
      { wrong: '美誉', right: '美玉' },
      { wrong: '瓦丽', right: '瓦砾' },
    ]);
  });

  it('替换：等长错字被纠正', () => {
    const pairs = parseLexicon('美誉=美玉\n瓦丽=瓦砾\n切懦=怯懦');
    const text = '我生怕自己并非美誉。故而不敢…与瓦丽为我…内心切懦的自尊心。';
    expect(applyLexicon(text, pairs)).toBe('我生怕自己并非美玉。故而不敢…与瓦砾为我…内心怯懦的自尊心。');
  });

  it('替换：长词优先（避免短词先被替换掉）', () => {
    const pairs = parseLexicon('徒=途\n徒劳=辛劳');
    expect(applyLexicon('徒劳', pairs)).toBe('辛劳');
  });

  it('空词表不改动文本', () => {
    expect(applyLexicon('原文', [])).toBe('原文');
    expect(applyLexicon('原文', parseLexicon(''))).toBe('原文');
  });

  it('统计', () => {
    const st = lexiconStats('美誉=美玉\n瓦丽=瓦砾');
    expect(st.count).toBe(2);
    expect(st.sample).toContain('美誉→美玉');
  });
});

describe('自动学习词表（从改字记录）', () => {
  it('差异片段提取', () => {
    expect(diffFragment('我生怕自己并非美誉。', '我生怕自己并非美玉。')).toEqual({ old: '誉', new: '玉' });
    expect(diffFragment('美玉', '美誉')).toEqual({ old: '玉', new: '誉' });
    expect(diffFragment('一样的', '一样的')).toBeNull();
  });

  it('同一处改过 2 次才算规律', () => {
    const edits = [
      { kind: 'text', oldText: '美誉', newText: '美玉' },
      { kind: 'text', oldText: '美誉', newText: '美玉' },
      { kind: 'text', oldText: '瓦丽', newText: '瓦砾' },
      { kind: 'text', oldText: '切懦', newText: '怯懦' },
    ];
    const mined = mineLexicon(edits);
    expect(mined).toHaveLength(1); // 只认 2 次以上的
    expect(mined[0]).toEqual({ wrong: '美誉', right: '美玉' });
  });

  it('片段太短/太长/不等长都不采纳', () => {
    const edits = [
      { kind: 'text', oldText: '誉', newText: '玉' },
      { kind: 'text', oldText: '一'.repeat(9), newText: '二'.repeat(9) },
      { kind: 'text', oldText: '三字词', newText: '四个字' },
    ];
    expect(mineLexicon(edits)).toEqual([]);
  });

  it('学到的词条会真的替换文本', () => {
    const pairs = mineLexicon([
      { kind: 'text', oldText: '美誉', newText: '美玉' },
      { kind: 'text', oldText: '美誉', newText: '美玉' },
    ]);
    expect(applyLexicon('我生怕自己并非美誉。', pairs)).toBe('我生怕自己并非美玉。');
  });
});
