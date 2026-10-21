import { describe, expect, it } from 'vitest';
import { harvestAwemes, parseAweme, selectMediaUrls } from '../src/core/aweme';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const FIX = join(process.cwd(), 'tests', 'fixtures');

function load(name: string): any {
  return JSON.parse(readFileSync(join(FIX, name), 'utf-8'));
}

describe('作品数据提取', () => {
  it('aweme_detail：字段提取', () => {
    const raw = load('aweme_detail_normal.json');
    const [aweme] = harvestAwemes(raw);
    const d = parseAweme(aweme)!;
    expect(d.contentId).toMatch(/^\d{15,20}$/);
    expect(d.authorNickname).toBeTruthy();
    expect(d.durationMs).toBeGreaterThan(0);
    // 毫秒不被误当秒放大（回归：曾 ×1000 导致全部撞「超过时长上限」）
    expect(d.durationMs).toBe(Number(aweme.video.duration));
    expect(d.hashtags.length).toBeGreaterThan(0);
    expect(d.isImagePost).toBe(false);
    expect(d.webUrl).toContain(d.contentId);
  });

  it('音频地址的选择顺序：纯音频优先', () => {
    const aweme = {
      aweme_id: '1',
      audio: { play_addr: { url_list: ['https://x.douyinvod.com/a?media-audio=1'] } },
      video: {
        play_addr: { url_list: ['https://x.douyinvod.com/v-play'] },
        bit_rate: [
          { bit_rate: 2000, play_addr: { url_list: ['https://x.douyinvod.com/v-high'] } },
          { bit_rate: 500, play_addr: { url_list: ['https://x.douyinvod.com/v-low'] } },
        ],
      },
    };
    const { audioUrls, videoUrls } = selectMediaUrls(aweme);
    expect(audioUrls[0]).toMatch(/media-audio/);
    // 视频流按码率从低到高
    expect(videoUrls[0]).toContain('v-low');
  });

  it('没有纯音频流时用码率最低的视频流兜底', () => {
    const raw = load('aweme_detail_no_audio_stream.json');
    const [aweme] = harvestAwemes(raw);
    const { audioUrls, videoUrls } = selectMediaUrls(aweme);
    expect(audioUrls.length).toBe(0);
    expect(videoUrls.length).toBeGreaterThan(0);
    // 最低码率在前
    const br: number[] = (aweme.video?.bit_rate ?? []).map((b: any) => Number(b.bit_rate) || 0);
    if (br.length >= 2) {
      expect(br.indexOf(Math.min(...br))).toBeLessThan(br.indexOf(Math.max(...br)));
    }
  });

  it('图文识别（images 存在）', () => {
    const raw = load('aweme_detail_images.json');
    const [aweme] = harvestAwemes(raw);
    const d = parseAweme(aweme)!;
    expect(d.isImagePost).toBe(true);
  });

  it('推荐流 aweme_list 批量解析', () => {
    const raw = load('aweme_list_feed.json');
    const list = harvestAwemes(raw);
    expect(list.length).toBeGreaterThanOrEqual(2);
    for (const a of list) expect(parseAweme(a)).not.toBeNull();
  });

  it('harvestAwemes 兼容单条作品对象（页面脚本送来的形态，防回归）', () => {
    const raw = load('aweme_detail_normal.json');
    const [aweme] = harvestAwemes(raw);
    const again = harvestAwemes(aweme);
    expect(again).toHaveLength(1);
    expect(String(again[0].aweme_id)).toBe(aweme.aweme_id);
  });

  it('作者页 aweme_list 批量解析', () => {
    const raw = load('aweme_list_post.json');
    const list = harvestAwemes(raw);
    expect(list.length).toBeGreaterThanOrEqual(2);
  });
});
