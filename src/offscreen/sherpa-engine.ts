// sherpa-onnx WebAssembly 引擎适配（Silero VAD + SenseVoice int8）
// 产物：public/engine/ → dist/engine/（官方 wasm/vad-asr 构建，Apache-2.0）
//   - sherpa-onnx-asr.js / sherpa-onnx-vad.js：JS 封装（全局函数 createVad / OfflineRecognizer 等）
//   - sherpa-onnx-wasm-main-vad-asr.js / .wasm：emscripten 胶水（全局 Module，非 MODULARIZE）
// 构建时已把胶水里的预载 .data 元数据清空（原包含 moonshine 模型，44.9MB 死重 + 商用许可受限），
// 模型文件全部在运行时从 IndexedDB 注入 Emscripten 虚拟文件系统（FS_createDataFile）。
import { checkModelIntegrity, readModelFile, type ModelFileKey } from '../core/models';
import type { TokenTuple } from '../core/types';

export interface VadSegment {
  startMs: number;
  endMs: number;
  samples: Float32Array;
}

export interface RecognizeResult {
  text: string;
  /** [词元, 相对段起点的开始毫秒, 相对段起点的结束毫秒] */
  tokens: TokenTuple[];
}

export interface AsrEngine {
  segment(samples: Float32Array): VadSegment[];
  recognize(seg: Float32Array): RecognizeResult;
}

const ENGINE_DIR = '../engine/';
const SAMPLE_RATE = 16000;
const WINDOW_SIZE = 512; // Silero VAD 喂入必须按 512 样本对齐（32ms @16k）

const urlOf = (file: string) => new URL(ENGINE_DIR + file, (self as any).location.href).href;

// sherpa-onnx 的 JS 封装以「脚本级声明」暴露 API（importScripts 后以裸标识符可见；
// class 声明不会挂到 self 上，所以不能写 self.OfflineRecognizer，只能裸引用）
declare const createVad: (Module: any, config?: any) => any;
declare const OfflineRecognizer: new (config: any, Module: any) => any;

/** 扩展自带的模型文件（离线包里有 model/ 目录时直接用，不用下载） */
const BUNDLED_FILES: Record<ModelFileKey, string> = {
  model: 'model/sense-voice.onnx',
  tokens: 'model/tokens.txt',
  vad: 'model/silero_vad.onnx',
};

async function readModel(key: ModelFileKey): Promise<Uint8Array> {
  // ① 先问宿主（离屏文档）：它依次尝试「扩展自带 → IndexedDB → 后台」
  //    注意 Worker 里没有 chrome 对象（读不到扩展自带文件），所以必须走宿主
  const fromHost = await requestModelFromHost(key);
  if (fromHost) {
    const buf = new Uint8Array(fromHost);
    const minBytes = key === 'model' ? 150 * 1024 * 1024 : 1024;
    if (buf.byteLength >= minBytes) return buf;
  }
  // ② 兜底：自己从 IndexedDB 读（先查完整性：残缺模型会让 wasm 直接 abort）
  const minBytes = key === 'model' ? 150 * 1024 * 1024 : 1024;
  const bad = await checkModelIntegrity(key, minBytes);
  if (bad) throw new Error(bad);
  const buf = await readModelFile(key);
  if (buf) return new Uint8Array(buf);
  throw new Error('模型文件缺失，请先在首次引导/设置里下载语音模型');
}

function fromHost2Uint8(x: ArrayBuffer): Uint8Array {
  return new Uint8Array(x);
}

/** 向离屏文档（再由它向后台）要模型字节 */
function requestModelFromHost(key: ModelFileKey): Promise<ArrayBuffer | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 120_000);
    const onMsg = (ev: MessageEvent) => {
      if (ev.data?.type === 'asr:model-bytes' && ev.data.payload?.key === key) {
        clearTimeout(timer);
        self.removeEventListener('message', onMsg);
        resolve((ev.data.payload.bytes as ArrayBuffer) ?? null);
      }
    };
    self.addEventListener('message', onMsg);
    self.postMessage({ type: 'asr:need-model', key });
  });
}

