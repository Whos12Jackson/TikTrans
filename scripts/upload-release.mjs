// 用 GitHub API 创建 Release 并上传安装包
// 用法：
//   1) 在 GitHub 建一个 token：
//      Settings → Developer settings → Personal access tokens → Fine-grained tokens
//      → 选仓库 Whos12Jackson/TikTrans → 权限 Contents: Read and write
//   2) 本机 PowerShell 里执行（token 只存在这次会话里）：
//      $env:GITHUB_TOKEN = "github_pat_xxx"
//      node scripts/upload-release.mjs 0.1.35
//   3) 用完关掉窗口即可；想彻底清除：$env:GITHUB_TOKEN = $null
import { readFileSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OWNER = 'Whos12Jackson';
const REPO = 'TikTrans';
const version = process.argv[2] ?? '0.1.35';
const tag = `v${version}`;

const token = process.env.GITHUB_TOKEN;
if (!token) {
  console.error('缺少环境变量 GITHUB_TOKEN。先执行：$env:GITHUB_TOKEN = "github_pat_xxx"');
  process.exit(1);
}

// 注意：GitHub 会剥掉附件名里的非 ASCII 字符（"离线版" 会变成空），
// 所以上传时统一用英文名，本地文件名不变。
const ASSETS = [
  { name: `TikTrans-mvp-v${version}-offline.zip`, file: `TikTrans-mvp-v${version}-离线版.zip` },
  { name: `TikTrans-mvp-v${version}.zip`, file: `TikTrans-mvp-v${version}.zip` },
].map((a) => ({ ...a, file: path.join(root, a.file) }));

for (const a of ASSETS) {
  if (!existsSync(a.file)) {
    console.error(`找不到安装包：${a.file}（先跑 node scripts/build-offline.mjs ${version}）`);
    process.exit(1);
  }
}

const BODY = [
  '抖音口播逐行提取 · 浏览器扩展（Chrome/Edge MV3）',
  '识别全程在本地完成，音频不上传。',
  '',
  `【推荐 · 离线版】TikTrans-mvp-v${version}-offline.zip（157MB）`,
  '模型已打包在内，装完即用，不需要下载 228MB 模型。',
  '',
  `【轻量 · 标准版】TikTrans-mvp-v${version}.zip（3MB）`,
  '首次使用时下载一次语音模型（地址可在设置里改成自己的 CDN）。',
  '',
  '安装：解压 → edge://extensions 开「开发人员模式」→「加载解压缩的扩展」→ 选解压目录。需要 Edge/Chrome 116+。',
  '',
  '换设备：解压到任意目录（中文/空格路径均可），扩展 ID 固定不变。',
].join('\n');

const api = 'https://api.github.com';
const headers = {
  Authorization: `Bearer ${token}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'TikTrans-release-script',
};

// 1) 找一个已存在的 release（避免重复创建报 422）
let release = null;
const existingResp = await fetch(`${api}/repos/${OWNER}/${REPO}/releases/tags/${tag}`, { headers });
if (existingResp.ok) {
  release = await existingResp.json();
  console.log(`[release] 已存在 ${tag}，直接往它上面传附件`);
} else {
  const resp = await fetch(`${api}/repos/${OWNER}/${REPO}/releases`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ tag_name: tag, name: `TikTrans ${tag} · 离线版（装完即用）`, body: BODY, draft: false, prerelease: false }),
  });
  if (!resp.ok) {
    console.error(`[release] 创建失败 HTTP ${resp.status}：${(await resp.text()).slice(0, 300)}`);
    process.exit(1);
  }
  release = await resp.json();
  console.log(`[release] 已创建 ${tag}`);
}

// 2) 逐个上传附件
for (const a of ASSETS) {
  const bytes = readFileSync(a.file);
  const sizeMB = (statSync(a.file).size / 1048576).toFixed(1);
  console.log(`[upload] ${a.name}（${sizeMB}MB）…`);
  const url = `${release.upload_url.replace('{?name,label}', '')}?name=${encodeURIComponent(a.name)}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      ...headers,
      'Content-Type': 'application/zip',
      'Content-Length': String(bytes.length),
    },
    body: bytes,
  });
  if (!resp.ok) {
    const txt = await resp.text();
    if (resp.status === 422 && txt.includes('already_exists')) {
      console.log(`[upload] 已存在同名附件，跳过`);
      continue;
    }
    console.error(`[upload] 失败 HTTP ${resp.status}：${txt.slice(0, 300)}`);
    process.exit(1);
  }
  const asset = await resp.json();
  console.log(`[upload] ✅ ${asset.name}（${(asset.size / 1048576).toFixed(1)}MB）`);
}

console.log(`\n完成：https://github.com/${OWNER}/${REPO}/releases/tag/${tag}`);
