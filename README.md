# TikTrans · 抖音口播逐行提取

把抖音视频里的口播，转成**一句一行、带时间戳**的文本，可以逐行改、复制、打标签、导出成 txt。

**全程在你自己浏览器里跑**：语音识别用 WebAssembly 在本地完成，音频不上传、不经过任何服务器。

![MV3](https://img.shields.io/badge/Chrome%2FEdge%20MV3-116%2B-brightgreen) ![离线](https://img.shields.io/badge/识别-全本地-brightgreen)

---

## 特点

- **成行按标点走**：一句一行，不会把话从中间切开（换气不会断句）
- **带时间轴**：每行都有起止时间，可点时间戳跳转、播放时高亮当前行
- **可编辑**：改字、拆行、合并、删除、打标签、逐步撤销，纯键盘可完成
- **易错词表**：同音字（美誉/美玉、切懦/怯懦）可以写进词表自动纠正；**你在编辑器里改过两次以上的词，系统会自动学会**
- **素材库**：跨视频筛选、打标签、导出 CSV
- **导出**：纯文本 txt / 带时间轴 txt / JSON，txt 顶部带视频来源链接
- **零配置**：装完即用（离线版连模型都不用下）

## 安装

> 安装包见仓库的 **Releases**（离线版 157MB 超过 git 单文件 100MB 限制，不能直接放进代码仓库）。
> 若 Releases 里暂时没有，可按下方「开发」一节自行构建：
> `node scripts/build-offline.mjs <版本号>`。

### 方式一：离线版（推荐，装完即用）

1. 下载 `TikTrans-mvp-v0.1.35-离线版.zip`（约 157MB，**模型已经打包在里面**）
2. 解压到任意目录（中文路径、带空格都可以）
3. 浏览器打开 `edge://extensions`（Chrome 是 `chrome://extensions`）
4. 打开右上角「开发人员模式」→「加载解压缩的扩展」→ 选中解压出来的目录

完成。**不需要下载模型**，粘贴抖音链接就能转写。

### 方式二：标准版（3MB）

同上安装，但首次使用时要下载一次语音模型（228MB）。模型下载地址在设置页里，可换成自己的 CDN。

## 使用

1. 在抖音打开一个作品页，复制链接
2. 点浏览器工具栏的 TikTrans 图标打开侧边栏
3. 粘贴链接 → 点「提取口播」
4. 出来后可以逐行改、复制（`复制`）或导出（`导出`）

> 也可以打开扩展全屏页（`app.html`）用，功能更全。

## 内存说明（实测）

| 项目 | 实测 |
| --- | --- |
| Edge 自身基线 | ~520 MB |
| 识别引擎（wasm） | ~614 MB（模型 228MB + 推理缓冲） |
| 音频副本 | 约 35 MB / 分钟视频 |
| 一条 3 分钟视频转写完 | 约 1.0 ~ 1.2 GB |

- 这是**浏览器内离线识别**的固有成本（音频要变成模型能吃的数字），不是泄漏
- **连续转写多条时内存是复用的**，不会每条都涨；关掉浏览器即释放
- 逐进程实测：涨得最多的是**抖音页面自己**（解析用的后台标签页在播 1080p 视频），不是识别引擎

## 开发

```bash
pnpm install
pnpm build          # 构建到 dist/
pnpm test           # 单元测试
pnpm typecheck      # 类型检查
```

打两个包：

```bash
node scripts/sync-version.mjs 0.1.35              # 标准版（3MB）
node scripts/build-offline.mjs 0.1.35             # 离线版（模型内置，约 157MB）
```

### 目录结构

```
src/
  core/        核心逻辑：断句、导出、设置、模型下载、数据库（IndexedDB/Dexie）
  background/  Service Worker：任务队列、消息路由
  offscreen/   离屏文档 + 识别 Worker（VAD + SenseVoice）
  content/     抖音页面钩子（MAIN world）与桥接
  ui/          React 界面：侧边栏 / 全屏页 / 素材库
  engine/      sherpa-onnx WebAssembly 适配（模型运行时注入）
public/engine/ sherpa-onnx 官方 wasm 产物（Apache-2.0）
tests/         vitest 单元测试
scripts/       构建、打包、端到端测试脚本
```

### 技术栈

Chrome/Edge MV3 + Vite + TypeScript + React 18 + Dexie 4；
语音识别：[sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) WebAssembly
（Silero VAD + [SenseVoice](https://github.com/FunAudioLLM/SenseVoice) int8 2024-07-17）。

## 致谢

- [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx)：Apache-2.0
- [Silero VAD](https://github.com/snakers4/silero-vad)：MIT
- [SenseVoice](https://github.com/FunAudioLLM/SenseVoice) 模型权重：见其模型仓库的 LICENSE，
  **分发前请自行确认条款**（本仓库不含模型权重，离线包需自行构建或按模型页说明获取）

## 已知限制

- 只处理**口播/人声**视频；纯音乐、无人声的视频会提示"未识别到人声"
- 图文作品没有音频，直接跳过
- 识别准确率取决于音频质量与模型能力（SenseVoice int8），同音字需要用词表纠正
- 抖音页面结构变化时，可能需要更新解析逻辑（`src/core/aweme.ts`）

## 免责声明

仅供个人学习与效率使用。请遵守平台规则与著作权规定，勿用于二次分发他人内容。