let enginePromise: Promise<AsrEngine> | null = null;
let glueReady: Promise<void> | null = null;
let initCount = 0;
/** 已经注入 wasm 虚拟文件系统的模型文件（避免重复注入导致 wasm 内存暴涨） */
const injectedFiles = new Set<string>();

/** 引擎状态诊断：wasm 内存多大、初始化过几次（用于排查内存增长） */
export function engineStats(): { initCount: number; wasmMB: number; hasEngine: boolean } {
  const heap = (self as any).Module?.HEAPU8;
  return {
    initCount,
    wasmMB: heap ? Math.round((heap.byteLength / 1048576) * 10) / 10 : 0,
    hasEngine: !!enginePromise,
  };
}

export function getEngine(): Promise<AsrEngine> {  if (!enginePromise) {
    enginePromise = initEngine().catch((e) => {
      console.error('[tiktrans] 引擎初始化失败（保留现场，下次重试只重做模型注入）:', e);
      // wasm 原生崩溃时 e.message 是裸数字（指针），转成人话
      const raw = String(e?.message ?? e);
      const err = /^\d+$/.test(raw)
        ? new Error(`识别引擎原生崩溃（wasm abort，指针 ${raw}）——通常是内存不足或模型损坏`)
        : e;
      enginePromise = null; // 失败不缓存：修好问题（如下完模型）后重试可重新初始化
      throw err;
    });
  }
  return enginePromise;
}

/**
 * 胶水/封装加载（每个 Worker 只做一次）：
 * 封装脚本已在构建时包成 IIFE（同名顶层声明互不冲突），API 挂在 self 上。
 * 重试初始化时不得重复 importScripts（否则会撞 "already been declared"）。
 */
function loadGlueOnce(): Promise<void> {
  if (glueReady) return glueReady;
  const g = self as any;
  glueReady = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error('识别引擎 wasm 60 秒未初始化完成（dist/engine/ 的 .wasm 是否完整？）')),
      60_000,
    );
    g.Module = {
      locateFile: (file: string) => urlOf(file),
      // 拦掉对 .data 预载包的 fetch（构建时元数据已清空；注意胶水要求返回 ArrayBuffer）
      getPreloadedPackage: () => new ArrayBuffer(0),
      onRuntimeInitialized: () => { clearTimeout(timeout); resolve(); },
      setStatus: (s: string) => console.log('[sherpa]', s),
    };
    try {
      (self as any).importScripts(urlOf('sherpa-onnx-asr.js'));
      (self as any).importScripts(urlOf('sherpa-onnx-vad.js'));
      (self as any).importScripts(urlOf('sherpa-onnx-wasm-main-vad-asr.js'));
    } catch (e: any) {
      clearTimeout(timeout);
      reject(new Error(`识别引擎产物加载失败（dist/engine/）：${String(e?.message ?? e)}`));
    }
  });
  return glueReady;
}

