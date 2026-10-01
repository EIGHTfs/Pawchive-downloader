# Pawchive-downloader

**最小 Node.js CLI**：零依赖，Node 18+ 全局 `fetch` 即可运行，Pawchive 公开作品下载器。

## 架构边界（分层职责 / 纪律）

> 本项目 = **独立下载引擎（cli.js）+ 独立插件式兼容层（server.js → core.js → adapters/）**。
> cli.js 在兼容层存在之前就已具备完整功能（索引、去重、下载、解析全流程），可完全独立运行；
> 兼容层只是把它接到 KToolBox WebUI 契约上，**不改动引擎内部**。改代码前先读本节。

**分层与依赖方向（严格单向，禁止反向/旁路）：**

```
npm run web / node server.js          ← 入口装配：协议注册 + 路由 + 调度器启动
        │
        ▼
adapters/KToolBox-webui.js            ← 协议适配器（翻译层）：HTTP 请求/响应契约翻译；
        │                              不承载下载业务，不直接 require cli.js
        ▼
core.js                               ← 兼容层业务内核：任务状态机/调度器/abort/auto-sync/
        │                              progressReducer 聚合、事件合成（onEvent 输出层补契约字段）、
        │                              SQLite 持久化；内部 require cli.js 复用下载引擎
        ▼
cli.js                                ← 独立下载引擎（零依赖 npm 包；node: 内置模块 fs/path/
                                          child_process/crypto + 本地模块 progress.js（下载进度条，
                                          唯一被 require 的本地文件））：索引拉取→去重→下载→解析
                                          全流程自含，可 `node cli.js <url>` 独立运行
```

**职责边界（谁做什么）：**

| 层 | 文件 | 职责 | 禁止事项 |
|---|---|---|---|
| 下载引擎 | `cli.js` | 索引断点续拉、pawchive-index.html 生成、内容寻址硬链接去重、下载（curl 子进程）+ 断点续传 + abort、网盘 provider、命名/落盘、TTY 进度、自然事件上报（`emit`：job.*/download.*/post.*） | 不携带 WebUI 契约字段（key/completed 等合成留给 core）；不 require 上层模块 |
| 兼容层内核 | `core.js` | 任务/attempt 状态机（CREATE→RUNNING→completed/aborted/error）、调度器（blocked 资源锁排队）、abortCtl 级联真中断、auto-sync 计划+查重、progressReducer 累计统计、onEvent 输出层合成前端契约字段（download.* 补 key、finished 补 completed_bytes/total_bytes/elapsed_seconds/average_speed_bps、任务级 creator.started/finished）、EventStore 持久化 | 不实现下载/去重/解析逻辑（这些在 cli 引擎） |
| 协议适配器 | `adapters/*.js` | HTTP 路由匹配、请求解析、响应序列化（json/SSE）、调用 core 业务 API；`scripts/KToolBox-env-compat.js` 是 env 翻译中枢（双向映射，兼容层强制读） | 不承载下载业务、不直接 require cli.js |
| 入口 | `server.js` | 协议选择（PAWCHIVE_WEB_PROTOCOL）、HTTP 服务、装配 core+adapter、调度器启动（startTaskScheduler/startAutoSyncScheduler） | — |

**纪律（改代码前必读）：**

