// 构建编排：4 组产物 → dist/
// 1) UI 页面（sidepanel.html / app.html，React + CSS）
// 2) 后台 service worker（ES module）
// 3) offscreen 文档 + 识别 Worker（ES module）
// 4) 内容脚本（IIFE × 2，page-hook 注入 MAIN world）
// 最后拷贝 public/（图标、sherpa-onnx 引擎产物）与 manifest.json。
import { build } from 'vite';
import react from '@vitejs/plugin-react';
import { cp, mkdir, copyFile, readdir, stat, rm, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const out = {
  entryFileNames: '[name].js',
  chunkFileNames: 'chunks/[name].js',
  assetFileNames: 'assets/[name][extname]',
};

const quiet = { logLevel: 'warn', configFile: false };

async function buildPages() {
  await build({
    ...quiet,
    root: path.join(root, 'src', 'ui'),
    base: './',
    publicDir: false,
    plugins: [react()],
    build: {
      outDir: dist,
      emptyOutDir: false,
      rollupOptions: {
        input: {
          sidepanel: path.join(root, 'src', 'ui', 'sidepanel.html'),
          app: path.join(root, 'src', 'ui', 'app.html'),
        },
        output: out,
      },
    },
  });
}

async function buildModule(name, input, outDir) {
  await build({
    ...quiet,
    publicDir: false,
    build: {
      outDir: path.join(dist, outDir),
      emptyOutDir: false,
      rollupOptions: { input, output: { ...out, format: 'es' } },
    },
  });
}

async function buildIife(name, input, outFile, outSub = 'content') {
  await build({
    ...quiet,
    publicDir: false,
    build: {
      outDir: path.join(dist, outSub),
      emptyOutDir: false,
      lib: { entry: input, formats: ['iife'], name: name, fileName: () => path.basename(outFile) },
      rollupOptions: { output: { inlineDynamicImports: true } },
    },
  });
}

async function copyStatic() {
  await mkdir(dist, { recursive: true });
  await copyFile(path.join(root, 'src', 'manifest.json'), path.join(dist, 'manifest.json'));
  await mkdir(path.join(dist, 'offscreen'), { recursive: true });
  await copyFile(path.join(root, 'src', 'offscreen', 'offscreen.html'), path.join(dist, 'offscreen', 'offscreen.html'));
  // 图标
  await cp(path.join(root, 'public', 'icons'), path.join(dist, 'icons'), { recursive: true });

  // sherpa-onnx 引擎产物（只带浏览器必需的 4 个文件）
  const engineSrc = path.join(root, 'public', 'engine', 'vad-asr-1.12.36');
  const engineDst = path.join(dist, 'engine');
  await mkdir(engineDst, { recursive: true });
  await copyFile(path.join(engineSrc, 'sherpa-onnx-wasm-main-vad-asr.wasm'), path.join(engineDst, 'sherpa-onnx-wasm-main-vad-asr.wasm'));
  // 两个 JS 封装都以「脚本级声明」暴露 API，且存在同名顶层声明（OfflineStream/freeConfig 等），
  // 在 Worker 里先后 importScripts 会撞 "Identifier ... has already been declared"。
  // 构建时各自包一层 IIFE 隔离作用域，只把需要的 API 挂到 self 上。
  const wrapBinding = (src, names) =>
    `(function(){\n${src}\n;${names.map((n) => `self.${n}=${n};`).join('')}})();`;
  const asrSrc = await readFile(path.join(engineSrc, 'sherpa-onnx-asr.js'), 'utf-8');
  await writeFile(
    path.join(engineDst, 'sherpa-onnx-asr.js'),
    wrapBinding(asrSrc, ['OfflineRecognizer', 'createOnlineRecognizer']),
    'utf-8',
  );
  const vadSrc = await readFile(path.join(engineSrc, 'sherpa-onnx-vad.js'), 'utf-8');
  await writeFile(
    path.join(engineDst, 'sherpa-onnx-vad.js'),
    wrapBinding(vadSrc, ['createVad', 'CircularBuffer', 'Vad']),
    'utf-8',
  );
  // 胶水 JS：把预载 .data 元数据清空（原包含 moonshine 模型，44.9MB + 商用许可受限），
  // 模型改为运行时 FS_createDataFile 注入；同时避免启动时 fetch 不存在的 .data
  const glueSrc = await readFile(path.join(engineSrc, 'sherpa-onnx-wasm-main-vad-asr.js'), 'utf-8');
  const patched = glueSrc.replace(
    /loadPackage\(\{"files":\[.*?\],"remote_package_size":\d+\}\)/s,
    'loadPackage({"files":[],"remote_package_size":0})',
  );
  if (patched === glueSrc) {
    console.warn('[build] 胶水 .data 元数据未匹配到，原样输出（会随包带 44.9MB .data 吗：否，仅警告）');
  }
  await writeFile(path.join(engineDst, 'sherpa-onnx-wasm-main-vad-asr.js'), patched, 'utf-8');
}

async function main() {
  const t0 = Date.now();
  await rm(dist, { recursive: true, force: true });
  await buildPages();
  await buildModule('background', { index: path.join(root, 'src', 'background', 'index.ts') }, 'background');
  await buildModule('offscreen', { index: path.join(root, 'src', 'offscreen', 'index.ts') }, 'offscreen');
  await buildIife('asrWorker', path.join(root, 'src', 'offscreen', 'asr-worker.ts'), 'asr-worker.js', 'offscreen');
  await buildIife('pageHook', path.join(root, 'src', 'content', 'page-hook.ts'), 'page-hook.js');
  await buildIife('pageBridge', path.join(root, 'src', 'content', 'page-bridge.ts'), 'page-bridge.js');
  await copyStatic();
  console.log(`[build] 完成，耗时 ${Date.now() - t0} ms → ${dist}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
