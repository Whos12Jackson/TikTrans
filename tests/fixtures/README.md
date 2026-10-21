# tests/fixtures · 抖音作品接口 JSON 测试夹具

本目录存放 TikTrans 扩展单元测试用的「抖音作品接口返回 JSON」样本。测试不访问网络，作品数据提取、音频地址选择顺序、图文识别等用例都从这里读数据。

- 生成时间：2026-10-19
- 样本数量：6 个文件、共 8 条作品（aweme）
- **全部为「按公开文档构造」，不是真实抓取**。真实抓取尝试与失败方式见下文「真实抓取尝试记录」。
- JSON 文件为纯 JSON，无注释；来源与结构说明只写在本 README 里。

---

## 1. 真实抓取尝试记录（2026-10-19）

按任务要求先直接请求抖音 web 端公开接口，均未拿到作品 JSON。如实记录如下，**未做任何签名破解或风控绕过**：

| 尝试 | 请求 | 结果 |
| --- | --- | --- |
| 作品详情 | `GET https://www.douyin.com/aweme/v1/web/aweme/detail/?aweme_id=7301234567890123456&device_platform=webapp&aid=6383&channel=channel_pc_web` | **HTTP 403**，响应体 `Blocked by ArgusSecurityPlugin Uifid Not Found`（字节 Argus 风控网关拒绝，缺签名/设备指纹参数） |
| 推荐流 | `GET https://www.douyin.com/aweme/v1/web/tab/feed/?device_platform=webapp&aid=6383&channel=channel_pc_web&count=6` | **HTTP 200 但响应体 0 字节**（空响应；未带 `a_bogus` 等签名参数时网关返回空，与 f2 项目 [Issue #99](https://github.com/Johnserf-Seed/f2/issues/99)、[Issue #119](https://github.com/Johnserf-Seed/f2/issues/119) 描述的「详情接口返回空值」一致） |
| 作者作品 | `GET https://www.douyin.com/aweme/v1/web/aweme/post/?sec_user_id=MS4wLjABAAAA-test-test&device_platform=webapp&aid=6383&max_cursor=0&count=10` | **HTTP 403**，同上 Argus 拦截 |
| 作品页兜底 | `GET https://www.douyin.com/video/7301234567890123456` | **HTTP 200**，但返回的是 `_$jsvmprt` 混淆 JS 反爬壳（空 `<body>` + 混淆脚本），无 `_ROUTER_DATA` / `RENDER_DATA` 内嵌 JSON，拿不到作品数据 |

结论：无登录态、无签名参数（`a_bogus` / `X-Bogus`）时，`aweme/detail`、`aweme/post` 被 403 拦截，`tab/feed` 返回空。按照「不绕过风控、不破解签名」的约束，改为按公开文档构造样本。浏览器里正常登录、正常浏览时这些接口是能返回数据的（扩展的页面钩子正是从这些正常响应里取数据），用 DevTools 导出即可获得真实样本（见第 4 节）。

**真实样本存档**：本次未抓到任何真实 JSON，目录中没有 `*_real.json` 之类的文件。后续若用 DevTools 导出了真实样本，按第 4 节末尾的方式存放并在本节补记录。

## 2. 样本来源与构造依据

全部样本按下列公开资料的字段定义与真实响应形态构造：

| 依据 | 用到的内容 |
| --- | --- |
| [Johnserf-Seed/f2](https://github.com/Johnserf-Seed/f2) [`f2/apps/douyin/filter.py`](https://github.com/Johnserf-Seed/f2/blob/main/f2/apps/douyin/filter.py)（文档站 f2.readthedocs.io 的字段定义即出自这里） | `AwemeDetailFilter` 的 `$.aweme_detail.aweme_id`、`.desc`/`.caption`、`.create_time`、`.author.nickname`、`.author.sec_uid`、`.duration`、`.video.bit_rate[0].play_addr.url_list`、`.video.origin_cover.url_list[0]`、`.text_extra[*].hashtag_name`、`.images[*].url_list[0]`、`.statistics.*`；`UserPostFilter` 的 `$.aweme_list[*].*` 同构字段（`video.duration`、`video.bit_rate[].play_addr.url_list`、`author.sec_uid` 等） |
| [Yinmu/video-transcript-clipper](https://github.com/Yinmu/video-transcript-clipper)（MIT，`lib/extractors.js`） | 真实媒体 URL 的域名与形态匹配规则：`douyinvod`、`zjcdn`、`bytecdn`、`byte-vod`、`v3-dy`、`v3-web`、`v26-web`、`v9-web`、`tos-cn`、`iesdouyin`；纯音频流 URL 带 `media-audio`，视频变体带 `media-video-avc1` / `media-video-hvc1` |
| [makur6371/douyin-fetch-skill](https://github.com/makur6371/douyin-fetch-skill)（`scripts/resolve.mjs`，真实浏览器 XHR 拦截） | 真实响应的取法与字段路径：`body.aweme_detail.aweme_id / .desc / .author.nickname / .video.duration / .video.cover.url_list[0] / .video.play_addr.url_list / .music.play_url.url_list / .statistics` |
| 公开技术博客中的抖音作品 JSON 示例（[抖音用户视频列表接口](https://zhuanlan.zhihu.com/p/632700631)、[nodejs 抖音解析](https://juejin.cn/post/7108261272474353694) 等） | `bit_rate[].gear_name / quality_type / bit_rate / is_bytevc1`、`play_addr.uri/url_list/width/height/data_size`、`text_extra`、`statistics` 的取值形态；媒体 URL 查询参数形态（`a=6383&ch=5&cr=3&dr=0&lr=all&cd=...&cv=1&br=...&bt=...&cs=0&ds=...&ft=...&mime_type=video_mp4&qs=0&rc=...&s=...&sp=&dl=...&vr_id=...&is_play_url=1&quality=...`） |
| 本项目规格 `TikTrans_SPEC.md`「capture：拿作品数据」 | 扩展实际要取的字段清单与音频地址选择顺序（纯音频流 → 最低码率视频流 → play_addr） |

构造原则：

- 外层响应壳按真实接口：详情是 `{"status_code":0,"aweme_detail":{...}}`，列表是 `{"status_code":0,"aweme_list":[...]}`，均带 `extra` / `log_pb` / 分页游标字段。
- 媒体 URL 的**域名、路径段、查询参数名全部仿真实形态**（`*.douyinvod.com`、`*.zjcdn.com`、`*.bytecdn.com`、`www.iesdouyin.com/aweme/v1/play/`、`p*-sign.douyinpic.com`、`p3-music.douyinpic.com`、`sf1-cdn-tos.douyinstatic.com`），但 **hash、签名、token 全是编造的**，不能真实下载。`x-expires` 等时间参数同理，是形态占位。
- `aweme_id` 用 19 位数字字符串（真实作品 ID 形态），`sec_uid` 用 `MS4wLjABAAAA-` 开头的形态，`uid`/`short_id`/`hashtag_id` 均为形态正确的假值。
- `create_time` 是 Unix 秒；`video.duration` 是**毫秒**（f2 与真实响应一致）。
- 字段齐全但不求全：保留扩展会用到的字段和少量真实壳字段（`status`、`music`、`log_pb`），没有复刻真实响应的全部几百个字段。

## 3. 样本清单与结构说明

| 文件 | 内容概述 | 来源 | 覆盖的测试点 |
| --- | --- | --- | --- |
| `aweme_detail_normal.json` | 作品详情（普通口播视频）：`{"status_code":0,...,"aweme_detail":{...}}`，1 条作品 | 按 f2 `AwemeDetailFilter` 字段构造 | 字段提取全集：`aweme_id`、`desc`、`create_time`、`author.nickname/sec_uid`、`video.duration`、`play_addr.url_list`（3 个镜像）、`bit_rate[]` 3 档（`normal_1080_0` 2143 kbps / `normal_720_0` 1267 kbps / `lowest_540_0` 638 kbps，**注意数组不是按码率升序**，测试要验证「取码率最低」而不是「取第 0 个」）、`video.cover_addr`、`text_extra[]` 3 个话题、`statistics`、`music` |
| `aweme_detail_images.json` | 作品详情（**图文**）：`aweme_type: 68`，`images` 3 张（每张 `uri` + `url_list` 2 个镜像 + `download_url_list`），`video.play_addr.url_list` 为空、`bit_rate: []`、`video.duration: 0` | 按 f2 `images[*].url_list[0]` 与图文作品公开结构构造 | 图文识别（`images` 非空即图文 → 跳过并提示「图文没有口播」）；提取逻辑不能因 `play_addr` 为空而崩溃 |
| `aweme_list_feed.json` | 推荐流：`/aweme/v1/web/tab/feed/` 响应壳 `{"status_code":0,"aweme_list":[2 条],"has_more":1,"cursor":...,"max_cursor":...}`，2 条不同作者的视频作品 | 按 f2 `UserPostFilter`（`$.aweme_list[*].*`）构造 | 列表遍历；`aweme_list` 数组逐条提取；跨作者字段隔离；第 2 条 `text_extra` 含一个 `type: 0` 的 @提及（**没有 `hashtag_name`**），验证只取 `hashtag_name` |
| `aweme_detail_audio_only.json` | 作品详情（**只有音频流**）：`audio.play_addr.url_list`、`video.play_addr.url_list` 与 `bit_rate[].play_addr.url_list` 全部是带 `media-audio` 的纯音频流（`mime_type=audio_mp4`），含两种真实形态：路径段 `.../o8YgIAF2nADQAiQfEJAAB1AAiBA/media-audio-1723-5/?...` 和查询参数 `...&media-audio=1&...` 各处混排；`bit_rate` 2 档音频（128 kbps / 64 kbps） | 按 video-transcript-clipper 观察到的 `media-audio` 匹配规则 + 真实 tos 路径/参数形态构造 | 音频地址选择第 1 顺位：URL 里含 `media-audio` 就是纯音频流（**按子串匹配，不要绑定它出现的位置**）；纯音频流可能出现在 `audio.play_addr` 或 `video.play_addr`/`bit_rate[].play_addr`，都要认；同样验证取码率最低档 |
| `aweme_detail_no_audio_stream.json` | 作品详情（**无纯音频流**）：所有 URL 都是 `mime_type=video_mp4` 的视频流，`bit_rate: []`（老作品常见），`play_addr.url_list` 4 个镜像（douyinvod / zjcdn / iesdouyin / bytecdn） | 按 f2 + 真实老作品结构构造 | 音频地址选择兜底：没有 `media-audio`、没有 `bit_rate` 时回退到 `video.play_addr.url_list`，并逐个试镜像 |
| `aweme_list_post.json` | 作者作品列表：`/aweme/v1/web/aweme/post/` 响应壳 `{"status_code":0,"aweme_list":[2 条],"has_more":1,"max_cursor":...,"min_cursor":0,"post_serial":0}`，同一作者（`author` 完全一致）2 条作品 | 按 f2 `UserPostFilter` 构造 | 作者页列表提取；第 2 条 `text_extra: []`（无话题）不报错；两条的 `bit_rate` 档数不同（2 档 / 1 档） |

媒体 URL 域名分布（每条作品的 `url_list` 都给多个镜像，方便测「依次试镜像」）：

- 视频流：`v26-web.douyinvod.com`、`v3-web.douyinvod.com`、`v3-dy-o-abtest.zjcdn.com`、`v11.bytecdn.com`、`www.iesdouyin.com/aweme/v1/play/`
- 纯音频流：`v26-web.douyinvod.com`、`v3-web.douyinvod.com`（带 `media-audio`）
- 封面/头像：`p3-sign.douyinpic.com`、`p9-sign.douyinpic.com`、`p26-sign.douyinpic.com`
- 配乐：`p3-music.douyinpic.com`、`sf1-cdn-tos.douyinstatic.com`

## 4. 用 DevTools 导出真实样本替换（操作步骤）

真实样本永远优先于构造样本。在**已登录（或至少能正常浏览）**的浏览器里：

1. 打开 Chrome / Edge，按 **F12**（macOS：⌥⌘I）打开开发者工具。
2. 切到 **「网络 / Network」** 面板。
3. 在过滤栏点 **「Fetch/XHR」**（只看接口请求，屏蔽图片脚本）；可选：在过滤框输入 `aweme/` 进一步缩小范围。
4. 打开/刷新抖音页面并触发对应场景：
   - 打开一条视频的作品页 `https://www.douyin.com/video/<id>` → 找 **`/aweme/v1/web/aweme/detail/?aweme_id=...`**；
   - 刷推荐流首页 → 找 **`/aweme/v1/web/tab/feed/`**；
   - 打开作者主页往下滚 → 找 **`/aweme/v1/web/aweme/post/?sec_user_id=...`**。
5. 在列表里点中该请求，右侧切到 **「响应 / Response」** 标签（Preview 标签也可以浏览结构）。
6. 把响应存下来，两种方式任选：
   - **复制**：右键响应内容 → 「复制 → 复制响应 / Copy response」，粘贴进一个新文件，保存为下面约定的文件名（保持纯 JSON、不要加注释）；
   - **整包 HAR**：在请求列表右键 → 「另存所有内容为 HAR / Save all as HAR with content」，把 `.har` 存到本目录（如 `douyin_capture.har`），需要哪条就从 `log.entries[].response.content.text` 里抠出来。HAR 里会带请求头和 cookie，**不要提交或外发**。
7. 覆盖/补充到本目录，按内容对号入座：

   | 导出的响应 | 存成 |
   | --- | --- |
   | 详情（视频作品） | `aweme_detail_normal.json`（或另存 `aweme_detail_normal_real.json` 与构造样本并存） |
   | 详情（图文，带 `images`） | `aweme_detail_images.json` |
   | 详情（响应里/播放器请求里有带 `media-audio` 的 URL） | `aweme_detail_audio_only.json` |
   | 推荐流（`aweme_list` 数组） | `aweme_list_feed.json` |
   | 作者作品列表 | `aweme_list_post.json` |

8. 如果想记录播放器实际请求的纯音频流（`media-audio` URL 通常不在接口 JSON 里，而是播放器自己发的媒体请求）：在网络面板过滤框输入 `media-audio` 或 `douyinvod`，播一遍视频，点中媒体请求后从「标头 / Headers」里复制完整「请求网址 / Request URL」，补进对应样本的 `play_addr.url_list`。
9. 用真实样本前先自查两点：
   - **脱敏**：真实响应含作者昵称、`uid`、`sec_uid`、签名 URL 等，公开仓库里建议换成不敏感的真实样本或删掉昵称类字段；
   - **过期**：媒体 URL 的 `x-expires` / `dl` / 签名会过期，只用于结构测试，不要写依赖真实下载的断言。

## 5. 字段映射表（字段路径 → 含义 → 扩展取什么）

以单条作品对象 `aweme`（详情是 `aweme_detail`，列表是 `aweme_list[i]`）为根：

| 字段路径 | 含义 | 扩展取什么（→ `videos` 表字段） |
| --- | --- | --- |
| `aweme.aweme_id` | 作品 ID，19 位数字字符串 | `contentId`（按字符串存；也是去重键 `[platform+contentId]`） |
| `aweme.desc` | 作品文案/标题（含 `#话题` 原文） | `description`（也可作 `title` 兜底） |
| `aweme.caption` | 文案原始串（与 `desc` 同文或含更多标记） | 兜底文案；`desc` 为空时用 |
| `aweme.create_time` | 发布时间，Unix **秒** | `publishedAt`（×1000 转毫秒） |
| `aweme.author.nickname` | 作者昵称 | `authorName` |
| `aweme.author.sec_uid` | 作者加密 ID，`MS4wLjABAAAA-...` | `authorSecUid` |
| `aweme.author.uid` / `unique_id` | 作者数字 ID / 抖音号 | 仅展示与去重参考，不入库 |
| `aweme.video.duration` | 时长，**毫秒** | `durationMs`（也用于「视频太长」判断） |
| `aweme.video.play_addr.url_list` | 播放地址镜像列表（通常带水印/主档） | 音频地址选择**第 3 顺位**（兜底）；逐个试镜像 |
| `aweme.video.bit_rate[].bit_rate` | 该档码率（bps） | 选**数值最小**的一档做兜底下载（注意不要按数组下标取） |
| `aweme.video.bit_rate[].gear_name` | 档位名（`normal_1080_0`、`lowest_540_0`、`adapt_540_1`…） | 仅日志/调试用，不作选择依据 |
| `aweme.video.bit_rate[].play_addr.url_list` | 该档播放地址镜像 | 音频地址选择**第 2 顺位**（码率最低档），逐个试镜像 |
| 任意 `url_list` 里带 `media-audio` 的 URL | 播放器请求的**纯音频流**（`mime_type=audio_mp4`），常见于 `audio.play_addr.url_list`、`video.play_addr.url_list`、`bit_rate[].play_addr.url_list` | 音频地址选择**第 1 顺位**；用子串 `media-audio` 匹配（可能在路径段，也可能在查询参数） |
| `aweme.video.cover_addr`（web 响应常见 `video.cover` / `origin_cover` / `dynamic_cover`） | 封面图（`uri` + `url_list`） | `coverUrl` 取 `url_list[0]`；读不到 `cover_addr` 就依次试 `cover`、`origin_cover` |
| `aweme.text_extra[].hashtag_name` | 文案里的 `#话题` 名 | `platformTags`（数组；过滤条件：`hashtag_name` 非空，或 `type === 1`） |
| `aweme.text_extra[]` 中 `type: 0` 的项 | @提及用户（无 `hashtag_name`） | 忽略，不要进 `platformTags` |
| `aweme.images` | 图文作品的图片数组（`images[].url_list`） | **`images` 非空即判定为图文作品** → `state: skipped`，提示「图文没有口播」；不要进 download 阶段 |
| `aweme.statistics`（`digg_count`/`comment_count`/`collect_count`/`share_count`/`play_count`…） | 互动数据 | 可选：展示用，不入 `videos` 表（表里没有对应列） |
| `aweme.music.play_url.url_list` | 作品配乐地址 | 仅展示；不作为转写音频源（口播在视频音轨里） |
| `aweme.aweme_type` | 作品类型（0/4 视频、68 图文） | 仅辅助；**判定图文以 `images` 为准** |
| `aweme.status.is_delete` / `private_status` / `is_prohibited` | 删除/私密/侵权状态 | 判「作品已删除或设为私密 → failed，不自动重试」 |
| 响应壳 `status_code` | 接口状态（0 正常） | 非 0 按失败处理，别当作品解析 |
| 响应壳 `aweme_list` / `aweme_detail` | 列表 / 单条详情的载体 | 页面钩子见 `aweme_detail` 或 `aweme_list` 就按 `aweme_id` 缓存作品 |
| 响应壳 `has_more` / `max_cursor` / `min_cursor` | 分页 | 作者页批量（二期）翻页用 |

音频地址选择顺序（对应 `TikTrans_SPEC.md` 的 download 阶段）：**带 `media-audio` 的纯音频流 → `bit_rate` 中码率最低档的 `play_addr.url_list` → `video.play_addr.url_list`**；每个地址依次试 `url_list` 里的镜像。

## 6. 使用注意

- 这些样本是**结构夹具**：字段路径、数组层级、URL 形态可信，但数值（统计数、签名、hash）是编造的。
- 测试断言不要依赖具体数字的算术关系（比如点赞数），只断言提取结果与样本一致。
- 真实样本替换后，如果字段名有出入（抖音改版），以真实 JSON 为准调整 `core/aweme.ts` 的提取逻辑，并回写本 README 的字段映射表。
- 本目录只放数据与文档；不要在此放脚本或构建产物。
