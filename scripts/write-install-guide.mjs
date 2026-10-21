// 把安装说明写进离线包里（换设备时照着做）
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');

const guide = `TikTrans · 抖音口播提取（离线版）
==================================================

【这个包是什么】
已经把语音模型打包在里面了，解压就能用，**不需要再下载 228MB 模型**。

【安装步骤】（Edge / Chrome 都一样）
1. 把这个压缩包解压到任意目录（中文路径、带空格的目录都可以）
2. 打开浏览器，地址栏输入：
     edge://extensions    （Chrome 的话是 chrome://extensions）
3. 打开右上角「开发人员模式」
4. 点「加载解压缩的扩展」→ 选中刚才解压出来的那个文件夹（要选包含 manifest.json 的那一层）
5. 完成。点浏览器工具栏的 TikTrans 图标（或在抖音页面点扩展图标）就能用

【怎么用】
· 打开抖音作品页 → 复制链接 → 点 TikTrans 图标 → 粘贴 → 点「提取口播」
· 侧边栏里可以逐行改字、拆行、合并、打标签
· 「复制」复制全部文字，「导出」导出 txt（带/不带时间轴）

【离线说明】
· 语音识别完全在本机浏览器里跑，不联网、不上传
· 除了识别抖音页面本身，不需要任何网络
· 需要 Edge/Chrome 116 或更高版本

【数据在哪】
· 转写结果、标签、设置都存在浏览器的 IndexedDB 里（按扩展 ID 隔离）
· 扩展 ID 是固定的（molhebkehbmdbpmopjafofelbmanebgo），换设备安装也是同一个 ID
· 想彻底清空：在扩展的设置页点「删除模型」，以及在浏览器里清除扩展数据

【常见问题】
· 侧边栏空白 → 刷新一下抖音页面，再点扩展图标
· 提示「模型文件缺失」→ 你装的是普通小包（3MB），请用这个离线版
· 抖音页面要登录才能看某些作品 → 先在浏览器登录抖音
`;

mkdirSync(dist, { recursive: true });
writeFileSync(path.join(dist, '安装说明.txt'), guide, 'utf-8');
console.log('[guide] 已写入 dist/安装说明.txt');
