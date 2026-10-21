// 离屏文档：从 media 表取音频 → 解码 → 16 kHz 单声道 → 交给识别 Worker → 回结果
// （音频走 IndexedDB 不走消息：部分浏览器的扩展消息不支持 ArrayBuffer）
import { db } from '../core/db';
import type { AsrSegment } from '../core/types';

type TranscribeReq = {
  type: 'offscreen:transcribe';
  payload: { videoId: number };
};

let worker: Worker | null = null;
let workerCount = 0;
let keepAliveTimer: ReturnType<typeof setInterval> | null = null;
let lastVideoId = -1;

function getWorker(): Worker {
  if (worker) return worker;
  // 经典 Worker（IIFE 产物）：sherpa-onnx 胶水要用 importScripts 加载
  worker = new Worker(chrome.runtime.getURL('offscreen/asr-worker.js'));
  workerCount++;
  console.log(`[tiktrans] 创建识别 Worker #${workerCount}`);
  // 心跳保活：Chrome 会回收空闲的 Worker，一旦回收，下次转写就要重新分配一套引擎内存
  //（模型 228MB + onnxruntime 的 arena 约 400MB），而旧那份内存浏览器不会还给系统，
  // 于是「每转一条视频，Edge 内存涨 300~400MB」。定时 ping 一下，Worker 就不会被回收。
  if (keepAliveTimer) clearInterval(keepAliveTimer);
  keepAliveTimer = setInterval(() => {
    try { worker?.postMessage({ type: 'asr:ping' }); } catch { /* 忽略 */ }
  }, 20_000);
  worker.onmessage = (ev) => {
    const msg = ev.data;
    if (msg?.type === 'asr:need-model') {
      // Worker 里没有 chrome 对象（读不到扩展自带文件）→ 由离屏文档代取
      void (async () => {
        try {
          const { readModelFile } = await import('../core/models');
          let bytes: ArrayBuffer | null = null;
          let from = '';
          // ① 扩展自带（离线包里有 model/ 目录）
          const bundledName: Record<string, string> = {
            model: 'model/sense-voice.onnx',
            tokens: 'model/tokens.txt',
            vad: 'model/silero_vad.onnx',
          };
          try {
            const r = await fetch(chrome.runtime.getURL(bundledName[msg.key]));
            if (r.ok) {
              const b = await r.arrayBuffer();
              const min = msg.key === 'model' ? 150 * 1024 * 1024 : 1024;
              if (b.byteLength >= min) { bytes = b; from = '扩展自带'; }
            }
          } catch { /* 没有自带文件 */ }
          // ② 已下载到本地（IndexedDB）
          if (!bytes) {
            const b = await readModelFile(msg.key);
            if (b) { bytes = b; from = '本地已下载'; }
          }
          // ③ 找后台（service worker，缓存可见性最广）
          if (!bytes) {
            const r = await chrome.runtime.sendMessage({ type: 'asr:model-bytes', payload: { key: msg.key } })
              .catch(() => null);
            bytes = (r as any)?.bytes ?? null;
            from = '后台';
          }
          console.log(`[tiktrans] 取模型 ${msg.key}：${from}${bytes ? `（${(bytes.byteLength / 1048576).toFixed(1)}MB）` : '（没有）'}`);
          worker?.postMessage({ type: 'asr:model-bytes', payload: { key: msg.key, bytes } }, bytes ? [bytes] : []);
        } catch (e) {
          console.warn('[tiktrans] 取模型失败', String(e));
          worker?.postMessage({ type: 'asr:model-bytes', payload: { key: msg.key, bytes: null } });
        }
      })();
      return;
    }
    if (msg?.type === 'asr:selftest-result') {
      selftestResolve?.(msg.payload);
      return;
    }
    if (msg?.type === 'asr:progress') {
      chrome.runtime.sendMessage({ type: 'asr:progress', payload: msg.payload }).catch(() => {});
    } else if (msg?.type === 'asr:done' || msg?.type === 'asr:error') {
      chrome.runtime.sendMessage({
        type: 'offscreen:transcribe-result',
        payload: msg.type === 'asr:done'
          ? { videoId: msg.payload.videoId, segments: msg.payload.segments, stats: msg.payload.stats }
          : { videoId: msg.payload.videoId, error: msg.payload.error },
      }).catch(() => {});
    }
  };
  worker.onerror = (e) => {
    console.error('[tiktrans] worker error', e);
    // 立即回错误，别让后台挂满超时；同时丢弃 worker，下次重建
    // 注意：wasm 原生崩溃时 e.message 是裸数字（指针），补上下文避免看不懂
    const raw = String(e.message || e.type || 'worker error');
    const detail = /^\d+$/.test(raw)
      ? `识别引擎原生崩溃（wasm abort，指针 ${raw}）——通常是内存不足或模型损坏`
      : `识别引擎崩溃：${raw}`;
    chrome.runtime.sendMessage({
      type: 'offscreen:transcribe-result',
      payload: { videoId: lastVideoId, error: detail },
    }).catch(() => {});
    try { worker?.terminate(); } catch { /* 忽略 */ }
    worker = null;
  };
  return worker;
}

