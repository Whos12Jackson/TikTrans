// 版本同步脚本：自动更新 package.json 和 manifest.json 的版本号，然后重新打包
// 用法：node scripts/sync-version.mjs <版本号>
// 例如：node scripts/sync-version.mjs 0.1.15
import { readFileSync, writeFileSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const version = process.argv[2];

if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
  console.error('用法：node scripts/sync-version.mjs <版本号>  例如 0.1.15');
  process.exit(1);
}

console.log(`[version] 同步版本号到 ${version}`);

// 1) package.json
const pkgPath = path.join(root, 'package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
pkg.version = version;
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
console.log('[version] package.json ✓');

// 2) src/manifest.json
const manifestPath = path.join(root, 'src', 'manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
manifest.version = version;
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
console.log('[version] src/manifest.json ✓');

// 3) 构建
console.log('[version] 构建中...');
execSync('node scripts/build.mjs', { cwd: root, stdio: 'inherit' });

// 4) 打包
// 注意：如果之前构建过"离线版"，dist/model/ 里会有 228MB 的模型 —— 小包不要带它
const bundledModelDir = path.join(root, 'dist', 'model');
if (existsSync(bundledModelDir)) {
  rmSync(bundledModelDir, { recursive: true, force: true });
  console.log('[version] 已移除 dist/model（小包不含模型，模型另行下载）');
}
const zipName = `TikTrans-mvp-v${version}.zip`;
const zipPath = path.join(root, zipName);
if (existsSync(zipPath)) rmSync(zipPath);
execSync(`powershell -Command "Compress-Archive -Path 'dist\\*' -DestinationPath '${zipPath}'"`, { cwd: root, stdio: 'inherit' });

console.log(`[version] 完成：${zipName}`);
