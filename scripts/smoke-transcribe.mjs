// 识别全链路真跑（Node + vm 模拟 Worker）：真 SenseVoice 模型 + 官方测试音频 zh.wav
// 用法：node scripts/smoke-transcribe.mjs
// 覆盖：封装脚本（IIFE 包装后）→ 胶水启动 → 模型注入 VFS → VAD 切段 → SenseVoice 识别 → tokens/timestamps
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const engineDir = path.join(root, 'dist', 'engine');
const sm = path.join(root, 'node_modules', '.smoke');

for (const f of ['model.int8.onnx', 'tokens.txt', 'zh.wav', 'silero_vad.onnx']) {
  if (!existsSync(path.join(sm, f))) throw new Error(`缺 ${f}（先准备 node_modules/.smoke/）`);
}
const modelBytes = readFileSync(path.join(sm, 'model.int8.onnx'));
const tokensBytes = readFileSync(path.join(sm, 'tokens.txt'));
const vadBytes = readFileSync(path.join(sm, 'silero_vad.onnx'));
console.log(`[t] 模型 ${(modelBytes.length / 1024 / 1024).toFixed(0)}MB, vad ${(vadBytes.length / 1024).toFixed(0)}KB`);

// ---- WAV 解析（PCM16）----
function parseWav(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (dv.getUint32(0, false) !== 0x52494646) throw new Error('不是 RIFF/WAV');
  let off = 12, fmt = null, dataOff = -1, dataLen = 0;
  while (off + 8 <= buf.length) {
    const id = String.fromCharCode(buf[off], buf[off + 1], buf[off + 2], buf[off + 3]);
    const size = dv.getUint32(off + 4, true);
    if (id === 'fmt ') fmt = { channels: dv.getUint16(off + 10, true), rate: dv.getUint32(off + 12, true), bits: dv.getUint16(off + 22, true) };
    if (id === 'data') { dataOff = off + 8; dataLen = size; }
    off += 8 + size + (size % 2);
  }
  if (!fmt || dataOff < 0) throw new Error('WAV 头不完整');
  const n = Math.floor(dataLen / (fmt.bits / 8));
  const samples = new Float32Array(n / fmt.channels);
  for (let i = 0; i < samples.length; i++) {
    let acc = 0;
    for (let c = 0; c < fmt.channels; c++) {
      const idx = i * fmt.channels + c;
      acc += fmt.bits === 16 ? dv.getInt16(dataOff + idx * 2, true) / 32768 : dv.getFloat32(dataOff + idx * 4, true);
    }
    samples[i] = acc / fmt.channels;
  }
  return { samples, rate: fmt.rate };
}

const wav = parseWav(readFileSync(path.join(sm, 'zh.wav')));
console.log(`[t] zh.wav：${(wav.samples.length / wav.rate).toFixed(2)} 秒 @ ${wav.rate}Hz`);

// ---- Worker 风格沙箱（同 smoke-engine）----
const wasmBytes = readFileSync(path.join(engineDir, 'sherpa-onnx-wasm-main-vad-asr.wasm'));
let runtimeReady = false;
const sandbox = {
  console, setTimeout, clearTimeout, setInterval, clearInterval,
  performance, TextDecoder, TextEncoder, Blob, URL, atob, btoa,
  WebAssembly, Date, Math, JSON, Promise, Uint8Array, Float32Array, ArrayBuffer, DataView, Object, Array, Error, String, Number,
  navigator: { userAgent: 'smoke' },
  location: { href: 'chrome-extension://smoke/offscreen/asr-worker.js', pathname: '/offscreen/asr-worker.js' },
  fetch: async () => ({
    ok: true, status: 200,
    arrayBuffer: async () => wasmBytes.buffer.slice(wasmBytes.byteOffset, wasmBytes.byteOffset + wasmBytes.byteLength),
    json: async () => ({}),
  }),
  XMLHttpRequest: class { open() {} send() {} setRequestHeader() {} },
  importScripts: () => { throw new Error('smoke 直接 runInContext 加载脚本'); },
};
sandbox.self = sandbox;
sandbox.globalThis = sandbox;
sandbox.Module = {
  locateFile: (f) => f,
  getPreloadedPackage: () => new ArrayBuffer(0),
  onRuntimeInitialized: () => { runtimeReady = true; },
  setStatus: (s) => console.log('[sherpa]', s),
};
vm.createContext(sandbox);