// ---------- 解码 ----------
function sniff(buf: ArrayBuffer): string {
  const b = new Uint8Array(buf.slice(0, 16));
  const ascii = Array.from(b).map((c) => (c >= 32 && c < 127 ? String.fromCharCode(c) : '.')).join('');
  const hex = Array.from(b.slice(0, 8)).map((c) => c.toString(16).padStart(2, '0')).join(' ');
  let kind = '未知容器';
  if (ascii.includes('ftyp')) kind = 'MP4/M4A';
  else if (ascii.startsWith('RIFF')) kind = 'WAV/AVI';
  else if (ascii.startsWith('ID3') || b[0] === 0xff) kind = 'MP3';
  else if (ascii.startsWith('OggS')) kind = 'Ogg';
  else if (ascii.startsWith('fLaC')) kind = 'FLAC';
  else if (ascii.startsWith('<') || /html|xml/i.test(ascii)) kind = 'HTML/XML 文本（不是媒体！）';
  else if (ascii.startsWith('{') || ascii.startsWith('[')) kind = 'JSON 文本（不是媒体！）';
  return `${kind}，${(buf.byteLength / 1024 / 1024).toFixed(2)}MB，头字节 ${hex}`;
}

/**
 * 重采样到 16k 单声道。
 * 原来用 OfflineAudioContext 重采样：它会额外造一份 AudioBuffer（44.1k 原始 PCM）+ 渲染缓冲，
 * 每条视频多出上百 MB 的临时分配，而且离线音频上下文也会占着媒体管线。
 * 改成「盒式滤波降采样」：对每个输出样本取输入窗口的平均值，天然带低通（抗混叠），
 * 只分配一份输出数组，数值稳定，识别效果与原方案一致。
 */
function resampleMonoTo16k(mono: Float32Array, srcRate: number): Float32Array {
  if (srcRate === 16000) return mono;
  const ratio = srcRate / 16000;
  const outLen = Math.max(1, Math.floor(mono.length / ratio));
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const start = i * ratio;
    const s = Math.floor(start);
    const e = Math.min(mono.length, Math.max(s + 1, Math.ceil(start + ratio)));
    let sum = 0;
    for (let j = s; j < e; j++) sum += mono[j];
    out[i] = sum / (e - s);
  }
  return out;
}

/**
 * 复用一个 AudioContext 来解码。
 * 实测：每次 new AudioContext()，Chrome 的媒体管线会新起一个渲染进程，
 * 那份解码缓冲不还给系统——连转 3 条视频，Edge 内存从 1.0GB 涨到 2.1GB。
 * 复用一个上下文，媒体管线也复用，内存就不再逐条累加。
 */
let sharedCtx: AudioContext | null = null;
function getAudioContext(): AudioContext {
  if (!sharedCtx || sharedCtx.state === 'closed') sharedCtx = new AudioContext();
  return sharedCtx;
}

