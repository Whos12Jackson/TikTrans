// 作品缓存（页面钩子送来的数据，最近 200 条）——独立模块避免 index ↔ queue 循环依赖
import type { AwemeData } from '../core/types';

const aweCache = new Map<string, AwemeData>();
const MAX_CACHE = 200;

type ResolvedFn = (d: AwemeData, tabId?: number) => void;
let onResolved: ResolvedFn | null = null;
export function setOnResolved(fn: ResolvedFn): void {
  onResolved = fn;
}

/**
 * @param mediaUrls 页面播放器请求过的媒体地址（全局池，可能混有其它视频的）——
 *                  只作兜底追加到 JSON 地址之后，避免把别的视频的音频排到前面
 * @param tabId    来源标签页（短链解析用它做归属匹配）
 */
export function cacheAweme(data: AwemeData, mediaUrls: string[], tabId?: number): void {
  const audioFromPlayer = mediaUrls.filter(
    (u) => /^https?:/i.test(u) && /media-audio|\/audio\//i.test(u) && !data.audioUrls.includes(u),
  );
  if (audioFromPlayer.length) {
    data.audioUrls = [...data.audioUrls, ...audioFromPlayer];
  }
  aweCache.set(data.contentId, data);
  if (aweCache.size > MAX_CACHE) {
    const oldest = aweCache.keys().next().value;
    if (oldest) aweCache.delete(oldest);
  }
  onResolved?.(data, tabId);
}

export function getCache(contentId: string): AwemeData | undefined {
  return aweCache.get(contentId);
}
