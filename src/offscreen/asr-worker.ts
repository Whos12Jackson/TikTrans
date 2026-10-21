// 识别 Worker：VAD 切段 → SenseVoice 逐段识别 → 绝对时间 → 回传
// 引擎细节在 sherpa-engine.ts（sherpa-onnx WebAssembly）
import type { AsrSegment, TokenTuple } from '../core/types';
import { getEngine, engineStats } from './sherpa-engine';

const TAG_RE = /<\|[^|]*\|>/g;

function cleanText(s: string): string {
  return s.replace(TAG_RE, '').trim();
}

self.onmessage = (ev: MessageEvent) => {
  const msg = ev.data;
  if (msg?.type === 'asr:ping') {
    // 心跳：让 Chrome 不回收这个 Worker（Worker 一被回收，引擎内存就要重新分配一遍）
    self.postMessage({ type: 'asr:pong' });
  } else if (msg?.type === 'asr:run') {
    void run(msg.payload);
  } else if (msg?.type === 'asr:selftest') {
    void selftest();
  } else if (msg?.type === 'asr:debug-wav') {
    void debugWav(msg.payload);
  } else if (msg?.type === 'asr:debug-samples') {
    // 回显收到的样本结构（排查「传过去变成空对象」这类问题）
    const s = msg.payload?.samples;
    let peak = 0, nan = 0;
    if (s && typeof s.length === 'number') {
      for (let i = 0; i < s.length; i += 7) {
        const v = s[i];
        if (!Number.isFinite(v)) nan++;
        else { const a = Math.abs(v); if (a > peak) peak = a; }
      }
    }
    self.postMessage({
      type: 'asr:debug-samples-result',
      payload: { jsType: typeof s, ctor: s?.constructor?.name, len: s?.length ?? -1, peak, nan },
    });
  }
};

/** 调试口：直接识别一段 PCM（base64 的 Float32），用于在真实浏览器里验证引擎是否可用 */
async function debugWav(payload: { pcmBase64: string }): Promise<void> {
  const t0 = Date.now();
  try {
    const bin = atob(payload.pcmBase64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const samples = new Float32Array(bytes.buffer);
    const tInit = Date.now();
    const engine = await getEngine();
    const tReady = Date.now();
    const segs = engine.segment(samples);
    let text = '';
    for (const s of segs) text += engine.recognize(s.samples).text;
    self.postMessage({
      type: 'asr:debug-wav-result',
      payload: {
        ok: true, text, segs: segs.length, samples: samples.length,
        msInit: tReady - tInit, msTotal: Date.now() - t0,
        env: {
          crossOriginIsolated: (self as any).crossOriginIsolated,
          hasSAB: typeof SharedArrayBuffer !== 'undefined',
          hardwareConcurrency: (self as any).navigator?.hardwareConcurrency,
        },
      },
    });
  } catch (e: any) {
    self.postMessage({ type: 'asr:debug-wav-result', payload: { ok: false, error: String(e?.message ?? e), msTotal: Date.now() - t0 } });
  }
}

/** 引擎自检：初始化 + 1 秒静音过一遍 VAD（识别器在 init 里已创建） */
async function selftest(): Promise<void> {
  try {
    const t0 = Date.now();
    const engine = await getEngine();
    const segs = engine.segment(new Float32Array(16000));
    self.postMessage({
      type: 'asr:selftest-result',
      payload: { ok: true, detail: `引擎正常（装载+模型注入 ${Date.now() - t0}ms，1 秒静音切出 ${segs.length} 段，识别器就绪）` },
    });
  } catch (e: any) {
    self.postMessage({ type: 'asr:selftest-result', payload: { ok: false, detail: String(e?.message ?? e) } });
  }
}

let busy = false;

async function run(payload: { videoId: number; samples: Float32Array; durationMs: number }): Promise<void> {
  const { videoId, samples, durationMs } = payload;
  if (busy) {
    self.postMessage({ type: 'asr:error', payload: { videoId, error: '识别引擎正忙（上一条还没跑完）' } });
    return;
  }
  busy = true;
  try {
    // 诊断：确认收到的样本结构与波形（排查「传过来是空/静音」）
    let peak = 0, nan = 0, len = 0;
    try {
      len = samples?.length ?? -1;
      if (typeof len === 'number' && len > 0) {
        for (let i = 0; i < len; i += 97) {
          const v = samples[i];
          if (!Number.isFinite(v)) nan++;
          else { const a = Math.abs(v); if (a > peak) peak = a; }
        }
      }
    } catch { /* 忽略 */ }
    console.log('[tiktrans] 收到样本', JSON.stringify({ ctor: (samples as any)?.constructor?.name, len, peak, nan, durationMs }));

    const engine = await getEngine();

    // 1) VAD 切段（绝对时间由采样点换算：startSample / 16000 * 1000）
    const vadSegs = engine.segment(samples);
    console.log('[tiktrans] VAD 切段数', vadSegs.length, '总样本', samples?.length);

    // 2) 逐段识别
    const out: AsrSegment[] = [];
    let done = 0;
    for (const seg of vadSegs) {
      const rec = engine.recognize(seg.samples);
      const text = cleanText(rec.text);
      if (text) {
        // 词元时间：段起点 + 相对毫秒；词元结束取下一个词元开始，最后一个取段结束
        const tokens: TokenTuple[] = rec.tokens.map((tk, i) => {
          const startMs = seg.startMs + tk[1];
          const nextStart = i + 1 < rec.tokens.length ? seg.startMs + rec.tokens[i + 1][1] : seg.endMs;
          return [tk[0], startMs, Math.max(startMs + 1, nextStart)] as TokenTuple;
        });
        out.push({ startMs: seg.startMs, endMs: seg.endMs, text, tokens });
      }
      done++;
      self.postMessage({
        type: 'asr:progress',
        payload: {
          videoId,
          secondsDone: Math.round(seg.endMs / 1000),
          secondsTotal: Math.round(durationMs / 1000),
        },
      });
    }

    // 3) 按开始时间排序后回传
    out.sort((a, b) => a.startMs - b.startMs);
    self.postMessage({ type: 'asr:done', payload: { videoId, segments: out, stats: engineStats() } });
  } catch (e: any) {
    self.postMessage({ type: 'asr:error', payload: { videoId, error: String(e?.message ?? e) } });
  } finally {
    busy = false;
  }
}
