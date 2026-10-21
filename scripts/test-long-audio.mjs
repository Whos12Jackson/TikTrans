// 长视频压力测试：把真实音频循环成 10 分钟 / 20 分钟，验证 ASR 稳定性与耗时
import { readFileSync, writeFileSync } from 'node:fs';
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

const base = parseWav(readFileSync(path.join(sm, 'real16k.wav')));
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

const rec = new sandbox.OfflineRecognizer({
  featConfig: { sampleRate: 16000, featureDim: 80 },
  modelConfig: {
    tokens: '/tokens.txt', numThreads: 1, provider: 'cpu', debug: 0, modelType: '',
    senseVoice: { model: '/model.int8.onnx', language: '', useInverseTextNormalization: 1 },
  },
  decodingMethod: 'greedy_search', maxActivePaths: 4,
}, M);
const clean = (s) => s.replace(/<\|[^|]*\|>/g, '').trim();

function runOn(samples, label) {
  const vad = sandbox.createVad(M, {
    sileroVad: { model: '/silero_vad.onnx', threshold: 0.5, minSilenceDuration: 0.5, minSpeechDuration: 0.25, windowSize: 512, maxSpeechDuration: 20 },
    sampleRate: 16000, numThreads: 1, provider: 'cpu', debug: 0, bufferSizeInSeconds: 30,
  });
  const pad = new Float32Array(Math.ceil(samples.length / 512) * 512);
  pad.set(samples);
  const segs = [];
  const emit = () => { while (!vad.isEmpty()) { const s = vad.front(); segs.push(s.samples.slice()); vad.pop(); } };
  for (let off = 0; off < pad.length; off += 512) { vad.acceptWaveform(pad.subarray(off, off + 512)); emit(); }
  vad.flush(); emit();

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
  const audioSec = samples.length / 16000;
  console.log(`${label}：音频 ${(audioSec / 60).toFixed(1)} 分钟 → VAD ${segs.length} 段，转写 ${(ms / 1000).toFixed(1)}s，`
    + `RTF ${(ms / 1000 / audioSec).toFixed(3)}，输出 ${text.length} 字`);
  console.log(`   内存：样本 ${(samples.length * 4 / 1048576).toFixed(0)}MB，进程 RSS ${(process.memoryUsage().rss / 1048576).toFixed(0)}MB`);
  return { ms, text, segs: segs.length };
}

for (const minutes of [10, 20]) {
  const reps = Math.round((minutes * 60) / (base.length / 16000));
  const long = new Float32Array(base.length * reps);
  for (let i = 0; i < reps; i++) long.set(base, i * base.length);
  const r = runOn(long, `${minutes} 分钟`);
  if (r.text.length < 100) { console.log('   ⚠️ 输出异常少'); process.exitCode = 1; }
}
console.log('\n长视频压力测试通过 ✅');