const load = (f) => vm.runInContext(readFileSync(path.join(engineDir, f), 'utf-8'), sandbox, { filename: f });
load('sherpa-onnx-asr.js');   // IIFE 包装版
load('sherpa-onnx-vad.js');   // IIFE 包装版
load('sherpa-onnx-wasm-main-vad-asr.js');

const t0 = Date.now();
while (!runtimeReady && Date.now() - t0 < 60000) await new Promise((r) => setTimeout(r, 50));
if (!runtimeReady) throw new Error('runtime 初始化超时');
console.log(`[t] runtime OK（${Date.now() - t0}ms）`);

const M = sandbox.Module;
M.FS_createDataFile('/', 'model.int8.onnx', new Uint8Array(modelBytes), true, true, true);
M.FS_createDataFile('/', 'tokens.txt', new Uint8Array(tokensBytes), true, true, true);
M.FS_createDataFile('/', 'silero_vad.onnx', new Uint8Array(vadBytes), true, true, true);
console.log('[t] 模型注入 VFS OK');

// ---- VAD 切段 ----
const createVad = sandbox.createVad;
const OfflineRecognizer = sandbox.OfflineRecognizer;
if (typeof createVad !== 'function' || typeof OfflineRecognizer !== 'function') {
  throw new Error(`封装 API 缺失：createVad=${typeof createVad}, OfflineRecognizer=${typeof OfflineRecognizer}`);
}
console.log('[t] 封装 API 就绪（IIFE 导出 ✓）');

const vad = createVad(M, {
  sileroVad: { model: '/silero_vad.onnx', threshold: 0.5, minSilenceDuration: 0.5, minSpeechDuration: 0.25, windowSize: 512, maxSpeechDuration: 20 },
  sampleRate: 16000, numThreads: 1, provider: 'cpu', debug: 0, bufferSizeInSeconds: 30,
});
const s16 = wav.samples;
const pad = new Float32Array(Math.ceil(s16.length / 512) * 512);
pad.set(s16);
const segs = [];
const emit = () => {
  while (!vad.isEmpty()) {
    const seg = vad.front();
    segs.push({ startMs: (seg.start / 16000) * 1000, samples: seg.samples.slice() });
    vad.pop();
  }
};
for (let off = 0; off < pad.length; off += 512) {
  vad.acceptWaveform(pad.subarray(off, off + 512));
  emit();
}
vad.flush(); // 结尾语音强制产出
emit();
console.log(`[t] VAD 切出 ${segs.length} 段`);

// ---- SenseVoice 识别 ----
const rec = new OfflineRecognizer({
  featConfig: { sampleRate: 16000, featureDim: 80 },
  modelConfig: {
    tokens: '/tokens.txt', numThreads: 1, provider: 'cpu', debug: 0, modelType: '',
    senseVoice: { model: '/model.int8.onnx', language: '', useInverseTextNormalization: 1 },
  },
  decodingMethod: 'greedy_search', maxActivePaths: 4,
}, M);
console.log('[t] SenseVoice 识别器创建 OK');

let full = '';
for (const seg of segs) {
  const stream = rec.createStream();
  stream.acceptWaveform(16000, seg.samples);
  rec.decode(stream);
  const r = rec.getResult(stream);
  full += r.text;
  console.log(`[t] 段 @${seg.startMs.toFixed(0)}ms：text="${r.text}" tokens=${r.tokens?.length ?? 0} timestamps=${r.timestamps?.length ?? 0} lang=${r.lang}`);
  stream.free();
}
console.log(`\n[t] 完整转写结果：${full}`);
if (!full.trim()) throw new Error('转写为空——链路有问题');
console.log('[t] 全链路真跑通过 ✅');