async function initEngine(): Promise<AsrEngine> {
  const g = self as any;
  initCount++;
  console.log(`[tiktrans] 引擎初始化 #${initCount}`);

  await loadGlueOnce();
  const Module = g.Module as any;
  if (typeof createVad !== 'function' || typeof OfflineRecognizer !== 'function') {
    throw new Error('识别引擎 JS 封装未暴露 createVad / OfflineRecognizer');
  }

  // 2) 模型注入虚拟文件系统
  //    注意：wasm 的线性内存只增不减——每重新注入一次 228MB 的模型，内存就多占 228MB，
  //    而且永远不还给操作系统。所以注入必须「幂等」：文件已在虚拟文件系统里就跳过。
  const inject = (name: string, data: Uint8Array) => {
    if (injectedFiles.has(name)) return;      // 已注入过，不再重复灌
    try {
      Module.FS_createDataFile('/', name, data, true, true, true);
    } catch (e: any) {
      // 已存在则覆盖写
      try { Module.FS_unlink(`/${name}`); } catch { /* 忽略 */ }
      Module.FS_createDataFile('/', name, data, true, true, true);
    }
    injectedFiles.add(name);
  };
  const [model, tokens, vad] = await Promise.all([
    readModel('model'), readModel('tokens'), readModel('vad'),
  ]);
  inject('sense-voice.onnx', model);
  inject('tokens.txt', tokens);
  inject('silero_vad.onnx', vad);

  // 3) 创建 VAD + SenseVoice 识别器
  const vadInst = createVad(Module, {
    sileroVad: {
      model: '/silero_vad.onnx',
      threshold: 0.5,
      minSilenceDuration: 0.5,     // 单位：秒
      minSpeechDuration: 0.25,     // 单位：秒
      windowSize: WINDOW_SIZE,
      maxSpeechDuration: 20,
    },
    sampleRate: SAMPLE_RATE,
    numThreads: 1,
    provider: 'cpu',
    debug: 0,
    bufferSizeInSeconds: 30,
  });

  const recognizer = new OfflineRecognizer({
    featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
    modelConfig: {
      tokens: '/tokens.txt',
      numThreads: 1,
      provider: 'cpu',
      debug: 0,
      modelType: '',
      senseVoice: {
        model: '/sense-voice.onnx',
        language: '',                       // '' = 自动检测
        useInverseTextNormalization: 1,     // 开 ITN：带标点、数字归一化
      },
    },
    decodingMethod: 'greedy_search',
    maxActivePaths: 4,
  }, Module);

  // 4) 引擎实现
  const segment = (samples: Float32Array): VadSegment[] => {
    const out: VadSegment[] = [];
    const emit = () => {
      while (!vadInst.isEmpty()) {
        const seg = vadInst.front();
        const startMs = (seg.start / SAMPLE_RATE) * 1000;
        const endMs = startMs + (seg.samples.length / SAMPLE_RATE) * 1000;
        out.push({ startMs, endMs, samples: seg.samples.slice() });
        vadInst.pop();
      }
    };
    try { vadInst.reset(); } catch { /* 忽略 */ }
    // 按 windowSize 对齐喂入（尾部补零）
    const n = samples.length;
    const padded = new Float32Array(Math.ceil(n / WINDOW_SIZE) * WINDOW_SIZE);
    padded.set(samples);
    for (let off = 0; off < padded.length; off += WINDOW_SIZE) {
      vadInst.acceptWaveform(padded.subarray(off, off + WINDOW_SIZE));
      emit();
    }
    // 语音延续到音频结尾时段还压在缓冲里（后面没有静音触发收尾）：flush 强制产出
    try { vadInst.flush(); } catch { /* 忽略 */ }
    emit();
    return out;
  };

  const recognize = (segSamples: Float32Array): RecognizeResult => {
    const stream = recognizer.createStream();
    try {
      stream.acceptWaveform(SAMPLE_RATE, segSamples);
      recognizer.decode(stream);
      const r = recognizer.getResult(stream);
      const text: string = r?.text ?? '';
      const tokTexts: string[] = Array.isArray(r?.tokens) ? r.tokens : [];
      const tsSec: number[] = Array.isArray(r?.timestamps) ? r.timestamps : [];
      const durMs = (segSamples.length / SAMPLE_RATE) * 1000;
      const tokens: TokenTuple[] = tokTexts.map((t, i) => {
        const startMs = (tsSec[i] ?? 0) * 1000;
        const nextMs = i + 1 < tsSec.length ? (tsSec[i + 1] * 1000) : durMs;
        return [t, startMs, Math.max(startMs + 1, nextMs)] as TokenTuple;
      });
      return { text, tokens };
    } finally {
      try { stream.free(); } catch { /* 忽略 */ }
    }
  };

  return { segment, recognize };
}
