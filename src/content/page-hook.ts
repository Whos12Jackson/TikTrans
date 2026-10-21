// 页面钩子（MAIN world，document_start）：包装 fetch 和 XMLHttpRequest，
// 从响应里取作品数据和音视频地址，用 postMessage 交给页面脚本（page-bridge）。
// 抖音接口路径与字段规则集中在这一个文件里，改版只改这里。

const AWEME_RESP_RE = /\/aweme\/v1\/web\/(aweme\/detail|aweme\/post|tab\/feed|search\/item|general\/search|aweme\/favorite)\//;
const MEDIA_URL_RE = /media-audio|douyinvod|\.zjcdn\.com|\.bytecdn\.com|\/video\/play\//;

const TAG = 'tiktrans-hook';

function emit(type: string, payload: unknown): void {
  try {
    window.postMessage({ source: TAG, type, payload }, '*');
  } catch {
    /* 页面环境异常时放弃 */
  }
}

function tryParse(text: string): any | null {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function handleAwemePayload(json: any): void {
  if (!json || typeof json !== 'object') return;
  const hasAweme = json.aweme_detail || Array.isArray(json.aweme_list)
    || (json.data && (json.data.aweme_detail || Array.isArray(json.data.aweme_list)));
  if (hasAweme) emit('aweme:seen', json);
}

function noteMediaUrl(url: string): void {
  if (MEDIA_URL_RE.test(url)) emit('media:url', url);
}

// ---- fetch ----
const origFetch = window.fetch;
window.fetch = async function (input: any, init?: any) {
  const url = typeof input === 'string' ? input : (input?.url ?? '');
  noteMediaUrl(url);
  const resp = await origFetch.call(this, input, init);
  try {
    if (AWEME_RESP_RE.test(url)) {
      const clone = resp.clone();
      clone.text().then((t) => {
        const json = tryParse(t);
        if (json) handleAwemePayload(json);
      }).catch(() => {});
    }
  } catch {
    /* 读响应失败不影响原请求 */
  }
  return resp;
};

// ---- XMLHttpRequest ----
const XHR = XMLHttpRequest.prototype as any;
const origOpen = XHR.open;
const origSend = XHR.send;

XHR.open = function (this: any, method: string, url: string, ...rest: any[]) {
  this.__tiktrans_url = url;
  return origOpen.call(this, method, url, ...rest);
};

XHR.send = function (this: any, ...args: any[]) {
  const url = String(this.__tiktrans_url ?? '');
  if (url) noteMediaUrl(url);
  if (AWEME_RESP_RE.test(url)) {
    this.addEventListener('load', function (this: any) {
      try {
        const json = tryParse(String(this.responseText ?? ''));
        if (json) handleAwemePayload(json);
      } catch {
        /* 忽略 */
      }
    });
  }
  return origSend.apply(this, args);
};

// ---- 页面内嵌数据兜底 ----
// 作品页/分享页常把作品 JSON 内嵌在 window._ROUTER_DATA 或 <script id="RENDER_DATA">，
// 不一定走 XHR；这种形态也挖出来，包成 {aweme_list:[...]} 交给页面脚本。
function deepHarvestAwemes(node: any, out: any[], depth: number, seen: WeakSet<object>): void {
  if (!node || typeof node !== 'object' || depth > 8 || seen.has(node)) return;
  seen.add(node);
  if (Array.isArray(node)) {
    for (const item of node) deepHarvestAwemes(item, out, depth + 1, seen);
    return;
  }
  const idType = typeof node.aweme_id;
  if ((idType === 'string' || idType === 'number') && /^\d{10,20}$/.test(String(node.aweme_id))
    && (node.video || node.images)) {
    out.push(node);
    // 不 return：有些壳层还会嵌套别的作品
  }
  for (const key of Object.keys(node)) {
    deepHarvestAwemes(node[key], out, depth + 1, seen);
  }
}

function scanEmbedded(): void {
  let found: any[] = [];
  let hasRouter = false;
  let hasRender = false;
  try {
    const w = window as any;
    if (w._ROUTER_DATA && typeof w._ROUTER_DATA === 'object') {
      hasRouter = true;
      deepHarvestAwemes(w._ROUTER_DATA, found, 0, new WeakSet());
      if (found.length) emit('aweme:seen', { aweme_list: found });
    }
  } catch { /* 忽略 */ }
  try {
    const el = document.getElementById('RENDER_DATA');
    if (el && el.textContent) {
      hasRender = true;
      // decodeURIComponent 遇非法 % 序列会抛错，此时退回原文解析
      let json: any = null;
      try {
        json = tryParse(decodeURIComponent(el.textContent));
      } catch {
        json = null;
      }
      json = json ?? tryParse(el.textContent);
      if (json) {
        const extra: any[] = [];
        deepHarvestAwemes(json, extra, 0, new WeakSet());
        if (extra.length) {
          found = [...found, ...extra];
          emit('aweme:seen', { aweme_list: extra });
        }
      }
    }
  } catch { /* 忽略 */ }
  // 诊断日志：抓不到数据时把这行发给开发者即可定位
  console.log('[tiktrans] 扫描内嵌数据', {
    url: location.href.slice(0, 60),
    _ROUTER_DATA: hasRouter,
    RENDER_DATA: hasRender,
    作品数: found.length,
  });
}

// 内嵌数据是随文档一起来的，document_start 时可能还没解析到：多扫几次
scanEmbedded();
document.addEventListener('DOMContentLoaded', scanEmbedded);
window.addEventListener('load', scanEmbedded);
setTimeout(scanEmbedded, 1200);
setTimeout(scanEmbedded, 3500);
setTimeout(scanEmbedded, 8000);

// 页面脚本就绪后打个招呼（便于排查）
emit('hook:ready', { at: Date.now() });
