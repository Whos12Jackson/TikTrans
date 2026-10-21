# TikTrans × Info_Word 整合方案

> 前提：TikTrans 必须「装上就能用」——扩展零依赖、纯离线交付。
> Info_Word 降级为可选增强后端，只走规格里本来就有的可选扩展点，不填就全功能离线可用。
> 两边不共享代码、不共享数据库，只共享「接口约定 + 导出互通」。

## 一、总原则

1. TikTrans 按开发规格原案自包含交付：不依赖 Info_Word、不依赖本机任何服务，装上扩展下载完模型就能用。
2. Info_Word 是可选增强：填了本机服务地址才出现「云端转写」「烧字幕」入口，不填或连不上一切照旧。
3. 两边不共享代码、不共享数据库（IndexedDB 与 SQLite 各管各的），只共享接口约定与导出互通。

## 二、TikTrans 必须自带的部分（Info_Word 完全不参与）

1. 转写：sherpa-onnx WASM + SenseVoice int8 + Silero VAD（约 230 MB，首次运行从国内 CDN 下载），JS/WASM 全部打包进扩展——照规格原文，**不换 faster-whisper**。
2. 抓取（fetch/XHR 包装）、行卡片编辑器、标签体系、素材库、IndexedDB、导出——照规格。
3. LLM 校正/打标：照规格走用户自填的 OpenAI 兼容接口，不接 Info_Word 的模型客户端。

## 三、Info_Word 可复用组件（可选后端，仅本机/自装用户启用）

| 组件 | 本机位置 | 挂到 TikTrans 的哪个口 |
| --- | --- | --- |
| 转写服务（需新加 `POST /api/video/transcribe-file`） | `D:\WorkSpace\Info_Word\backend\info_word\api\video_routes.py` + `D:\WorkSpace\Info_Word\backend\scripts\transcribe_srt.py` | 规格「二期云端转写适配器」——填了地址就可选为转写引擎，精度高于浏览器内 SenseVoice |
| 转写运行环境 | `D:\WorkSpace\Info_Word\backend\.whisper-venv\Scripts\python.exe`（faster-whisper 1.2.1 + ctranslate2） | 同上，后端内部使用 |
| Whisper 模型权重（约 1.5 GB） | `C:\Users\Lenovo\.cache\huggingface\hub\models--mobiuslabsgmbh--faster-whisper-large-v3-turbo\` | 同上，后端内部使用 |
| VAD 小模型（1.2 MB） | `D:\WorkSpace\Info_Word\backend\.whisper-venv\Lib\site-packages\faster_whisper\assets\silero_vad_v6.onnx` | 随 faster-whisper 自动带 |
| 烧录管线（下载→转写→翻译→烧录→X 转码） | `D:\WorkSpace\Info_Word\backend\info_word\services\video_pipeline.py`、`api\video_routes.py` | 扩展加「发到 Info_Word 烧字幕」按钮，把视频 URL/文件交给它——TikTrans 明确不做、Info_Word 独有的能力 |
| 双语 ASS 排版 | `D:\WorkSpace\Info_Word\backend\scripts\bilingual_ass.py` | 仅烧录管线内部使用 |
| X 合规转码 | `D:\WorkSpace\Info_Word\backend\scripts\x_transcode.py` | 仅烧录管线内部使用 |
| 翻译模型客户端 | `D:\WorkSpace\Info_Word\backend\info_word\services\model_client.py` + `D:\WorkSpace\Info_Word\elk_shared\`（读 ELK-ModelSDK 的 `.env`） | 不接，仅 Info_Word 自身管线内用 |
| 服务入口（FastAPI，端口 3303） | `D:\WorkSpace\Info_Word\backend\server.py` | 扩展调用的宿主 |
| 配置 | `D:\WorkSpace\Info_Word\backend\info_word\config.py`（VIDEO_PYTHON 探测）+ `backend\.env` | 沿用不动 |
| 外部依赖 | yt-dlp、ffmpeg/ffprobe（PATH） | 仅 Info_Word 侧使用 |

## 四、接口与设置约定

1. 扩展设置页新增一项「本地 Info_Word 服务（可选）」：填 `http://127.0.0.1:3303` 之类的地址，检测通过才出现「云端转写」「烧字幕」两个入口；不填或连不上 = 一切照旧离线用。
2. 规格里「云端转写适配器（二期）」的抽象保留，Info_Word 是其中第一个实现，将来接阿里云百炼等不冲突。
3. 转写接口约定：`POST /api/video/transcribe-file`，收音频文件，返回 SRT（行文本 + 起止毫秒）；后端内部用 `.whisper-venv` 的 python 跑 `transcribe_srt.py`。
4. 导出互通：扩展导出 txt / txt_ts / md / srt / json（规格已含），Info_Word 侧不需要改。

## 五、实施顺序

1. TikTrans 严格按规格一期交付（自包含，验收清单不变）。
2. 二期做云端转写适配器时，Info_Word 加 `transcribe-file` 接口（`transcribe_srt.py` 已是独立脚本，封装成本约半天）。
3. 二期/三期可选：「发到 Info_Word 烧字幕」按钮（交给 `video_pipeline.py` 的 video_jobs 跑完整管线）。

## 六、开发期可参考（不进扩展包、不构成依赖）

1. 成行规则（句子 + 停顿切分、单条字幕最长 6 秒）可对照 `D:\WorkSpace\Info_Word\backend\scripts\transcribe_srt.py` 的实现写测试用例。
2. 字幕按画面宽度折行、降字号的排版思路可参考 `D:\WorkSpace\Info_Word\backend\scripts\bilingual_ass.py`（规格的导出暂不烧录，仅备用）。
