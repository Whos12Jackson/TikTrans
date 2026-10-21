// 准确率实验：分段识别 vs 整段识别（真实抖音口播音频）
// 假设：逐段独立识别缺上下文 → 同音字更易错；整段识别模型能看到上下文 → 更准
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const engineDir = path.join(root, 'dist', 'engine');
const sm = path.join(root, 'node_modules', '.smoke');

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
const modelBytes = readFileSync(path.join(sm, 'model.int8.onnx'));
const tokensBytes = readFileSync(path.join(sm, 'tokens.txt'));
const vadBytes = readFileSync(path.join(sm, 'silero_vad.onnx'));
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
  importScripts: () => { throw new Error('direct'); },
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
const emit = () => { while (!vad.isEmpty()) { const s = vad.front(); segs.push({ start: s.start, samples: s.samples.slice() }); vad.pop(); } };
for (let off = 0; off < pad.length; off += 512) { vad.acceptWaveform(pad.subarray(off, off + 512)); emit(); }
vad.flush(); emit();
console.log(`VAD：${segs.length} 段  ${(wav.length / 16000).toFixed(1)} 秒\n`);

const rec = new sandbox.OfflineRecognizer({
  featConfig: { sampleRate: 16000, featureDim: 80 },
  modelConfig: {
    tokens: '/tokens.txt', numThreads: 1, provider: 'cpu', debug: 0, modelType: '',
    senseVoice: { model: '/model.int8.onnx', language: '', useInverseTextNormalization: 1 },
  },
  decodingMethod: 'greedy_search', maxActivePaths: 4,
}, M);

const clean = (s) => s.replace(/<\|[^|]*\|>/g, '').trim();
function decode(samples) {
  const st = rec.createStream();
  st.acceptWaveform(16000, samples);
  rec.decode(st);
  const r = rec.getResult(st);
  const text = clean(r?.text ?? '');
  const toks = (r?.tokens ?? []).map((t, i) => [t, r.timestamps?.[i] ?? 0]);
  st.free();
  return { text, toks };
}

// ---- 方案A：逐段识别（现状）----
let tA = Date.now();
const A = segs.map((s) => decode(s.samples));
const textA = A.map((x) => x.text).join('');
const msA = Date.now() - tA;

// ---- 方案B：整段一次性识别 ----
let tB = Date.now();
let B = null, errB = '';
try {
  B = decode(wav);
} catch (e) { errB = String(e.message || e).slice(0, 120); }
const msB = Date.now() - tB;

console.log(`A 逐段识别：${msA}ms  ${textA.length}字`);
console.log(`B 整段识别：${msB}ms  ${B ? B.text.length + '字' : '失败：' + errB}\n`);

// ---- 关键错误点对比 ----
const probes = [
  ['美玉/美誉', /美[誉玉]/g],
  ['瓦砾/瓦丽', /瓦[砾丽力]/g],
  ['怯懦/切懦', /[怯切]懦/g],
  ['珍视/真视', /[珍真]视/g],
  ['疏离/疏联', /疏[离联]/g],
  ['这块/事快', /这[块事]|[事这]快/g],
];
for (const [name, re] of probes) {
  const a = (textA.match(re) || []).join('');
  const b = B ? (B.text.match(re) || []).join('') : '-';
  const okA = a === '美玉' || a === '瓦砾' || a === '怯懦' || a === '珍视' || a === '疏离' || a === '这块';
  const okB = b === '美玉' || b === '瓦砾' || b === '怯懦' || b === '珍视' || b === '疏离' || b === '这块';
  console.log(`${name.padEnd(12)} 现状A=${a || '-'}${okA ? '✓' : '✗'}   整段B=${b || '-'}${okB ? '✓' : '✗'}`);
}

if (B) {
  console.log('\n=== A 全文 ===\n' + textA);
  console.log('\n=== B 全文 ===\n' + B.text);
  console.log(`\nB 词元数：${B.toks.length}`);
}