/** 路径 1：decodeAudioData（快） */
async function decodeViaAudioContext(arrayBuffer: ArrayBuffer): Promise<{ samples: Float32Array; durationMs: number }> {
  const ctx = getAudioContext();
  let mono: Float32Array;
  let srcRate: number;
  let durationMs: number;
  try {
    // decodeAudioData 会“吞掉”传入的 buffer，这里传副本，失败后还能走兜底
    const audioBuf = await ctx.decodeAudioData(arrayBuffer.slice(0));
    srcRate = audioBuf.sampleRate;
    const srcLen = audioBuf.length;
    durationMs = audioBuf.duration * 1000;
    mono = new Float32Array(srcLen);
    for (let c = 0; c < audioBuf.numberOfChannels; c++) {
      const data = audioBuf.getChannelData(c);
      for (let i = 0; i < srcLen; i++) mono[i] += data[i] / audioBuf.numberOfChannels;
    }
    // audioBuf 出了作用域就能被回收：重采样时不必同时留着原始 PCM（10 分钟音频约 70MB）
  } catch (e) {
    void ctx.close();
    throw e;
  }
  // 上下文不关：关掉再新建会让 Chrome 的媒体管线另起渲染进程，内存反而逐条累加
  return {
    samples: resampleMonoTo16k(mono, srcRate),
    durationMs,
  };
}

