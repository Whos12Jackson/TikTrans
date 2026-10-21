// 离线包构建：把语音模型放进扩展目录，打一个"自带模型、装完即用"的包
// 用法：node scripts/build-offline.mjs <版本号>
// 产物：TikTrans-mvp-v<版本号>-离线版.zip（约 231MB）
//
// 原理：扩展目录里存在 model/sense-voice.onnx 时，识别引擎优先用它（零下载）；
//       没有这个目录的普通小包（3.3MB）依然走"首次使用时下载"的老路。
import { readFileSync, writeFileSync, existsSync, rmSync, mkdirSync, copyFileSync, statSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const version = process.argv[2];

if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
  console.error('用法：node scripts/build-offline.mjs <版本号>  例如 0.1.33');
  process.exit(1);
}

// 模型来源：优先用开发目录里的本地副本（版本必须是 2024-07-17 带标点那版）
const SRC_DIR = path.join(root, 'node_modules', '.smoke');
const FILES = [
  { src: 'model.int8.onnx', dest: 'sense-voice.onnx', min: 150 * 1024 * 1024 },
  { src: 'tokens.txt', dest: 'tokens.txt', min: 100 * 1024 },
  { src: 'silero_vad.onnx', dest: 'silero_vad.onnx', min: 100 * 1024 },
];

console.log(`[offline] 同步版本号到 ${version}`);
const pkgPath = path.join(root, 'package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
pkg.version = version;
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
const manifestPath = path.join(root, 'src', 'manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
manifest.version = version;
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

console.log('[offline] 构建扩展...');
execSync('node scripts/build.mjs', { cwd: root, stdio: 'inherit' });

const modelDir = path.join(root, 'dist', 'model');
if (existsSync(modelDir)) rmSync(modelDir, { recursive: true, force: true });
mkdirSync(modelDir, { recursive: true });
for (const f of FILES) {
  const src = path.join(SRC_DIR, f.src);
  if (!existsSync(src)) {
    console.error(`[offline] 找不到模型文件：${src}`);
    console.error('  请把 model.int8.onnx（2024-07-17 版）、tokens.txt、silero_vad.onnx 放到 ' + SRC_DIR);
    process.exit(1);
  }
  const size = statSync(src).size;
  if (size < f.min) {
    console.error(`[offline] ${f.src} 太小（${(size / 1048576).toFixed(1)}MB），可能不是 2024-07-17 版`);
    process.exit(1);
  }
  copyFileSync(src, path.join(modelDir, f.dest));
  console.log(`[offline] 已内置 ${f.dest}（${(size / 1048576).toFixed(1)}MB）`);
}

// 安装说明（换设备时照着做）
execSync('node scripts/write-install-guide.mjs', { cwd: root, stdio: 'inherit' });

const zipName = `TikTrans-mvp-v${version}-离线版.zip`;
const zipPath = path.join(root, zipName);
if (existsSync(zipPath)) rmSync(zipPath);
console.log('[offline] 打包中（约 231MB，稍等）...');
execSync(`powershell -Command "Compress-Archive -Path 'dist\\*' -DestinationPath '${zipPath}' -CompressionLevel Optimal"`, { cwd: root, stdio: 'inherit' });
const mb = statSync(zipPath).size / 1048576;
console.log(`[offline] 完成：${zipName}（${mb.toFixed(0)}MB）`);
console.log('[offline] 用法：解压这个包 → edge://extensions 加载解压目录 → 直接用，不需要下载模型');
