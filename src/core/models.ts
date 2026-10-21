// 模型下载管理：Range 分块下载（断点续传）→ 存入 IndexedDB → 供识别引擎读取
// 模型是数据文件，不打包进扩展；下载地址是配置项（core/settings.ts 的 model）
//
// 为什么存 IndexedDB 而不是 Cache Storage（实测踩过的坑）：
//   228MB 的大文件放进 Cache Storage 后，别的上下文（识别 Worker、离屏文档）读不到，
//   浏览器重启后连设置页自己也读不到 → 转写直接报「模型文件缺失」。
//   IndexedDB 没有这个问题，而且扩展本来就在用它存音频。
//
// 下载过程按 8MB 分块存（modelsChunks 表），断网可以续传；
// 全部下完再合并成一个整块存进 models 表（合并只做一次，避免反复复制大文件）。
import { db } from './db';
import type { ModelFileRecord } from './types';
import type { ModelFiles } from './settings';

export const MODEL_CACHE_KEYS = {
  model: 'model',
  tokens: 'tokens',
  vad: 'vad',
} as const;

export type ModelFileKey = keyof typeof MODEL_CACHE_KEYS;

export interface DownloadProgress {
  key: ModelFileKey;
  loaded: number;
  total: number;
  /** 文字说明（正在下哪个文件 / 换地址的原因） */
  phase?: string;
}

const CHUNK_SIZE = 8 * 1024 * 1024;
/** 停滞超时：多少秒没有新数据就判定这个地址坏了（换下一个） */
const STALL_TIMEOUT_MS = 30_000;

/**
 * 从本地文件导入模型（网络下不动时的兜底）：
 * 用户用浏览器/下载器把文件下下来，再拖进扩展即可。
 */
export async function importModelFile(key: ModelFileKey, file: Blob): Promise<number> {
  const name = MODEL_CACHE_KEYS[key];
  const size = file.size;
  if (size < MIN_SIZE[key]) {
    throw new Error(
      `这个文件太小了（${(size / 1048576).toFixed(1)}MB），`
      + `${key} 至少要 ${(MIN_SIZE[key] / 1048576).toFixed(0)}MB——别选错文件了`,
    );
  }
  await db.models.put({ key: name, blob: file, size, savedAt: Date.now() } as ModelFileRecord);
  await db.modelChunks.where('name').equals(name).delete();
  return size;
}

/**
 * 逐个测试下载地址是否可用（只拉第一个字节，很快）。
 * 用来判断"是我的网络/代理问题，还是某个镜像挂了"。
 */
export async function testModelUrls(
  files: ModelFiles,
): Promise<{ key: ModelFileKey; url: string; ok: boolean; detail: string }[]> {
  const fb = files.modelFallbackUrls ?? {};
  const list: { key: ModelFileKey; url: string }[] = [
    { key: 'model', url: files.modelUrl },
    ...(fb.model ?? []).map((url) => ({ key: 'model' as ModelFileKey, url })),
    { key: 'tokens', url: files.tokensUrl },
    ...(fb.tokens ?? []).map((url) => ({ key: 'tokens' as ModelFileKey, url })),
    { key: 'vad', url: files.vadUrl },
    ...(fb.vad ?? []).map((url) => ({ key: 'vad' as ModelFileKey, url })),
  ];
  const out: { key: ModelFileKey; url: string; ok: boolean; detail: string }[] = [];
  for (const item of list) {
    const short = item.url.replace(/^https?:\/\//, '').slice(0, 46);
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(new Error('stalled')), 12_000);
      const resp = await fetch(item.url, { headers: { Range: 'bytes=0-1023' }, signal: ctrl.signal });
      clearTimeout(timer);
      const cr = resp.headers.get('content-range') ?? '';
      const total = cr.includes('/') ? cr.split('/')[1] : '';
      out.push({
        key: item.key, url: short, ok: resp.ok || resp.status === 206,
        detail: `HTTP ${resp.status}${total ? `，共 ${(Number(total) / 1048576).toFixed(1)}MB` : ''}`,
      });
    } catch (e: any) {
      out.push({
        key: item.key, url: short, ok: false,
        detail: String(e?.message ?? e).includes('aborted') ? '超时（12 秒无响应）' : String(e?.message ?? e).slice(0, 40),
      });
    }
  }
  return out;
}