/** 路径 2：<audio> 播放抓取（实时速度，兜底 decodeAudioData 不认的容器/编码） */
async function decodeViaPlayback(arrayBuffer: ArrayBuffer): Promise<{ samples: Float32Array; durationMs: number }> {
  const url = URL.createObjectURL(new Blob([arrayBuffer]));
  try {
    const audio = new Audio();
    audio.src = url;
    const ctx = new AudioContext();
    const srcNode = ctx.createMediaElementSource(audio);
    const proc = ctx.createScriptProcessor(4096, 1, 1);
    const gain = ctx.createGain();
    gain.gain.value = 0; // 静音播放
    const chunks: Float32Array[] = [];
    let captured = 0;
    proc.onaudioprocess = (e) => {
      chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
      captured += e.inputBuffer.length;
      // 播放抓取是实时的，给界面报个进度
      if (chunks.length % 16 === 0 && lastVideoId >= 0) {
        chrome.runtime.sendMessage({
          type: 'asr:progress',
          payload: {
            videoId: lastVideoId,
            secondsDone: Math.round(captured / ctx.sampleRate),
            secondsTotal: Math.round((audio.duration || 0)),
          },
        }).catch(() => {});
      }
    };
    srcNode.connect(proc);
    proc.connect(gain);
    gain.connect(ctx.destination);

    await new Promise<void>((resolve, reject) => {
      audio.onended = () => resolve();
      audio.onerror = () => reject(new Error('音频元素无法播放该文件'));
      void audio.play().catch(reject);
    });

    const srcRate = ctx.sampleRate;
    proc.disconnect(); srcNode.disconnect(); gain.disconnect();
    await ctx.close();

    const total = chunks.reduce((a, c) => a + c.length, 0);
    const mono = new Float32Array(total);
    let off = 0;
    for (const c of chunks) { mono.set(c, off); off += c.length; }
    return {
      samples: resampleMonoTo16k(mono, srcRate),
      durationMs: (total / srcRate) * 1000,
    };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** 解码主入口：先快路径，失败走播放兜底，错误信息带格式诊断 */
async function decodeTo16kMono(
  arrayBuffer: ArrayBuffer,
  allowPlaybackFallback = true,
): Promise<{ samples: Float32Array; durationMs: number }> {
  const info = sniff(arrayBuffer);
  console.log('[tiktrans] 音频嗅探：', info);
  if (arrayBuffer.byteLength < 1024) {
    throw new Error(`下载到的音频太小（${info}），多半是防盗链/验证页，请点「重试」重新下载`);
  }
  if (/文本（不是媒体/.test(info)) {
    throw new Error(`下载到的不是媒体文件（${info}），多半是防盗链/验证页，请点「重试」重新下载`);
  }
  try {
    return await decodeViaAudioContext(arrayBuffer);
  } catch (e1) {
    console.warn('[tiktrans] decodeAudioData 失败，尝试播放兜底', e1);
    if (!allowPlaybackFallback) {
      throw new Error(`音频解码失败（${info}）：${String(e1).slice(0, 80)}`);
    }
    try {
      return await decodeViaPlayback(arrayBuffer);
    } catch (e2) {
      throw new Error(`音频解码失败（${info}）。快速解码：${String(e1).slice(0, 80)}；播放兜底：${String(e2).slice(0, 80)}`);
    }
  }
}

const hostOf = (u: string): string => {
  try { return new URL(u).host; } catch { return u.slice(0, 40); }
};

/** 波形统计：峰值/均方根/NaN 数——用来判断「解出来的是不是静音」 */
function waveStats(d: Float32Array): { peak: number; rms: number; nan: number; len: number } {
  let peak = 0, sum = 0, n = 0, nan = 0;
  for (let i = 0; i < d.length; i += 13) {
    const v = d[i];
    if (!Number.isFinite(v)) { nan++; continue; }
    const a = Math.abs(v);
    if (a > peak) peak = a;
    sum += v * v; n++;
  }
  return { peak: +peak.toFixed(4), rms: +Math.sqrt(sum / Math.max(1, n)).toFixed(4), nan, len: d.length };
}

/** 用 Range 请求探文件总大小（只取 1 字节，拿到 Content-Range 里的总长） */
async function probeSize(url: string): Promise<number> {
  try {
    const resp = await fetch(url, { headers: { Range: 'bytes=0-0' }, credentials: 'include' });
    if (!resp.ok && resp.status !== 206) return 0;
    const cr = resp.headers.get('content-range');     // bytes 0-0/123456
    if (cr) {
      const total = Number(cr.split('/')[1] ?? 0);
      if (total > 0) return total;
    }
    const len = Number(resp.headers.get('content-length') ?? 0);
    return len > 1 ? len : 0;
  } catch {
    return 0;
  }
}

/**
 * 取可解码的音频：
 * 1) 先试已下载好的那份；
 * 2) 解不了就换下一个候选地址（抖音同一条作品有多份镜像，
 *    `/play/dash/` 那份 HTTP 200 但浏览器解不出音轨，必须逐个试到成功）。
 *
 * 长视频优化：先用 Range 探各候选的体积，**从体积小的先试**——
 * 抖音的纯音轨（media-audio）通常只有视频体积的 1/10，
 * 长视频靠它能显著少下载、少占解码内存；再用「解码时长是否与视频时长吻合」把关，
 * 防止拿到的是另一段（原声片段）音轨。
 */
async function loadDecodableAudio(videoId: number): Promise<{ samples: Float32Array; durationMs: number; from: string }> {
  const rec = await db.media.get(videoId);
  if (rec?.blob) {
    const buf = await rec.blob.arrayBuffer();
    try {
      const r = await decodeTo16kMono(buf);
      const st = waveStats(r.samples);
      console.log('[tiktrans] 解码统计（已下载文件）', JSON.stringify({ ...st, bytes: buf.byteLength, ms: Math.round(r.durationMs) }));
      if (st.peak < 0.005) {
        // 解出来是静音——换候选地址（同一作品有多份镜像，有的是纯音乐/空音轨）
        console.warn('[tiktrans] 已下载文件是静音，换候选地址');
      } else {
        return { ...r, from: '已下载文件' };
      }
    } catch (e: any) {
      console.warn('[tiktrans] 已下载的这份解不出音频，换候选地址：', String(e?.message ?? e).slice(0, 120));
    }
  }

  const v = await db.videos.get(videoId);
  const cands = (v?.mediaUrls ?? []).filter((u) => /^https?:/i.test(u));
  const expectMs = v?.durationMs ?? 0;

  // 探体积：小的优先（长视频靠纯音轨省流量）；探不到就按原顺序
  const sized = await Promise.all(cands.slice(0, 10).map(async (u) => ({ u, size: await probeSize(u) })));
  sized.sort((a, b) => (a.size && b.size ? a.size - b.size : a.size ? -1 : b.size ? 1 : 0));
  const order = sized.map((x) => x.u);
  console.log('[tiktrans] 候选体积（MB）', JSON.stringify(sized.map((x) => ({ host: hostOf(x.u), mb: x.size ? +(x.size / 1048576).toFixed(1) : 0 }))));

  /** 带进度回报的下载（大文件让界面能看到在动） */
async function fetchWithProgress(url: string, videoId: number): Promise<ArrayBuffer> {
  const resp = await fetch(url, { credentials: 'include' });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const total = Number(resp.headers.get('content-length') ?? 0);
  if (!resp.body || total <= 0) return resp.arrayBuffer();
  const reader = resp.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    chunks.push(value);
    loaded += value.length;
    chrome.runtime.sendMessage({
      type: 'asr:download-progress',
      payload: { videoId, loaded, total },
    }).catch(() => {});
  }
  const merged = new Uint8Array(loaded);
  let off = 0;
  for (const c of chunks) { merged.set(c, off); off += c.length; }
  return merged.buffer;
}

  const notes: string[] = [];
  for (const u of order) {
    try {
      const buf = await fetchWithProgress(u, videoId);
      // 候选循环里只用快速解码：播放兜底是实时速度，197 秒的音频要等 197 秒
      const r = await decodeTo16kMono(buf, false);
      const st = waveStats(r.samples);
      if (st.peak < 0.005) { notes.push(`${hostOf(u)}:静音`); continue; }
      // 时长对不上 → 不是这条作品的完整音轨（例如只下到了原声片段），换下一个
      if (expectMs > 0 && Math.abs(r.durationMs - expectMs) > expectMs * 0.15) {
        notes.push(`${hostOf(u)}:时长不符(${Math.round(r.durationMs / 1000)}s≠${Math.round(expectMs / 1000)}s)`);
        continue;
      }
      console.log(`[tiktrans] 候选地址可用：${hostOf(u)}（${(buf.byteLength / 1024 / 1024).toFixed(1)}MB，${JSON.stringify(st)}）`);
      try {
        await db.media.put({
          videoId,
          blob: new Blob([buf], { type: 'audio/mp4' }),
          mime: 'audio/mp4',
          size: buf.byteLength,
          savedAt: Date.now(),
        });
      } catch { /* 存不进去不影响本次转写 */ }
      return { ...r, from: `候选地址 ${hostOf(u)}` };
    } catch (e: any) {
      notes.push(`${hostOf(u)}:${String(e?.message ?? e).slice(0, 50)}`);
    }
  }
  throw new Error(`所有候选地址都取不到可解码的音频（${notes.slice(0, 4).join('；') || '没有候选地址'}）`);
}

// ---------- 消息 ----------
let selftestResolve: ((r: { ok: boolean; detail: string }) => void) | null = null;

chrome.runtime.onMessage.addListener((msg: any, _sender, sendResponse) => {
  if (msg?.type === 'offscreen:selftest') {
    // 引擎自检必须在识别 Worker 里跑（importScripts 只在 Worker 有）
    void (async () => {
      try {
        const w = getWorker();
        const result = await new Promise<{ ok: boolean; detail: string }>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('自检 60 秒未返回')), 60_000);
          selftestResolve = (r) => { clearTimeout(timer); resolve(r); };
          w.postMessage({ type: 'asr:selftest' });
        });
        sendResponse(result);
      } catch (e: any) {
        sendResponse({ ok: false, detail: String(e?.message ?? e) });
      } finally {
        selftestResolve = null;
      }
    })();
    return true;
  }
  if (msg?.type === 'diag:cache-inner') {
    void (async () => {
      try {
        const names = await caches.keys();
        const out: Record<string, string[]> = {};
        for (const n of names) out[n] = (await (await caches.open(n)).keys()).map((r) => r.url);
        sendResponse({ ok: true, out });
      } catch (e: any) {
        sendResponse({ ok: false, detail: String(e?.message ?? e) });
      }
    })();
    return true;
  }
  if (msg?.type !== 'offscreen:transcribe') return;
  void (async () => {
    try {
      const { videoId } = msg.payload;
      lastVideoId = videoId;
      const { samples, durationMs, from } = await loadDecodableAudio(videoId);
      console.log(`[tiktrans] 音频就绪（${from}）：${(durationMs / 1000).toFixed(1)}s`);
      getWorker().postMessage(
        { type: 'asr:run', payload: { videoId, samples, durationMs } },
        [samples.buffer],
      );
      sendResponse({ ok: true });
    } catch (e: any) {
      chrome.runtime.sendMessage({
        type: 'offscreen:transcribe-result',
        payload: { videoId: msg.payload.videoId, error: String(e?.message ?? e) },
      }).catch(() => {});
      sendResponse({ ok: false });
    }
  })();
  return true;
});

export type { AsrSegment };
