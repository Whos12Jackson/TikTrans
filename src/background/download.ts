// 音频下载：fetch 下载，403 时用 declarativeNetRequest 会话规则补 Referer 再试
const REFERER = 'https://www.douyin.com/';

let refererRuleId: number | null = null;

/**
 * 常驻 Referer 会话规则：抖音 CDN 大量 403（防盗链），
 * 规则一旦建立就对**整个扩展的所有请求**生效（后台 + 离屏文档），
 * 离屏文档自己下载候选地址时也因此不会 403。
 */
export async function ensureRefererRule(): Promise<void> {
  if (refererRuleId != null) return;
  const ruleId = 991100 + Math.floor(Math.random() * 900);
  await chrome.declarativeNetRequest.updateSessionRules({
    addRules: [{
      id: ruleId,
      priority: 1,
      action: {
        type: 'modifyHeaders',
        requestHeaders: [
          { header: 'Referer', operation: 'set', value: REFERER },
          { header: 'Origin', operation: 'set', value: 'https://www.douyin.com' },
        ],
      },
      condition: {
        // 媒体 CDN + 抖音域，尽量不干扰其他请求
        requestDomains: ['douyinvod.com', 'zjcdn.com', 'bytecdn.com', 'douyin.com', 'iesdouyin.com'],
        resourceTypes: ['xmlhttprequest', 'media', 'other'],
      },
    } as any],
  });
  refererRuleId = ruleId;
}

async function addRefererRule(): Promise<number> {
  const ruleId = 991100 + Math.floor(Math.random() * 900);
  await chrome.declarativeNetRequest.updateSessionRules({
    addRules: [{
      id: ruleId,
      priority: 1,
      action: {
        type: 'modifyHeaders',
        requestHeaders: [
          { header: 'Referer', operation: 'set', value: REFERER },
          { header: 'Origin', operation: 'set', value: 'https://www.douyin.com' },
        ],
      },
      condition: {
        // 媒体 CDN + 抖音域，尽量不干扰其他请求
        requestDomains: ['douyinvod.com', 'zjcdn.com', 'bytecdn.com', 'douyin.com', 'iesdouyin.com'],
        resourceTypes: ['xmlhttprequest', 'media', 'other'],
      },
    } as any],
  });
  return ruleId;
}

async function removeRefererRule(ruleId: number): Promise<void> {
  await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [ruleId] });
}

/** 下载媒体：按 url_list 镜像依次试；403 补 Referer 重试 */
export async function downloadAudio(urls: string[]): Promise<Blob> {
  if (urls.length === 0) throw new Error('没有可下载的地址');
  let lastErr = '';
  let ruleId: number | null = null;

  const tryFetch = async (url: string, withReferer: boolean): Promise<Blob | null> => {
    try {
      if (withReferer && ruleId == null) ruleId = await addRefererRule();
      const resp = await fetch(url, { credentials: 'include' });
      if (!resp.ok) {
        let host = url.slice(0, 80);
        try { host = new URL(url).host; } catch { /* 保留原样 */ }
        lastErr = `HTTP ${resp.status} @ ${host}`;
        return null;
      }
      return await resp.blob();
    } catch (e: any) {
      lastErr = String(e?.message ?? e);
      return null;
    }
  };

  try {
    for (const url of urls) {
      const blob = await tryFetch(url, false);
      if (blob && blob.size > 0) return blob;
    }
    // 全部失败：补 Referer 再来一遍
    for (const url of urls) {
      const blob = await tryFetch(url, true);
      if (blob && blob.size > 0) return blob;
    }
    throw new Error(`下载失败（${lastErr || '未知原因'}）。多半是防盗链或地址过期——点「重试」会重新打开页面取新地址`);
  } finally {
    if (ruleId != null) await removeRefererRule(ruleId);
  }
}
