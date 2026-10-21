// 识别参数 A/B：真实抖音口播音频（real16k.wav），比较不同解码参数的输出
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const engineDir = path.join(root, 'dist', 'engine');
const sm = path.join(root, 'node_modules', '.smoke');

// ---- WAV 读取 ----
function parseWav(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let off = 12, fmt = null, dataOff = -1, dataLen = 0;
  while (off + 8 <= buf.length) {
    const id = String.fromCharCode(buf[off], buf[off + 1], buf[off + 2], buf[off + 3]);
    const size = dv.getUint32(off + 4, true);
    if (id === 'fmt ') fmt = { channels: dv.getUint16(off + 10, true), rate: dv.getUint32(off + 12, true), bits: dv.getUint16(off + 22, true) };
    if (id === 'data') { dataOff = off + 8; dataLen = size; }
    off += 8 + size + (size % 2);
  }
  const n = Math.floor(dataLen / (fmt.bits / 8));
  const s = new Float32Array(n / fmt.channels);
  for (let i = 0; i < s.length; i++) {
    let acc = 0;
    for (let c = 0; c < fmt.channels; c++) acc += dv.getInt16(dataOff + (i * fmt.channels + c) * 2, true) / 32768;
    s[i] = acc / fmt.channels;
  }
  return s;
}

const wav = parseWav(readFileSync(path.join(sm, 'real16k.wav')));
console.log(`音频：${(wav.length / 16000).toFixed(1)} 秒`);

const modelBytes = readFileSync(path.join(sm, 'model.int8.onnx'));
const tokensBytes = readFileSync(path.join(sm, 'tokens.txt'));
const vadBytes = readFileSync(path.join(sm, 'silero_vad.onnx'));

// ---- 引擎沙箱 ----
const wasmBytes = readFileSync(path.join(engineDir, 'sherpa-onnx-wasm-main-vad-asr.wasm'));
let runtimeReady = false;
const sandbox = {
  console, setTimeout, clearTimeout, setInterval, clearInterval, performance,
  TextDecoder, TextEncoder, Blob, URL, atob, btoa, WebAssembly, Date, Math, JSON, Promise,
  Uint8Array, Float32Array, ArrayBuffer, DataView, Object, Array, Error, String, Number,
  navigator: { userAgent: 'smoke' },
  location: { href: 'chrome-extension://smoke/offscreen/asr-worker.js', pathname: '/offscreen/asr-worker.js' },
  fetch: async () => ({
    ok: true, status: 200,
    arrayBuffer: async () => wasmBytes.buffer.slice(wasmBytes.byteOffset, wasmBytes.byteOffset + wasmBytes.byteLength),
    json: async () => ({}),
  }),
  XMLHttpRequest: class { open() {} send() {} setRequestHeader() {} },
  importScripts: () => { throw new Error('直接 runInContext'); },
};
sandbox.self = sandbox; sandbox.globalThis = sandbox;
sandbox.Module = {
  locateFile: (f) => f,
  getPreloadedPackage: () => new ArrayBuffer(0),
  onRuntimeInitialized: () => { runtimeReady = true; },
  setStatus: () => {},
};
vm.createContext(sandbox);
const load = (f) => vm.runInContext(readFileSync(path.join(engineDir, f), 'utf-8'), sandbox, { filename: f });
load('sherpa-onnx-asr.js'); load('sherpa-onnx-vad.js'); load('sherpa-onnx-wasm-main-vad-asr.js');
const t0 = Date.now();
while (!runtimeReady && Date.now() - t0 < 60000) await new Promise((r) => setTimeout(r, 50));

const M = sandbox.Module;
M.FS_createDataFile('/', 'model.int8.onnx', new Uint8Array(modelBytes), true, true, true);
M.FS_createDataFile('/', 'tokens.txt', new Uint8Array(tokensBytes), true, true, true);
M.FS_createDataFile('/', 'silero_vad.onnx', new Uint8Array(vadBytes), true, true, true);

// ---- VAD 切段（与扩展一致）----
const vad = sandbox.createVad(M, {
  sileroVad: { model: '/silero_vad.onnx', threshold: 0.5, minSilenceDuration: 0.5, minSpeechDuration: 0.25, windowSize: 512, maxSpeechDuration: 20 },
  sampleRate: 16000, numThreads: 1, provider: 'cpu', debug: 0, bufferSizeInSeconds: 30,
});
const pad = new Float32Array(Math.ceil(wav.length / 512) * 512);
pad.set(wav);
const segs = [];
const emit = () => { while (!vad.isEmpty()) { const s = vad.front(); segs.push(s.samples.slice()); vad.pop(); } };
for (let off = 0; off < pad.length; off += 512) { vad.acceptWaveform(pad.subarray(off, off + 512)); emit(); }
vad.flush(); emit();
console.log(`VAD 切出 ${segs.length} 段\n`);

const clean = (s) => s.replace(/<\|[^|]*\|>/g, '').trim();

/** 跑一次识别 */
function run(name, cfg, senseCfg) {
  const rec = new sandbox.OfflineRecognizer({
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      tokens: '/tokens.txt', numThreads: 1, provider: 'cpu', debug: 0, modelType: '',
      senseVoice: { model: '/model.int8.onnx', language: '', useInverseTextNormalization: 1, ...(senseCfg ?? {}) },
    },
    ...cfg,
  }, M);
  const t = Date.now();
  let text = '';
  for (const s of segs) {
    const st = rec.createStream();
    st.acceptWaveform(16000, s);
    rec.decode(st);
    text += clean(rec.getResult(st)?.text ?? '');
    st.free();
  }
  const ms = Date.now() - t;
  console.log(`【${name}】${ms}ms  ${text.length}字`);
  return { name, text, ms };
}

const runs = [
  run('A 现状 language=自动', { decodingMethod: 'greedy_search', maxActivePaths: 4 }),
  run('B language=zh', { decodingMethod: 'greedy_search', maxActivePaths: 4 }, { language: 'zh' }),
];

// ---- 差异对比（以 A 为基准）----
function diff(a, b) {
  const la = [...a];
  const lb = [...b];
  let same = 0;
  for (let i = 0; i < Math.min(la.length, lb.length); i++) if (la[i] === lb[i]) same++;
  return { 相同率: (same / Math.max(la.length, lb.length) * 100).toFixed(1) + '%' };
}
console.log('\n=== 与现状的差异 ===');
for (const r of runs.slice(1)) {
  console.log(`${r.name} vs A：${diff(runs[0].text, r.text).相同率}`);
  // 打印前 6 处不同
  const A = runs[0].text, B = r.text;
  let shown = 0;
  for (let i = 0; i < Math.min(A.length, B.length) && shown < 6; i++) {
    if (A[i] !== B[i]) {
      console.log(`  位置${i}：现状「${A.slice(Math.max(0, i - 6), i + 6)}」 → 新「${B.slice(Math.max(0, i - 6), i + 6)}」`);
      shown++;
    }
  }
}
console.log('\n=== A 全文 ===\n' + runs[0].text);
console.log('\n=== B 全文 ===\n' + runs[1].text);