1. **cli.js 不到万不得已禁止改动**——它是独立下载工具，兼容层需求（WebUI 契约字段、事件类型转换）一律在 core.js 输出层/适配器实现。
2. **引擎功能只进 cli.js**：索引、去重、下载、解析、网盘等下载能力永不移入兼容层。
3. **依赖方向单向**：server → adapters → core → cli；任何反向 require（cli 引用 core/adapters、adapter 直接 require cli）都是架构违规。
4. **事件契约边界**：cli.js 只发自然事件（下载流程自含字段）；WebUI 需要的契约字段（filename→key、completed_bytes、elapsed、speed 等）由 core.js `onEvent` 输出层合成，**永不塞回 cli**。
5. **scripts/*.js 独立工具**可复用 cli.js 导出（migrate.js/clean-bot.js 均 `require('../cli.js')`），但同样禁止反向依赖。

## 用法

```bash
node cli.js <url> [path] [--dryrun] [--offset N] [--length N] [--concurrency N] [--index <索引文件>]
```

| 参数 | 说明 |
|------|------|
| `url` | Pawchive 页面 URL：创作者页 `https://pawchive.pw/{service}/user/{creator_id}`，或单帖页 `https://pawchive.pw/{service}/user/{creator_id}/post/{post_id}`；也支持省略协议/主机的相对路径（如 `patreon/user/96944064`，自动补全 `https://pawchive.pw/`） |
| `path` | 下载目标根目录（**可选**——省略时读 `.env` 的 `PAWCHIVE_DATA_ROOT`，两者皆无则报错提示） |
| `--dryrun` | 只拉 API 生成并打印下载计划（含已存在标记、关联渠道），不写任何文件 |
| `--length N` | 只处理最新 N 个帖子（如 `--length 10` = 最新 10 帖） |
| `--offset N` | 从第 N 个帖子开始（配合 `--length` 分批） |
| `--concurrency N` | 并发下载数（默认 1 串行，受 TPS 限速约束） |
| `--index <文件>` | 直接读已有索引文件（`/.pawchive/*.index.json`）生成计划下载，0 API 请求 |

### 示例 1：单帖下载（先模拟再真实）

```bash
node cli.js "https://pawchive.pw/patreon/user/96944064/post/166151636" "/volume1/VirtualDSM/(Pawchive)/Pawchive" --dryrun
node cli.js "https://pawchive.pw/patreon/user/96944064/post/166151636" "/volume1/VirtualDSM/(Pawchive)/Pawchive"
```

单帖同样落到 `<创作者名>/<帖子标题>/` 结构（实测 `RenKamui/[Genshin] Nicole_ Standard Nude Mod/`），与全量下载共享 hash 去重。

### 示例 2：创作者全量同步（先模拟再真实）

```bash
node cli.js "https://pawchive.pw/patreon/user/96944064" "/volume1/VirtualDSM/(Pawchive)/Pawchive" --dryrun
node cli.js "https://pawchive.pw/patreon/user/96944064" "/volume1/VirtualDSM/(Pawchive)/Pawchive"
```

### 示例 3：省略 path（读 .env 的 PAWCHIVE_DATA_ROOT）+ 相对路径

```bash
node cli.js "patreon/user/96944064" --dryrun    # path 从 .env 读，URL 自动补全域名
node cli.js "patreon/user/96944064"             # 真实下载
```

> `.env` 需配置 `PAWCHIVE_DATA_ROOT=/volume1/VirtualDSM/(Pawchive)/Pawchive`（webui 默认输出同源）。

## 落盘结构

```
<path>/
├── <创作者名>/                  # 大小写冲突时自动加 (平台) 前缀，如 (patreon) Akt
│   ├── pawchive-index.html      # 创作者级总览索引（帖子导航 + 关联渠道 + JSON 机读块）
│   └── <帖子标题>/
│       ├── pawchive-index.html  # 帖子级索引（标题/meta/文件表/正文 + JSON：文件 hash 登记）
│       ├── <文件>               # 全部文件平铺在帖子目录（不建 attachments/ 子目录），服务端真实文件名
│       └── ...                  # 主文件与附件同目录；同 hash 同名自动去重
└── .pawchive/                   # 拉取索引（分页游标/断点续拉），与 html 索引并存分工
```

索引 html 文件名由环境变量 `PAWCHIVE_INDEX_FILENAME` 配置（默认 `pawchive-index.html`）。

## 拉取索引（断点续拉）

分页拉取帖子时**每成功一页立即原子落盘**到 `/.pawchive/<service>-<userId>.index.json`（已拉帖子 + 游标 `next_offset` + `done` 标记）。中断重跑从游标续拉；缓存覆盖需求时 0 API 秒出。

## pawchive-index.html（gbmd 式索引，去重登记源）

每个帖子目录与创作者目录各一份 `pawchive-index.html`（文件名可配），**双结构**（对齐 gbmd description.html）：

- **人读**：
  - 标题 / meta（平台·作者·发布时间·原链接·本地目录）
  - **图片**：图片墙缩略图（img 真实显示）
  - **视频**：内嵌播放器（`<video controls>` 直接可播）
  - **压缩包**：📦 卡片（文件名·大小·下载链接）
  - **文件列表表**（类型·真实文件名·大小·状态）+ **正文**
- **机读**：`<script id="pawchive-index" type="application/json">` 内嵌 JSON：帖子元数据 + `files[]`（**serverPath=SHA-256 hash 路径 + rel 相对位置 + kind 类型**）→ 即**去重登记**

路径全部**相对目标根**（不写绝对路径），目录迁移后索引依然有效。

## 文件去重（内容寻址 + 硬链接）

Pawchive 文件路径是 SHA-256 内容寻址（`/<2位>/<3位>/<64位hash>.<ext>`）——**同文件必同 hash 路径**，是比文件名/标题/作者名更硬的判据（名称全变而内容相同也能识别，实测跨渠道同内容文件）。

- 下载前扫描目标树已有 `pawchive-index.html` 聚合**全局 hash 索引**（Map<serverPath, savePath>）
- 命中 → `fs.link` **硬链接**到本位置（0 下载；NFS 服务端不支持时自动回退复制）
- 并发同 hash → **in-flight 锁**（等首个下载完成再链接）
- 跨作者/跨平台/跨帖子共享文件只下载 1 份，其余位置硬链接复用
- 重复下载重跑 → 目标已存在跳过

## 同作者跨渠道（links 关联）

`GET /{service}/user/{id}/links` 返回同作者全部渠道账号（跨平台 + 同平台分号），实例：Akt / AnimationAkt_SP / akt 三号一人。CLI 打印「关联渠道」并写入创作者级 html；三号各自独立文件夹，内容按 hash 去重共享。

## 下载特性

- **进度统计语义（已处理/全部）**：任务统计「文件」显示 `已处理 / 全部`，其中**已处理 = 全部 - 失败**（失败的文件单独计 failed_files，不算已处理）——与 KToolBox 原版语义不同，为我们的自定义约定
- **拉取索引**：分页每页落盘 `/.pawchive/*.index.json`，中断续拉、缓存复用；**作者更新检测**——全量缓存（done）每次运行拉最新一页校验，作者发新帖自动失效重拉
- **下载流程（并行，每帖 html 前置/后置）**：每帖先生成 `pawchive-index.html` → 大小校验（与 html 记录 size 对比，不符=损坏覆盖）→ 下载（.tmp 断点续传 + Content-Length/Content-Range 头解析作完整性校验，376B 反爬占位与 404 页面不落盘）→ 帖下载完刷新帖 html **并同步刷新创作者级总览 html**（每帖都刷新，含全跳过帖）
- **并行下载**：并发数由 `--concurrency`/`PAWCHIVE_CONCURRENCY` 控制（默认 5，file host 活动下载上限），**持续维持并发数**（完成一个立即补位，非组式等待）；帖启动间隔防 API 解析连发
- **快速跳过**（`PAWCHIVE_FAST_SKIP=1` 开启，**默认关**）：下载前读创作者级 html 的帖子总览（fileCount/downloaded），已完整下载的帖直接跳过、不解析详情——**默认关 = 历史帖全量 getPost 检查**，保证早期未录外链/网盘的帖能重新识别补下载
- **查重跳过**：目标已存在**且大小与 html 记录一致**才跳过；存在但大小不符 → 覆盖重下（.tmp 续传）；**无记录但文件存在 → 保守跳过**（历史下载文件不重下、不覆盖）
- **断点续传**：写入 `<文件>.tmp`，中断重跑从断点继续；失败自动重试（**HTTP 4xx/5xx 确定性失败不重试**，网络错误重试；带 UA，File host Range 续传实测 9.4MB/s）
- **大小写冲突**：不同渠道作者名仅大小写不同（Akt vs akt）时自动加「(平台)」前缀（如 `(patreon) Akt`，前缀格式由 `PAWCHIVE_CREATOR_PREFIX_FORMAT` 配置），兼容大小写不敏感文件系统；同名不同大小写的创作者目录**共用同一目录**（下载按文件级去重，不会覆盖已有内容）
- **同名文件后缀**：同帖内同名不同内容（不同 hash）的文件自动加后缀区分（如 `image-1_4535755.png`，后缀模板由 `PAWCHIVE_FILENAME_SUFFIX_FORMAT` 配置，`{size}`=文件大小，无大小退序号），防互相覆盖
- **缩略图回退**：原图 404（源站失效链接）时自动回退下载 `img.pawchive.pw/thumbnail/` 缩略图（文件名加 `_thumb` 标记，如 `image-1_thumb.webp`），原图恢复后重跑自动换回原图并清理旧缩略图
- **外链表格**：帖子级 html 正文里的外部链接（http/https，一般是网盘下载地址）自动统计成表格（# / 链接 / 域名）
- **网盘下载**：正文里的 Google Drive / Dropbox 链接自动下载（**provider 注册表可扩展**：mega/baidu 等加一个 provider 即可）——下载后记录进帖 html（文件列表 + 机读块），**内容 sha256 跨帖去重复用**（硬链接）；**正文里的网盘链接 a 标签本地化**（指向本地文件），外链表格保持原始 URL；**大文件病毒扫描确认页自动处理**（识别后带 confirm 重下）；**支持断点续传**（.tmp + Range 续传，确认页残留自动清理）
- **TPS 限速（反爬）**：默认每秒最多 1 个新连接（`PAWCHIVE_TPS`；file host 明示要求 ≤1 req/s，超速返回 376B 占位）
- **完整性校验**：下载完成比对落盘大小与响应头（Content-Range/Content-Length）；**376B=反爬占位、404 错误页均删除不落盘**
- **分页拉取**：每页 50 条（Pawchive 分页参数 `o`，stepping of 50 enforced；页间默认 1s 间隔防连发）
- **传输策略**：curl HTTP/1.1 + 浏览器 UA + `-f`（HTTP 错误不落盘）（File host 对 Node TLS 指纹与无 UA 的 Range 请求限速；带 UA 的 HTTP/1.1 实测 9.4MB/s）
- **KToolBox 环境兼容**：兼容 [KToolBox](https://github.com/Ljzd-PRO/KToolBox)（作者 Ljzd-PRO 的 Pawchive 下载工具箱——WebUI/CLI/Python 客户端）的**部分 `.env` 设置与 `ktoolbox.toml` 命名模板**——`scripts/KToolBox-env-compat.js` 独立兼容层（不改 cli.js），两种用法：
  - **一次性导出（推荐，之后 cli 连续直接用）**：
    ```
    node scripts/KToolBox-env-compat.js --gen-env                    # 打印映射后的 PAWCHIVE_*（KEY=VALUE）到 stdout
    node scripts/KToolBox-env-compat.js --gen-env .env               # 直接写入 cli 同目录 .env（注意：覆盖整个文件，先备份/自行合并）
    node scripts/KToolBox-env-compat.js --gen-env ktool-mapped.env   # 写独立文件，内容手动合并进 .env
    ```
    跑一次拿到 `PAWCHIVE_*` 键值后，之后直接 `node cli.js <参数>` 连续使用（cli 读 `.env`）。
  - **同参数调用 cli（每次启动时注入映射后透传，与 cli.js 参数完全一致）**：
    ```
    node scripts/KToolBox-env-compat.js "https://pawchive.pw/patreon/user/96944064" /path/to/downloads
    ```
  - 指定 KToolBox 配置路径：`KTOOL_ENV=/path/to/ktool/.env KTOOLBOX_TOML=/path/to/ktoolbox.toml node scripts/KToolBox-env-compat.js --gen-env`（默认 `docs/.probe-ktoolbox/.env` 与 `docs/.probe-ktoolbox/ktoolbox.toml`）
  - 映射项：并发 `KTOOLBOX_JOB__COUNT`→`PAWCHIVE_CONCURRENCY`、文件 host `KTOOLBOX_DOWNLOADER__FILES_NETLOC`→`PAWCHIVE_FILES_BASE`（自动补 https://）、前缀 `KTOOLBOX_DOWNLOADER__FILE_PATH_PREFIX`→`PAWCHIVE_FILES_PREFIX`、API `KTOOLBOX_API__SCHEME/NETLOC/PATH`→`PAWCHIVE_API_BASE`、命名模板 `creator_dirname_format`→`PAWCHIVE_CREATOR_DIR_FORMAT`、`post_dirname_format`→`PAWCHIVE_POST_DIR_FORMAT`、`filename_format`→`PAWCHIVE_FILENAME_FORMAT`（变量 `{creator_name}/{creator_id}/{service}/{title}/{post_id}` 双向兼容）
  - 优先级：已有 `PAWCHIVE_*` > KToolBox 映射 > 本项目 `.env` > 默认值

- **WebUI 协议切换兼容层**（`server.js`，零依赖）：KToolBox 前端（`webui-static` bundle）直接接我们 Node 后端——协议注册表（`PAWCHIVE_WEB_PROTOCOL` 默认 `KToolBox-webui`；`native` 预留）+ 适配器（`adapters/`，翻译层）→ `core.js` 业务内核（复用 cli 下载引擎）→ SQLite（`webui.db`：任务/事件/创作者 enabled 等持久化，**固定库重启状态保持**）
  - 启动：`node server.js`（端口 `PAWCHIVE_WEB_HOST/PORT` 默认 `0.0.0.0:8789`；DB `PAWCHIVE_WEB_DB` 默认项目根 `webui.db`——**保持固定库，重启不丢创作者开关/任务/事件状态**）
  - 端点覆盖：session 放行（无登录）/ creators（列表+头像+编辑 `enabled`「纳入全量同步」持久化 + **DELETE 软删**（removed 标记——列表排除——目录保留可恢复）+ **创作者搜索**：Pawchive `/creators` 全量缓存 `.pawchive/creators-cache.json` + 过滤）/ tasks（创建 URL+fields+sync creators 双格式、下载执行、进度、事件 SSE）/ filesystem 选路径（project scope 防路径穿越）/ naming 模板映射（**env 中枢读取**——`PAWCHIVE_*_FORMAT`/INDEX_FILENAME/REVISIONS_SUBDIR）+ 保存写配置 / config schema 26 字段+dotenv / posts 详情代理 / **修订版本下载**（默认开——`PAWCHIVE_INCLUDE_REVISIONS`——每修订版存 `帖目录/revisions/<revision_id>/`——dryrun 支持）/ **legacy-migration 真实迁移**（migrate.js 双向 + `--to-ktool` 反向）/ blockers 空对齐（无对应业务）/ **auto-sync 真实实现**（自动按作者下载：计划 CRUD + 定时器每分钟扫描到期触发 sync 任务 + run/pause/resume——schedule 简化为 interval{every,unit}——queued_files 对齐原版 job.queued 累计）/ client-error 错误上报（**①层注入已生效**：server 静态注入 window.onerror/unhandledrejection/资源 error 三件套 → `/api/v1/client-error` → `.client-errors.jsonl` → AI tail 定位——null.values 类前端崩即时落盘——过滤浏览器扩展源）/ **DEBUG 启动自检**（`PAWCHIVE_WEB_DEBUG=1`——启动自动测 11 核心端点写日志）
  - **env 翻译中枢**（`scripts/KToolBox-env-compat.js`——双向映射库）：`readPawchiveEnv()`（PAWCHIVE_* → 配置对象）/ `toKToolBox()`（反向——KToolBox 兼容我们，写真实值）/ `writeEnv()`（.env 写）——兼容层 env 相关全走它；探测 KToolBox 配置按原版同款（`KTOOLBOX_PROJECT_CONFIG` → toml 目录，`.env`/`prod.env`/`ktoolbox.toml` 同目录）；cli 不动（自读 env）
  - 测试：`node test/webapi.test.js`（约 26 项断言）+ `node test/contract-check.js`（openapi 契约字段校验）+ `node test/contract-scan.mjs`（前端读取 vs 后端响应一键扫描）+ `test/e2e-webui.mjs`（playwright，`E2E_CHROME`/`PWVIEWER_PLAYWRIGHT` env 化）

**硬链接迁移语义**：同卷 `mv` 保留硬链接（inode 不变）；跨设备 `mv`/普通复制会解开成独立拷贝——**数据永不失**，只是重复文件恢复各自占用空间（本项目重复文件极少）。迁移建议整目录 `mv` 或 `rsync -H`。

## 命名模板（环境变量）

| 变量 | 可用变量 | 默认 |
|------|----------|------|
| `PAWCHIVE_CREATOR_DIR_FORMAT` | `{creator_name}` `{creator_id}` `{service}` | `{creator_name}`（跨渠道相同时自动合并目录） |
| `PAWCHIVE_POST_DIR_FORMAT` | `{title}` `{post_id}` `{service}` `{creator_id}` `{published}` `{added}` | `{title}` |
| `PAWCHIVE_FILENAME_FORMAT` | `{}` = 原文件名 | `{}`（保留配置但默认不启用，下载用服务端真实文件名） |
| `PAWCHIVE_INDEX_FILENAME` | - | `pawchive-index.html`（帖子/创作者索引 html 文件名） |
| `PAWCHIVE_CREATOR_PREFIX_FORMAT` | `{service}` | `({service}) `（大小写冲突时目录前缀，如 `(patreon) Akt`） |
| `PAWCHIVE_FILENAME_SUFFIX_FORMAT` | `{size}` | `_{size}`（同帖内同名不同内容文件的后缀，如 `image-1_4535755.png`；无大小退序号） |

## 环境变量

| 变量 | 默认 | 说明 |
|------|------|------|
| `PAWCHIVE_API_BASE` | `https://pawchive.pw/api/v1` | API 地址 |
| `PAWCHIVE_FILES_BASE` | `https://file.pawchive.pw` | 文件下载 host |
| `PAWCHIVE_FILES_PREFIX` | `/data` | 文件路径前缀 |
| `PAWCHIVE_THUMB_BASE` | `https://img.pawchive.pw/thumbnail` | 原图 404 时缩略图回退 base |
| `PAWCHIVE_DOWNLOAD_DRIVE` | `1` | 下载正文网盘链接（0=关；provider 可扩展） |
| `PAWCHIVE_FAST_SKIP` | `0` | 快速跳过已完整帖（1=开；默认关=全量检查补漏录外链/网盘） |
| `PAWCHIVE_ANTIBOT_SIZE` | `376` | 反爬占位大小（file host bot 提示字节特征） |
| `PAWCHIVE_404_PAGE_MAX` | `4096` | 404/错误页判定阈值（小于此大小才读头部判断） |
| `PAWCHIVE_CURL_CONNECT_TIMEOUT` | `30` | curl 连接超时秒（下载与流式请求统一） |
| `PAWCHIVE_WEB_BASE` | `https://pawchive.pw` | 网页基址（原链接/创作者页 href） |
| `PAWCHIVE_TEMP_SUFFIX` | `.tmp` | 断点续传临时文件后缀 |
| `PAWCHIVE_USER_AGENT` | Chrome 126 UA | 下载/探测请求 UA（file host 要求可识别 UA） |
| `PAWCHIVE_TPS` | `1` | 每秒新建连接上限（反爬要求 ≤1） |
| `PAWCHIVE_PAGE_INTERVAL_MS` | `1000` | 列表翻页间隔（防连发限流） |
| `PAWCHIVE_RETRY_TIMES` | `10` | 下载重试次数 |
| `PAWCHIVE_RETRY_INTERVAL_MS` | `3000` | 下载重试间隔 |
| `PAWCHIVE_SLOW_SPEED_KB` / `SLOW_DETECT_MS` / `SLOW_WAIT_MS` / `SLOW_MAX` | `5`/`10000`/`60000`/`3` | 慢速退避与反爬长等待参数 |
| `PAWCHIVE_DATA_ROOT` | 空 | 默认输出根目录（cli 参数 `path` 优先） |
| `PAWCHIVE_CURL` | 自动探测 | curl 可执行文件路径（Alpine/BusyBox/NAS 可显式指定） |
| `PAWCHIVE_LOG` | `./pawchive.log` | 日志文件路径 |
| `PAWCHIVE_ATTACHMENTS_SUBDIR` | 空（帖根） | 附件子目录（naming 页附件目录字段） |
| `PAWCHIVE_INCLUDE_REVISIONS` | `1` | 修订版本下载开关（0=关；`PAWCHIVE_REVISIONS_SUBDIR` 默认 `revisions` 子目录） |
| `PAWCHIVE_WRITE_CREATOR_INDEX` | `1` | 创作者索引 html 开关状态（仅供前端显示——代码强制启用，`pawchive-index.html` 决定去重/网盘下载） |
| `PAWCHIVE_CREATORS_TTL_DAY` | `7` | 创作者搜索缓存 TTL 天数 |
| `PAWCHIVE_WEB_PROTOCOL` / `HOST` / `PORT` | `KToolBox-webui` / `0.0.0.0` / `8789` | WebUI 兼容层：协议选择 / 监听地址 / 端口 |
| `PAWCHIVE_WEB_DB` | `./webui.db` | 兼容层 SQLite 库（固定库重启不丢状态） |
| `PAWCHIVE_WEB_DEBUG` | 空 | `1` 开启启动端点自检（11 核心端点写日志） |
| `PAWCHIVE_STRICT_VERIFY` | `0` | 强校验模式：`1`=下载完计算本地 sha256 vs 目标 serverPath hash（不符优先修复重下——不保留坏文件） |
| `PAWCHIVE_LOCK_DIR` | `<数据根>/.pawchive/locks` | 跨进程文件锁目录（同文件并发多 cli 防重复下载） |

完整变量模板见 `env.example`。

## MCP（AI 接入）

**MCP server 供 AI 使用**（DSH 等 MCP 客户端 stdio 拉起，即可 tools/list + tools/call 调用下载器能力——建任务/查任务/搜创作者/auto-sync，无需 curl）：

```bash
node mcp-server.js   # stdio MCP 协议（无参数）
```

- **协议**：MCP JSON-RPC 2.0，零依赖手写（initialize / tools/list / tools/call / ping），不引入 SDK
- **工具面**：32 个（任务全套 12 / 创作者 5 / auto-sync 8 / 查询配置 5 / blockers 空对齐 2），复用 core.js 业务能力——第三个协议面（引擎 cli / 业务 core / 协议 adapter + MCP server）
- **鉴权**：v1 无鉴权（本地 stdio 受控环境）；设 `PAWCHIVE_MCP_TOKEN` 后启用 Bearer——tools/call 参数须带 `token` 匹配（env.example 已含）
- **DSH 接入**：Settings → MCP 添加 stdio server，`command: node`、`args: [<项目路径>/mcp-server.js]`；AI 会话即出现 Pawchive 工具组

工具一览（`tools/list` 返回含 description/inputSchema/annotations）：

| 组 | 工具 |
|---|---|
| 任务 | list_tasks / get_task / task_attempts / task_events / create_task / update_task / delete_task / pause_task / stop_task / resume_task / rerun_task / cleanup_preview |
| 创作者 | list_creators / search_creators / add_creator / update_creator / delete_creator |
| auto-sync | list/get/create/update/pause/resume/run_automatic_sync_plan / list_automatic_sync_runs |
| 查询配置 | get_naming / config_schema / search_works / post_details / get_pawchive_version |
| blockers | list_blockers / replace_blockers（空对齐——无屏蔽业务） |

> 架构定位：MCP server 与 WebUI 兼容层（server.js+adapter）并行，均复用 core.js，互不冲突——前端交互走 HTTP、AI 调用走 stdio MCP。

### 实测结果（2026-10-01，32 工具全过）

| 组 | 实测 |
|---|---|
| 任务 | list_tasks / get_task / task_attempts / task_events / create_task / update_task / pause / stop / resume / rerun / delete / cleanup_preview ✅（建→查→控→重跑→删全链路） |
| 创作者 | list_creators **7 条真实作者** / search_creators（name=ViciNeko 1 条、service=patreon 100 条）/ add / update / delete ✅ |
| auto-sync | 计划 create/get/update/pause/resume/run（触发建 sync 任务）/delete ✅ |
| 查询配置 | get_naming（真实 dataRoot）/ config_schema / search_works（拉作者作品列表）/ post_details / get_pawchive_version ✅ |
| blockers | list_blockers → []、replace_blockers → 空对齐提示 ✅（无屏蔽业务） |

实测发现并修复 3 处：①list/search_creators 需传 DATA_ROOT（core 函数签名 require targetPath）②run_automatic_sync_plan 的 creators 需转 `service:creator_id` 字符串（trigger 按 split(':') 解析）③rerun_task 清错列名 error/failure_json（tasks 表列名，非 failure）。全部工具实测通过后清理测试数据，不污染真实 DB。

## 验证状态

- [x] API 实测：创作列表/详情/档案/links/分页（`o` 参数）免登录 JSON
- [x] dryrun：178 帖 → 711 文件计划；三号作者独立文件夹 + 关联渠道展示
- [x] 索引断点续拉：中断续拉（50→178）、done 后 0 API 秒出
- [x] 真实下载小样本：DLC2609 帖 4 文件（HTTP/1.1+UA 成功下载）、银狼帖断点续传（.tmp 376B → 续传完成）
- [x] pawchive-index.html 生成（帖子级+创作者级，postDir 相对路径，图片/视频/压缩包真实显示，JSON kind）
- [x] 文件平铺落盘（无 attachments/ 子目录）、索引文件名配置化（PAWCHIVE_INDEX_FILENAME）
- [x] 大小写冲突自动加 (平台) 前缀（`(patreon) Akt`）
- [x] 跨文件夹内容重复实测：RenKamui 双平台 2 个同 hash；三号作者 6 个同 hash
- [ ] 全量下载三个作者（约 274 文件，跨文件夹 hash 去重硬链接全链路）待运行

## 未来规划

- 项目定位 = **CLI 下载器 + WebUI 兼容层**：CLI 持续增强（并发调度、反爬自适应限速、全量同步调度、更多平台适配）；WebUI 兼容层（KToolBox 前端接我们 Node 后端——协议切换）已落地（见上）；上游 API 文档类产物由提取工具维护（见 `docs/` 留档）

## 版本记录

| 版本 | 日期 | 说明 |
|---|---|---|
| v1.0.0 | 2026-10-01 | **MCP server（供 AI 使用）**：新增 `mcp-server.js`——stdio 传输、零依赖手写 MCP JSON-RPC（initialize/tools/list/tools/call），复用 core.js 业务能力暴露 **32 个 MCP 工具**（任务全套 12 / 创作者 5 / auto-sync 8 / 查询配置 5 / blockers 2）；v1 无鉴权 + env `PAWCHIVE_MCP_TOKEN` 可选 Bearer；DSH 等 MCP 客户端 stdio 拉起即可用（第三个协议面——引擎 cli / 业务 core / 协议 adapter+MCP server） |
| v0.9.0 | 2026-09-30 | 审计提分批次：真魔数提取（CONFIG fetchTimeoutMs/netdiskKeepMinBytes/probeWindowMs + MAGIC 常量）、单字母变量全量重命名（cli/core/adapter/server/scripts 约 50 处）、高复杂度函数抽公共（downloadNetdiskFiles/downloadCreatorAvatars/buildHashIndex 拆子函数）、empty-catch 补语义注释、进度条独立模块 progress.js、审查缺陷修复（downloadRevision abortCtl/跨进程锁/缓存键） |
| v0.8.0 | 2026-09-30 | 文档整理批次：14 份审计/排查/调查/核对文档合并升级为 `docs/调查审计与行为核对-权威指南.md`（权威现状速查 22 项已修复 + 5 项仍开放 + 历史来源索引可追溯）；新增 3 份设计指南（`行为对齐-设计指南`/`KToolBox-bugfix-PR设计指南`/`KToolBox前端接入-设计指南`）；cli.js 跨进程锁死锁检测增强（锁读 pid → /proc/<pid> 存活判定，进程死立即解锁而非等 24h 过期）；fast-skip-benchmark 措辞清理；docs 旧调查文档移除 |
| v0.7.0 | 2026-09-30 | CLI 网盘链接重构 + 本地索引刷新（extractContentLinks/matchNetdiskLink/buildNetdiskFileMap 提取复用、refreshPostIndexLocal 无网络本地刷新帖索引）+ fast-skip-benchmark 基准测试 |
| v0.6.0 | 2026-09-30 | 收尾批次：任务调度器+rerun（startTaskScheduler/scheduleTick 排队/blocked）、auto-sync checkpoint 增量、delete outputs 安全清理、统计语义（已处理/全部）、事件中文 message、0B transferred/卡 running 修复、断链修复（attempt seq/scheduleTick 透传 spec/waiting_retries/active_creators/事件契约移至兼容层）、架构边界文档化、等待重试面板、已传输超总量修复 |
| v0.5.0 | 2026-09-29 | 行为对齐批次一+二（合并）：.tmp 分类处理、progressReducer 累计统计、任务创建去重 409、强校验模式、任务真中断 abortCtl、跨进程文件锁、前端 P1 数据修复、P2 端点补全、事件类型对齐/节流/快照/presentation、孤儿 curl 防护、API 第三轮 |
| v0.4.0 | 2026-09-29 | 兼容层功能完整：posts 详情代理、env 翻译中枢（KToolBox-env-compat 双向）、创作者搜索（fetchAllCreators 缓存 7 天）、naming 保存写配置、config schema 26 字段、auto-sync 真实实现、①层前端错误捕获、全站 null.values 修复、前端修复 bundle 替换 |
| v0.3.0 | 2026-09-28/29 | 协议切换兼容层完成：server/core/adapters 端点全覆盖（349 行 adapter）+ 作者头像下载 + webui-static 前端静态入库 + 测试三件套（webapi/contract-check/e2e-webui） |
| v0.2.0 | 2026-09-28 | 引擎成熟：快速跳过防漏网盘、附件子目录开关、dryrun 目录模拟、KToolBox 兼容层雏形（--gen-env + env-compat）、migrate 双向迁移、TTY 图形进度条、缩略图已存在跳过、全量审计优化 |
| v0.1.0 | 2026-09-28 | 初始 CLI 引擎：Pawchive 全平台作品下载（并行下载/双级 html 索引/反爬防御/网盘集成/断点续传） |