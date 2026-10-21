// 引擎装载冒烟（Node + vm 模拟 Worker 环境）：
// 验证「构建时打过补丁的胶水（空 .data 元数据）+ 运行时 FS_createDataFile 注入模型 + createVad」链路。
// 用法：node scripts/smoke-engine.mjs
// 说明：SenseVoice 大模型不在本机，识别级验证用注入 VAD 模型 + 喂静音 + 查询 VAD 状态代替。
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const engineDir = path.join(root, 'dist', 'engine');

// 1) 从原始 .data 里抠出 silero_vad.onnx（区间来自胶水内嵌元数据）
const DATA = path.join(root, 'public', 'engine', 'vad-asr-1.12.36', 'sherpa-onnx-wasm-main-vad-asr.data');
const tmpDir = path.join(root, 'node_modules', '.smoke');
mkdirSync(tmpDir, { recursive: true });
const vadPath = path.join(tmpDir, 'silero_vad.onnx');
if (!existsSync(vadPath)) {
  const fd = readFileSync(DATA);
  writeFileSync(vadPath, fd.subarray(43707200, 44351054));
}
const vadBytes = readFileSync(vadPath);
const wasmBytes = readFileSync(path.join(engineDir, 'sherpa-onnx-wasm-main-vad-asr.wasm'));
console.log(`[smoke] silero_vad.onnx = ${(vadBytes.length / 1024).toFixed(0)} KB, wasm = ${(wasmBytes.length / 1024 / 1024).toFixed(1)} MB`);

// 2) Worker 风格沙箱
let runtimeReady = false;
const sandbox = {
  console,
  setTimeout, clearTimeout, setInterval, clearInterval,
  performance, TextDecoder, TextEncoder, Blob, URL, atob, btoa,
  WebAssembly, Date, Math, JSON, Promise, Uint8Array, ArrayBuffer, Object, Array, Error, String, Number,
  navigator: { userAgent: 'smoke' },
  location: { href: 'chrome-extension://smoke/offscreen/asr-worker.js', pathname: '/offscreen/asr-worker.js' },
  fetch: async (url) => ({
    ok: true, status: 200,
    arrayBuffer: async () => wasmBytes.buffer.slice(wasmBytes.byteOffset, wasmBytes.byteOffset + wasmBytes.byteLength),
    json: async () => ({}),
  }),
  XMLHttpRequest: class { open() {} send() {} setRequestHeader() {} },
  importScripts: () => { throw new Error('smoke 不用 importScripts（直接 runInContext 加载脚本）'); },
};
sandbox.self = sandbox;
sandbox.globalThis = sandbox;
sandbox.window = undefined; // 显式走 worker 分支
sandbox.Module = {
  locateFile: (f) => f,
  getPreloadedPackage: () => new ArrayBuffer(0),
  onRuntimeInitialized: () => { runtimeReady = true; },
  setStatus: (s) => console.log('[sherpa]', s),
};
vm.createContext(sandbox);

const load = (f) => vm.runInContext(readFileSync(path.join(engineDir, f), 'utf-8'), sandbox, { filename: f });
load('sherpa-onnx-asr.js');
load('sherpa-onnx-vad.js');
load('sherpa-onnx-wasm-main-vad-asr.js'); // 打过补丁的胶水

// 3) 等运行时初始化
const t0 = Date.now();
while (!runtimeReady && Date.now() - t0 < 30000) {
  await new Promise((r) => setTimeout(r, 50));
}
if (!runtimeReady) throw new Error('runtime 30 秒内没初始化（补丁或胶水有问题）');
console.log(`[smoke] runtime 初始化 OK（${Date.now() - t0} ms）`);

// 4) 运行时注入模型 → 创建 VAD → 喂静音
const M = sandbox.Module;
M.FS_createDataFile('/', 'silero_vad.onnx', new Uint8Array(vadBytes), true, true, true);
console.log('[smoke] FS_createDataFile 注入 silero_vad.onnx OK');

// 脚本级声明（class/function）不挂到沙箱对象上，用 runInContext 取裸标识符
const createVad = vm.runInContext('createVad', sandbox);
const OfflineRecognizer = vm.runInContext('OfflineRecognizer', sandbox);
const vad = createVad(M, {
  sileroVad: {
    model: '/silero_vad.onnx', threshold: 0.5,
    minSilenceDuration: 0.5, minSpeechDuration: 0.25,
    windowSize: 512, maxSpeechDuration: 20,
  },
  sampleRate: 16000, numThreads: 1, provider: 'cpu', debug: 0, bufferSizeInSeconds: 30,
});
const silence = new Float32Array(512);
for (let i = 0; i < 16000 / 512; i++) vad.acceptWaveform(silence); // 1 秒静音
console.log(`[smoke] createVad + acceptWaveform OK，isEmpty=${vad.isEmpty()} isDetected=${vad.isDetected()}`);

// 5) OfflineRecognizer 构造级检查（SenseVoice 模型不在本机，只验证封装可用）
console.log(`[smoke] OfflineRecognizer 类型 = ${typeof OfflineRecognizer}`);
console.log('[smoke] 全部通过 ✅');