/** 扩展里是否自带模型文件（离线包）——自带就不需要下载 */
export async function hasBundledModel(): Promise<boolean> {
  try {
    const url = chrome.runtime.getURL('model/sense-voice.onnx');
    const resp = await fetch(url, { method: 'HEAD' });
    if (!resp.ok) return false;
    const len = Number(resp.headers.get('content-length') ?? 0);
    return len === 0 || len >= 150 * 1024 * 1024;   // 拿不到长度就按"有"处理
  } catch {
    return false;
  }
}

export async function hasModels(): Promise<boolean> {
  const keys = await db.models.toCollection().primaryKeys();
  const set = new Set(keys.map(String));
  return set.has('model') && set.has('tokens') && set.has('vad');
}

/** 各模型文件已下载的大小（字节），设置页用来显示"已下载 228MB"这种真实信息 */
export async function modelSizes(): Promise<Record<string, number>> {
  const rows = await db.models.toArray();
  const out: Record<string, number> = {};
  for (const r of rows) out[r.key] = r.size;
  return out;
}

export async function clearModels(): Promise<void> {
  await db.models.clear();
  await db.modelChunks.clear();
}

/** 读模型字节：找不到返回 null */
export async function readModelFile(key: ModelFileKey): Promise<ArrayBuffer | null> {
  const rec = await db.models.get(MODEL_CACHE_KEYS[key]);
  if (!rec?.blob) return null;
  return rec.blob.arrayBuffer();
}

/**
 * 校验模型文件是否完整（残缺模型会让 wasm 直接 abort，
 * 报出来的是天书一样的 "Program terminated with exit(-1)"，所以这里提前拦一道）。
 */
export async function checkModelIntegrity(key: ModelFileKey, minBytes: number): Promise<string | null> {
  const rec = await db.models.get(MODEL_CACHE_KEYS[key]);
  if (!rec?.blob) return '模型文件缺失';
  if (rec.size < minBytes) {
    return `模型文件不完整（只有 ${(rec.size / 1048576).toFixed(1)}MB，应不少于 ${(minBytes / 1048576).toFixed(0)}MB），请在设置里点「重新下载模型」`;
  }
  return null;
}

