// 从粘贴内容里抠抖音链接 / 作品 ID
export type LinkKind = 'short' | 'video' | 'note' | 'modal' | 'share' | 'id';

export interface ExtractedLink {
  kind: LinkKind;
  /** 能直接确定时给 contentId（aweme_id），短链为空 */
  contentId: string;
  /** 用哪个地址去解析（纯 ID 会拼成作品页 URL） */
  url: string;
  /** 命中的原始文本 */
  raw: string;
}

const RE_SHORT = /https?:\/\/v\.douyin\.com\/[A-Za-z0-9_-]+\/?/g;
const RE_VIDEO_NOTE = /https?:\/\/(?:www\.)?douyin\.com\/(video|note)\/(\d{15,20})/g;
const RE_MODAL = /[?&]modal_id=(\d{15,20})/g;
const RE_SHARE = /https?:\/\/(?:www\.)?iesdouyin\.com\/share\/(video|note)\/(\d{15,20})/g;
const RE_BARE_ID = /(?<![\w./:\\-])(\d{19})(?![\w./:\\-])/g;

/**
 * 一次粘贴可以包含多段分享口令，按出现顺序抠出全部匹配，去重后返回。
 * 纯作品 ID：粘贴内容里一个链接都没有时，才把独立的 19 位数字当作 ID。
 */
export function extractLinks(text: string): ExtractedLink[] {
  const out: ExtractedLink[] = [];
  const seen = new Set<string>();

  const push = (item: ExtractedLink) => {
    const key = item.contentId || item.url;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(item);
  };

  type Span = [number, number];
  const spans: Span[] = [];
  const collect = (re: RegExp, fn: (m: RegExpExecArray) => ExtractedLink | null) => {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      spans.push([m.index, m.index + m[0].length]);
      const item = fn(m);
      if (item) push(item);
    }
  };

  collect(RE_SHORT, (m) => ({ kind: 'short', contentId: '', url: m[0], raw: m[0] }));
  collect(RE_VIDEO_NOTE, (m) => ({
    kind: m[1] === 'note' ? 'note' : 'video',
    contentId: m[2],
    url: m[0],
    raw: m[0],
  }));
  collect(RE_MODAL, (m) => ({
    kind: 'modal',
    contentId: m[1],
    url: m[0].startsWith('http') ? m[0] : `https://www.douyin.com/?modal_id=${m[1]}`,
    raw: m[0],
  }));
  collect(RE_SHARE, (m) => ({
    kind: m[1] === 'note' ? 'note' : 'video',
    contentId: m[2],
    url: m[0],
    raw: m[0],
  }));

  // 只有一个链接都没有时，才把独立的 19 位数字当作纯作品 ID
  if (out.length === 0) {
    RE_BARE_ID.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = RE_BARE_ID.exec(text))) {
      push({
        kind: 'id',
        contentId: m[1],
        url: `https://www.douyin.com/video/${m[1]}`,
        raw: m[1],
      });
    }
  }

  return out;
}

/** 从 URL / 页面地址里解析 aweme_id（视频页、modal_id、分享页） */
export function parseAweFromUrl(url: string): { contentId: string; isNote: boolean } | null {
  const m1 = /\/(video|note)\/(\d{15,20})/.exec(url);
  if (m1) return { contentId: m1[2], isNote: m1[1] === 'note' };
  const m2 = /[?&]modal_id=(\d{15,20})/.exec(url);
  if (m2) return { contentId: m2[1], isNote: false };
  return null;
}
