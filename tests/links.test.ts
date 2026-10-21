import { describe, expect, it } from 'vitest';
import { extractLinks, parseAweFromUrl } from '../src/core/links';

describe('链接识别', () => {
  it('短链', () => {
    const r = extractLinks('看这个 https://v.douyin.com/iRNBho6u/ 很好');
    expect(r).toHaveLength(1);
    expect(r[0].kind).toBe('short');
    expect(r[0].url).toBe('https://v.douyin.com/iRNBho6u/');
  });

  it('作品页链接', () => {
    const r = extractLinks('https://www.douyin.com/video/7354181234567890123');
    expect(r).toHaveLength(1);
    expect(r[0].kind).toBe('video');
    expect(r[0].contentId).toBe('7354181234567890123');
  });

  it('图文作品（note）', () => {
    const r = extractLinks('https://www.douyin.com/note/7354181234567890123');
    expect(r[0].kind).toBe('note');
  });

  it('modal_id 链接', () => {
    const r = extractLinks('https://www.douyin.com/?modal_id=7354181234567890123');
    expect(r[0].kind).toBe('modal');
    expect(r[0].contentId).toBe('7354181234567890123');
  });

  it('分享页链接', () => {
    const r = extractLinks('https://www.iesdouyin.com/share/video/7354181234567890123');
    expect(r[0].contentId).toBe('7354181234567890123');
  });

  it('一段分享口令里含多条链接，按顺序全部抠出并去重', () => {
    const text = [
      '1.92 复制打开抖音 https://v.douyin.com/aaa111/ 看看',
      'https://www.douyin.com/video/7354181234567890123',
      '再发一遍 https://www.douyin.com/video/7354181234567890123',
      'https://v.douyin.com/aaa111/',
    ].join('，');
    const r = extractLinks(text);
    expect(r).toHaveLength(2);
    expect(r[0].kind).toBe('short');
    expect(r[1].contentId).toBe('7354181234567890123');
  });

  it('没有任何链接时才把独立 19 位数字当 ID', () => {
    const r = extractLinks('视频ID 7354181234567890123 记得看');
    expect(r).toHaveLength(1);
    expect(r[0].kind).toBe('id');
    expect(r[0].url).toBe('https://www.douyin.com/video/7354181234567890123');
  });

  it('有链接时不误识别纯数字', () => {
    const r = extractLinks('https://v.douyin.com/aaa111/ 另外 7354181234567890123 也算');
    expect(r).toHaveLength(1);
    expect(r[0].kind).toBe('short');
  });

  it('粘贴内容里混有其他数字时不能误识别', () => {
    expect(extractLinks('今天是 20261019，价格 12345678901234567890 元')).toHaveLength(0);
    expect(extractLinks('8888 和 666666')).toHaveLength(0);
    expect(extractLinks('2026-10-19 17:15:56')).toHaveLength(0);
  });

  it('parseAweFromUrl', () => {
    expect(parseAweFromUrl('https://www.douyin.com/video/7354181234567890123')?.contentId).toBe('7354181234567890123');
    expect(parseAweFromUrl('https://www.douyin.com/user/xxx?modal_id=7354181234567890123')?.contentId).toBe('7354181234567890123');
    expect(parseAweFromUrl('https://www.douyin.com/')).toBeNull();
  });
});