async function sha256Hex(buf: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** 已下载的分块（按序号排序） */
async function loadChunks(name: string): Promise<Blob[]> {
  const rows = await db.modelChunks.where('name').equals(name).sortBy('index');
  return rows.map((r) => r.blob);
}

/**
 * 各文件应有的最小字节数（用来挡住"下到别的文件"的情况）。
 * 之前就踩过：主模型地址失败 → 自动换了兜底地址 → 拿回来的是 VAD 文件（0.6MB），
 * 却被当成"下载完成"存了进去，引擎初始化直接 wasm abort。
 */
const MIN_SIZE: Record<ModelFileKey, number> = {
  model: 150 * 1024 * 1024,   // 主模型 228MB
  tokens: 100 * 1024,        // tokens.txt 约 300KB
  vad: 100 * 1024,           // silero_vad.onnx 约 630KB
};

/**
 * 下载单个文件（支持 Range 断点续传）。
 * 传入的 url 可以是「主地址 + 备用地址」数组：主地址失败（网络不通/超时/文件不对）就换下一个。
 * onProgress 上报进度。
 */
export async function downloadFile(
  key: ModelFileKey,
  url: string | string[],
  onProgress?: (p: DownloadProgress) => void,
): Promise<void> {
  const name = MODEL_CACHE_KEYS[key];
  const urls = Array.isArray(url) ? url : [url];
  const existing = await db.models.get(name);
  console.log('[tiktrans] 开始下载模型文件', key, '已有', existing?.size ?? 0, '字节');
  if (existing?.blob && existing.size > 0 && existing.size >= MIN_SIZE[key]) {
    onProgress?.({ key, loaded: existing.size, total: existing.size });
    return;
  }
  // 之前下到过残缺文件 → 丢掉重下
  if (existing?.blob && existing.size < MIN_SIZE[key]) {
    console.warn('[tiktrans] 已存的模型文件不完整，删掉重下', key, existing.size);
    await db.models.delete(name);
  }

  // 续传：取已下载的分块
  const chunks = await loadChunks(name);
  const already = chunks.reduce((a, b) => a + b.size, 0);

  let lastErr: unknown = null;
  const tried: string[] = [];
  for (let [i, one] of urls.entries()) {
    try {
      if (i > 0) console.warn('[tiktrans] 换备用地址', one);
      // 先报一次进度：让界面显示"正在下载 model"，否则大文件开头的等待看起来像卡死
      onProgress?.({ key, loaded: 0, total: 0, phase: `开始下载 ${name}（地址 ${i + 1}/${urls.length}）` });
      await downloadFrom(key, name, one, chunks, already, onProgress);
      // 大小校验：拿到的不对（比如把 VAD 当成模型）→ 视为失败，换下一个地址
      const rec = await db.models.get(name);
      if (!rec || rec.size < MIN_SIZE[key]) {
        await db.models.delete(name);
        throw new Error(`下到的文件不对（${((rec?.size ?? 0) / 1048576).toFixed(1)}MB，应不少于 ${(MIN_SIZE[key] / 1048576).toFixed(0)}MB）`);
      }
      return;
    } catch (e: any) {
      lastErr = e;
      const why = String(e?.message ?? e).includes('aborted') || String(e?.name) === 'AbortError'
        ? '下载卡住超时（30 秒没有数据）' : String(e?.message ?? e).slice(0, 90);
      console.warn('[tiktrans] 这个地址不行，换下一个：', why);
      tried.push(`${one.replace(/^https?:\/\//, '').slice(0, 40)} → ${why}`);
      onProgress?.({ key, loaded: 0, total: 0, phase: `${name}：${why}，换下一个地址` });
      // 这个地址下了一半，续传起点要重置
      await db.modelChunks.where('name').equals(name).delete();
      chunks.length = 0;
    }
  }
  const lastMsg = String((lastErr as any)?.message ?? lastErr ?? '').slice(0, 70);
  throw new Error(
    `模型「${name}」下载失败：${urls.length > 1 ? `已试 ${urls.length} 个地址都不行` : '网络不通'}`
    + `（${lastMsg}）。请检查网络后重试；国内网络建议在设置里换成镜像地址。`
    + `\n逐个地址的结果：\n` + tried.map((t) => '· ' + t).join('\n'),
  );
}

/**
 * 从一个地址把文件拉完。
 * 关键：**服务器不一定一次给完**（实测：部分 CDN/代理一次只给 1MB，然后要你用 Range 继续要）。
 * 所以这里循环请求，用 Content-Range 里的总长度判断是否下完，下完再合并入库；
 * 最后校验实际大小与总长一致——不完整的模型绝不能入库（否则引擎初始化会 wasm abort）。
 */
async function downloadFrom(
  key: ModelFileKey,
  name: string,
  url: string,
  chunks: Blob[],
  already: number,
  onProgress?: (p: DownloadProgress) => void,
): Promise<void> {
  let total = 0;           // 文件真实总长（从 Content-Range / Content-Length 推断）
  let loaded = already;    // 已经拿到的字节数
  let index = chunks.length;
  let pending: BlobPart[] = [];
  let pendingSize = 0;

  const flush = async () => {
    if (!pending.length) return;
    const blob = new Blob(pending as BlobPart[]);
    pending = [];
    pendingSize = 0;
    await db.modelChunks.put({ name, index: index++, blob, size: blob.size, savedAt: Date.now() });
  };

  for (let round = 0; round < 2000; round++) {
    const headers: Record<string, string> = {};
    if (loaded > 0) headers.Range = `bytes=${loaded}-`;

    // 超时保护：有的服务器连上了却一直不发数据（实测大文件常这样），
    // 没有超时就会永远卡住。加上 AbortController：首字节 30 秒不来、
    // 或中途 30 秒没有新数据，就判定这个地址不可用，换下一个。
    const ctrl = new AbortController();
    let stallTimer: ReturnType<typeof setTimeout> | null = null;
    const armStall = () => {
      if (stallTimer) clearTimeout(stallTimer);
      stallTimer = setTimeout(() => ctrl.abort(new Error('stalled')), STALL_TIMEOUT_MS);
    };
    armStall();

    const resp = await fetch(url, { headers, signal: ctrl.signal });
    if (stallTimer) clearTimeout(stallTimer);
    if (!resp.ok && resp.status !== 206) {
      throw new Error(`HTTP ${resp.status}`);
    }
    // Content-Range: bytes 0-1048575/239233841 → 真实总长
    const cr = resp.headers.get('content-range');
    if (cr) {
      const t = Number(cr.split('/')[1] ?? 0);
      if (t > 0) total = t;
    }
    if (!total) {
      const cl = Number(resp.headers.get('content-length') ?? 0);
      if (cl > 0) total = loaded + cl;
    }
    // 服务器忽略了 Range（返回 200 全量）→ 说明这次就是完整文件
    if (resp.status === 200 && loaded > 0) {
      await db.modelChunks.where('name').equals(name).delete();
      chunks.length = 0;
      loaded = 0;
      index = 0;
    }

    let got = 0;
    const reader = resp.body?.getReader();
    if (!reader) {
      const blob = await resp.blob();
      pending.push(blob);
      got = blob.size;
    } else {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        armStall();          // 有新数据 → 重新计时（30 秒内必须还有数据）
        pending.push(value.slice().buffer as ArrayBuffer);
        pendingSize += value.length;
        got += value.length;
        loaded += value.length;
        if (pendingSize >= CHUNK_SIZE) await flush();
        onProgress?.({ key, loaded, total });
      }
    }
    if (stallTimer) clearTimeout(stallTimer);
    await flush();
    if (!got) break;                    // 没拿到新数据 → 停，别死循环
    if (total && loaded >= total) break; // 下完了
    if (!total && resp.status === 200) break; // 不知道总长且服务器给了全量
  }

  // 合并成一个整块（只做一次）
  const all = await loadChunks(name);
  const blob = new Blob(all as BlobPart[], { type: 'application/octet-stream' });
  if (total && blob.size !== total) {
    throw new Error(`下载不完整：拿到 ${(blob.size / 1048576).toFixed(1)}MB，应为 ${(total / 1048576).toFixed(1)}MB`);
  }
  await db.models.put({ key: name, blob, size: blob.size, savedAt: Date.now() } as ModelFileRecord);
  await db.modelChunks.where('name').equals(name).delete();
  onProgress?.({ key, loaded: blob.size, total: total || blob.size });
}

/** 一次性下载全部模型文件 */
export async function downloadAllModels(
  files: ModelFiles,
  onProgress?: (p: DownloadProgress) => void,
): Promise<void> {
  const fb = files.modelFallbackUrls ?? {};
  // 每个文件用各自的兜底地址（之前三份文件共用一份列表，
  // 结果主地址失败时把 VAD 当成模型存了进去，用户看到"下载完成"但模型只有 0.6MB）
  await downloadFile('vad', [files.vadUrl, ...(fb.vad ?? [])], onProgress);
  await downloadFile('tokens', [files.tokensUrl, ...(fb.tokens ?? [])], onProgress);
  await downloadFile('model', [files.modelUrl, ...(fb.model ?? [])], onProgress);

  // SHA-256 校验（配置了才校验）
  if (files.modelSha256) {
    const buf = await readModelFile('model');
    if (!buf) throw new Error('模型文件丢失');
    const hex = await sha256Hex(buf);
    if (hex.toLowerCase() !== files.modelSha256.toLowerCase()) {
      await clearModels();
      throw new Error('模型校验失败（SHA-256 不符），已清空缓存，请重新下载');
    }
  }
}
