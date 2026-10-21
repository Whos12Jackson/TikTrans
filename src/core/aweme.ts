// 从作品 JSON 提取字段、选音频地址（字段名以实际抓到的 JSON 为准，容错取值）
import type { AwemeData } from './types';

interface AnyObj { [k: string]: any }

const pick = (o: AnyObj | undefined, path: (string | number)[], fallback: any = ''): any => {
  let cur: any = o;
  for (const k of path) {
    if (cur == null || typeof cur !== 'object') return fallback;
    cur = cur[k];
  }
  return cur == null ? fallback : cur;
};

const urlList = (node: any): string[] => {
  if (!node) return [];
  const list = Array.isArray(node) ? node : node.url_list;
  return Array.isArray(list) ? list.filter((u) => typeof u === 'string' && u) : [];
};

/** 去掉视频地址里的水印参数，拿到最干净的可下载地址（形态以实际为准） */
const cleanUrl = (u: string): string => u.replace(/&watermark=\d+/, '');

/** 该地址是不是纯音频流（地址里带 media-audio） */
export const isAudioUrl = (u: string): boolean => /media-audio|\/audio\//i.test(u);

/**
 * 地址质量打分（越大越优先下载）。实测（Edge 真实环境）：
 * - `/play/dash/` 版：HTTP 200 但浏览器 AudioContext 解不出音轨（"Unable to decode audio data"）→ 最差
 * - `-web.` 域名：常 403（防盗链，要 Referer）→ 靠后
 * - `weba` 域名 / `aweme/v1/play/?`：可正常解码 → 优先
 * - 纯音频流（media-audio）：体积最小、最稳 → 最优先
 */
export function mediaUrlScore(u: string): number {
  let s = 0;
  if (/\/play\/dash\//.test(u)) s -= 100;      // HTTP 200 但浏览器解不出音轨
  if (/-web\d*\.douyinvod\.com/.test(u)) s -= 20; // 常 403（防盗链）
  if (/weba\d*\.douyinvod\.com/.test(u)) s += 30;  // web 音频版：可解码
  if (/\/aweme\/v1\/play\/\?/.test(u)) s += 40;    // 抖音自家 CDN：最稳
  if (isAudioUrl(u)) s -= 10;                      // media-audio 纯音轨：实测可能是静音轨
  return s;
}

/** 选择媒体地址：纯音频流 → bit_rate 里码率最低的视频流 → play_addr。每个地址依次试 url_list 镜像。 */
export function selectMediaUrls(aweme: AnyObj): { audioUrls: string[]; videoUrls: string[] } {
  const audioUrls: string[] = [];
  const videoUrls: string[] = [];

  // 1) 播放器请求过的纯音频流（aweme 级，页面钩子会带上）以及 play_addr 里的纯音频地址
  const audioField = urlList(pick(aweme, ['audio', 'play_addr'], null))
    .concat(urlList(pick(aweme, ['video', 'play_addr'], null)));
  for (const u of audioField) if (isAudioUrl(u)) audioUrls.push(cleanUrl(u));

  // 2) bit_rate 里码率最低的视频流
  const bitRates: AnyObj[] = Array.isArray(pick(aweme, ['video', 'bit_rate'], []))
    ? pick(aweme, ['video', 'bit_rate'], [])
    : [];
  const sorted = bitRates
    .map((b) => ({
      rate: Number(pick(b, ['bit_rate'], 0)) || 0,
      urls: urlList(pick(b, ['play_addr'], null)),
    }))
    .filter((b) => b.urls.length > 0)
    .sort((a, b) => a.rate - b.rate);
  for (const b of sorted) {
    for (const u of b.urls) {
      if (isAudioUrl(u)) {
        if (!audioUrls.includes(cleanUrl(u))) audioUrls.push(cleanUrl(u));
      } else {
        const c = cleanUrl(u);
        if (!videoUrls.includes(c)) videoUrls.push(c);
      }
    }
  }

  // 3) play_addr 兜底
  for (const u of urlList(pick(aweme, ['video', 'play_addr'], null))) {
    const c = cleanUrl(u);
    if (isAudioUrl(u)) {
      if (!audioUrls.includes(c)) audioUrls.push(c);
    } else if (!videoUrls.includes(c)) {
      videoUrls.push(c);
    }
  }

  // 音频全缺时，把视频流也作为音频来源（下载后 ffmpeg 提音频）
  // 按「可解码概率」排序：dash 版解码不了，别让它排第一
  audioUrls.sort((a, b) => mediaUrlScore(b) - mediaUrlScore(a));
  videoUrls.sort((a, b) => mediaUrlScore(b) - mediaUrlScore(a));
  return { audioUrls, videoUrls };
}

/** 作品 JSON → AwemeData（capture 阶段产物） */
export function parseAweme(aweme: AnyObj): AwemeData | null {
  const contentId = String(pick(aweme, ['aweme_id'], ''));
  if (!contentId) return null;

  const images = pick(aweme, ['images'], null);
  const isImagePost = Array.isArray(images) && images.length > 0;

  const hashtags: string[] = [];
  const textExtra = pick(aweme, ['text_extra'], []);
  if (Array.isArray(textExtra)) {
    for (const t of textExtra) {
      const name = t && t.hashtag_name;
      if (name && !hashtags.includes(name)) hashtags.push(name);
    }
  }

  const { audioUrls, videoUrls } = selectMediaUrls(aweme);
  // 抖音 video.duration 是毫秒（实测 15 秒的视频 ≈ 15000）；只有 <1000 的异常小值才按秒兜底
  const rawDuration = Number(pick(aweme, ['video', 'duration'], 0)) || 0;
  const durationMs = rawDuration > 0 && rawDuration < 1000 ? rawDuration * 1000 : rawDuration;

  return {
    contentId,
    desc: String(pick(aweme, ['desc'], '')),
    create_time: Number(pick(aweme, ['create_time'], 0)) || 0,
    authorNickname: String(pick(aweme, ['author', 'nickname'], '')),
    authorSecUid: String(pick(aweme, ['author', 'sec_uid'], '')),
    durationMs,
    coverUrl: String(pick(aweme, ['video', 'cover', 'url_list', 0], '')
      || pick(aweme, ['video', 'cover_addr', 'url_list', 0], '')),
    hashtags,
    isImagePost,
    webUrl: `https://www.douyin.com/video/${contentId}`,
    audioUrls,
    videoUrls,
  };
}

/** 从接口响应/页面内嵌数据里挖出作品对象列表（兼容三种形态：单条作品、aweme_detail、aweme_list） */
export function harvestAwemes(payload: AnyObj): AnyObj[] {
  const out: AnyObj[] = [];
  const seen = new Set<string>();

  const push = (a: AnyObj) => {
    const id = String(a?.aweme_id ?? '');
    if (id && !seen.has(id)) {
      seen.add(id);
      out.push(a);
    }
  };

  const walk = (node: AnyObj, depth: number) => {
    if (!node || typeof node !== 'object' || depth > 5) return;
    // 单条作品对象（页面脚本送来的就是这种）
    const idType = typeof node.aweme_id;
    if ((idType === 'string' || idType === 'number') && (node.video || node.images)) {
      push(node);
      return; // 不递归进作品内部（避免挖到 origin/mix 里的嵌套作品）
    }
    if (node.aweme_detail && typeof node.aweme_detail === 'object') walk(node.aweme_detail, depth + 1);
    if (Array.isArray(node.aweme_list)) for (const a of node.aweme_list) walk(a, depth + 1);
    if (node.data && typeof node.data === 'object') walk(node.data, depth + 1);
  };

  walk(payload, 0);
  return out;
}
