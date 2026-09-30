# KToolBox v1.1.0-beta.1 全量审计报告

> 审计日期：2026-09-29
> 审计对象：`.probe-ktoolbox/`（GitHub Ljzd-PRO/KToolBox master 分支完整 clone，`pyproject.toml` 版本 v1.1.0-beta.1）
> 审计方式：通读核心源码（约 2.06 万行 Python）+ 抽查前端/测试/文档 + 静态验证；未安装运行（本机 Python 3.8.15 < 要求的 3.10，**未实测运行**，运行类结论均标注）
> 审计背景：将 KToolBox 能力转写/对照到本仓库 Node 项目（cli.js 已实现下载/去重/索引；计划自建 Node 后端 + 复用 KToolBox WebUI 前端），本文档用于决定借鉴什么、规避什么、哪些功能是坑。

**总体印象**：工程化程度远超一般开源下载器——类型标注完整、351 个测试、覆盖率门槛 85%、文档多语言同步、安全设计认真（Argon2/CSRF/限流/路径穿越防护/SSRF 防护）。但**体量过大、依赖过重、多个重功能处于 beta 未验证状态**，作为"转写蓝本"需要大量裁剪。

---

## 一、架构/设计

| # | 不足描述 | 严重度 | 证据 | 对我们的启示 |
|---|---------|--------|------|-------------|
| A1 | **单体应用 + 三个入口共享一套核心**（CLI/WebUI/Python API 都直接调用 action/job 层），WebUI 服务把任务/命名转换/自动同步/媒体代理全塞进一个 FastAPI app，`naming_service.py` 单文件 2342 行、`config_locale_catalogs.py` 652 行、`task_store.py` 612 行，模块边界模糊 | 中 | `ktoolbox/webui/naming_service.py`(2342 行)、`ktoolbox/webui/task_store.py`(612 行) | 借鉴其"核心动作层（action/job/downloader）与入口解耦"的思想，但我们的 Node 版要避免 WebUI 侧巨型单文件 |
| A2 | 配置系统**三层叠加**：`ktoolbox.toml`（ProjectConfigStore，schema 5）+ `.env`/`prod.env`（dotenv）+ 环境变量（pydantic-settings 前缀 `ktoolbox_`、嵌套 `__`），且 `Configuration` 顶层 `extra="ignore"`——**配置拼写错误被静默吞掉**，不报错 | 中 | `ktoolbox/configuration.py:408-414`（extra="ignore"）、`ktoolbox/project_config.py:324`（schema_version=5，upgrade 逻辑 333-336 行） | Node 版用单一 `config.json` + 环境变量覆盖即可；schema 版本化 + 自动升级是可借鉴的好设计 |
| A3 | 全局配置用 `ContextVar` 代理（`config` 是 `_ActiveConfigurationProxy`），跨异步任务靠 `configuration_scope` 隔离——设计正确但心智负担高，且 `config.__setattr__` 允许运行时改全局配置 | 低 | `ktoolbox/configuration.py:425-461` | 不必模仿；我们 Node 版用进程级单例即可 |
| A4 | **扩展性靠"注册表模式"**（blocker 注册表），但当前只注册了 `field-match` 一种 blocker 类型，规则引擎能力被文档放大（README 无此声明，但 docs 里 blockers 是 v1 卖点之一） | 低 | `ktoolbox/blocker/engine.py:68-69`（仅 1 个注册类型） | 借鉴注册表+选项模型校验（`registry.validate`），我们转写时可以只做 field-match 子集 |
| A5 | `keywords_exclude` 已弃用但仍保留完整代码路径 + 日志警告（迁移提示），弃用与并存造成两套过滤逻辑 | 低 | `ktoolbox/action/job.py:495-499` | 转写时直接丢弃，用 blocker 统一 |

## 二、功能缺陷（README 声称 vs 实现）

| # | 不足描述 | 严重度 | 证据 | 启示 |
|---|---------|--------|------|------|
| B1 | **版本自述 beta + README 自己声明"v1 尚未经过足够广泛的实际验证，部分功能仍可能出错"**（README.md:16-19），命名转换、自动同步、MCP、blockers 全是 v1 新增 | 高 | `README.md:16-19`、`CHANGELOG.md`（v1.1.0-beta.1 为"validates the first post-v1 migration fixes"） | **不要直接照搬 v1 全部功能**；优先验证下载+去重+索引主链路 |
| B2 | **CLI 每次运行都访问 GitHub API + PyPI 检查更新**（两次串行网络请求，各 5s 超时），离线/内网环境每次启动都浪费 0-10s | 中 | `ktoolbox/utils.py:240-285`（`check_for_updates`，GitHub 失败再 fallback PyPI） | 我们 Node 版去掉或做成 `--check-update` 显式开关 |
| B3 | **urwid 配置编辑器是可选依赖**（`pip install ktoolbox[urwid]`），未安装时 CLI `config edit` 报错引导安装——README/文档未突出此依赖门槛 | 低 | `ktoolbox/cli.py:95-109`（ModuleNotFoundError 分支） | 不转写；我们的配置页走 WebUI |
| B4 | WebUI 首次启动**生成随机密码 + 自动弹浏览器**（`open_browser` 默认 True），无桌面环境的服务器上 `webbrowser.open` 在 `threading.Timer` 里被静默吞掉异常，用户以为没启动 | 中 | `ktoolbox/configuration.py:368`（open_browser=True）、`ktoolbox/webui/server.py:88-89` | Node 版默认不弹浏览器，密码首启打印到日志+文件 |
| B5 | 自动同步存在**"运行中任务冲突则跳过本次调度"**的行为（`mark_skipped`），长时间任务会静默丢调度，无用户通知界面外的告警 | 中 | `ktoolbox/webui/auto_sync_scheduler.py:151-158` | 借鉴 checkpoint+窗口重叠（CHECKPOINT_OVERLAP=24h）设计，但跳过要有可见记录 |
| B6 | 命名转换（目录迁移）是**最重的 WebUI 功能**：全目录扫描 post.json + 文件指纹 + 后台 worker + 可回滚，复杂度过高，且 `_ensure_preview_current` 用三重校验（配置 revision + 布局 revision + 文件系统指纹）防过期——预览很容易因任何变化失效 | 中 | `ktoolbox/webui/naming_service.py:1214-1228`、`1504`（`_scan_download_roots`） | **我们不需要 v0→v1 命名迁移**（无历史包袱），直接砍掉 |

## 三、下载引擎（重点）

| # | 不足描述 | 严重度 | 证据 | 启示 |
|---|---------|--------|------|------|
| C1 | **无自定义 User-Agent**：API 客户端只发 `Accept: application/json`，下载连接池只设 verify/cookies/limits，`python-httpx/0.27.x` 默认 UA 直接暴露给 Pawchive 反爬 | 高 | `ktoolbox/api/client.py:156`、`ktoolbox/job/stream.py:137-140` | 我们 Node 版必须自定义 UA（模拟浏览器或明确标识） |
| C2 | **断点续传只认 206**：若服务器忽略 Range 返回 200（常见于部分 CDN/反代），直接 `GeneralFailure` 失败，**无全量下载 fallback** | 高 | `ktoolbox/downloader/downloader.py:274-280`（`!= PARTIAL_CONTENT` 即失败） | 借鉴"temp 文件 + Range 续传"思路，但 Node 版要加"206 失败→全量重下"fallback |
| C3 | **`chunk_size` 默认 1024 字节（1KB）**，`aiter_bytes(1024)` 每块 1KB 写盘，大文件（几百 MB）IO 粒度过小 | 中 | `ktoolbox/configuration.py:100-101`（buffer 20480 / chunk 1024）、`downloader.py:312` | Node 版用 64KB-1MB 块 |
| C4 | **`min_file_size`/`max_file_size` 默认均为 `None`（大小过滤默认关闭）**，即"跳过小文件"能力默认不存在；且大小校验只发生在下载开始前，无下载后完整性校验（无 Content-Length 比对、无 hash 校验，虽然 API 有 `search_file_by_hash` 但下载器不用它） | 中 | `ktoolbox/configuration.py:293-294`、`downloader.py:153-167`（`_size_filter_result`） | 我们 cli.js 已有自己的大小策略，可对照；**完整性校验是我们 Node 版的加分项** |
| C5 | **失败后 temp 文件不清理**：下载中断/失败后 `*.tmp` 残留磁盘，只能靠下次续传覆盖，无限重试（`retry_stop_never=True`）配合 429 时可能长时间占用磁盘 | 中 | `downloader.py:261-327`（temp 仅成功路径 rename，无 finally 清理） | Node 版：失败即删 temp + 记录断点信息 |
| C6 | **4xx 一律不重试**（`_retryable_result` 只认 429/5xx/传输异常），403 反爬拦截直接判失败 | 中 | `downloader.py:28-33` | Node 版可对 403 加"换 UA/等待重试"策略 |
| C7 | `tps_limit` 默认 5.0，实现为**类级全局锁**（`Downloader.wait_lock = Lock()`），每个下载发起前 `sleep(1/5)`——全局串行化连接建立，WebUI 多任务也共享此锁；但**只限连接建立速率，不限带宽/持续速率** | 低 | `downloader.py:53,258-259`、`configuration.py:106` | 启示：限速应可配且分任务，我们 Node 版按任务隔离 |
| C8 | `use_bucket`（硬链接去重桶）**跨文件系统必然 EXDEV 崩溃**：`aiofiles.os.link(temp, bucket)` 无 try/except（configuration validator 只在创建时验证 bucket 自身同卷可用，无法保证与下载目录同卷） | 中 | `downloader.py:323-325`、`configuration.py:112-136` | 去重用 hash 索引（我们已做）优于硬链接桶；若保留硬链接需同卷约束 |
| C9 | `reverse_proxy` 用 `str.format` 注入 URL，若 URL 或格式串含花括号会异常 | 低 | `downloader.py:269`（`config.downloader.reverse_proxy.format(self._url)`） | Node 版用占位符替换避免 format 语义 |

## 四、API/网络

| # | 不足描述 | 严重度 | 证据 | 启示 |
|---|---------|--------|------|------|
| D1 | 分页参数 `o`（offset）**强制 `multiple_of=50`**（`Offset` 类型），非法 offset 直接校验失败——与 Pawchive 实际 API 兼容性未实测 | 中 | `ktoolbox/api/parameters.py:9,21`；`fetch.py:39`（SEARCH_STEP=50，页短即停） | 我们 cli.js 的 `o` 传参已实测兼容，保持现状；注意"页满 50 条会多发一页空请求"的小开销 |
| D2 | API 重试固定 3 次/2s 间隔（`max_retries=3, retry_interval=2.0`），**与下载器 10 次/3s 的配置不一致**，且 API 层 timeout 5s 对慢网络偏紧 | 低 | `ktoolbox/api/client.py:87-88,150-173`、`configuration.py:61-62` | 可借鉴其 429/5xx 重试 + `follow_redirects=False`（防 API 被劫持到别处） |
| D3 | **响应漂移检测是好设计**（`model_extra` 收集未知字段告警 `ResponseDrift`），但仅 log warning，无自动容错 | 低 | `client.py:63-77,199-201` | 借鉴：我们的 Node 解析器可记录未知字段 |
| D4 | `parse_webpage_url` 按固定位置解析 URL 段（parts[1]=="user"、parts[3]=="post"），对非标准路径（如重定向短链、带 query 的 URL）直接返回 None 不报错——用户输错 URL 时静默失败 | 低 | `ktoolbox/utils.py:111-131` | 我们 cli.js 已实测解析，补足错误提示即可 |

## 五、WebUI 前端

| # | 不足描述 | 严重度 | 证据 | 启示 |
|---|---------|--------|------|------|
| E1 | **前端与后端强耦合**：`fetch('/api/v1...')` 硬编码前缀 + `credentials: same-origin` cookie 会话 + `X-CSRF-Token` 头 + `/assets` 绝对路径（rolldown modulepreload）——**静态文件离开 KToolBox 后端即不可用**，无法单独 host | 高 | `webui/src/lib/api.ts:17-40`、`ktoolbox/webui/static/index.html`（全部 `/assets/...` 绝对路径） | **复用前端 = 必须复刻同源 API 契约**（cookie 会话 + CSRF + /api/v1 前缀），这是我们 Node 后端的硬约束 |
| E2 | openapi 契约 67 路径/84 操作，其中大量是命名转换/自动同步/媒体代理/文件系统浏览端点；`openapi.yaml` 与后端 `openapi_contract.py` 双维护（有 CI `check:api` 校验） | 中 | `webui/openapi.yaml`(67 paths/84 ops)、`ktoolbox/webui/openapi_contract.py:544`（build_openapi_schema） | 转写时**只需实现子集端点**，前端会 404 的功能页面（命名转换等）需一并裁剪 |
| E3 | 打包产物 2.7MB，单 JS 入口 `index-BjhIkylN.js` 730KB + `index-D6V4ZkiP.css` 464KB（React 19 + HeroUI + react-query + i18next + codemirror），**首屏加载重** | 中 | `ktoolbox/webui/static/assets/`（730KB js、464KB css、9 个 runtime chunk） | 我们 Node 版若复用，接受体积；若要改造需动 rolldown 拆包 |
| E4 | 前端 i18n 是**双通道**：`webui/src/locales/*.ts`（UI 文案）+ 服务端 `config_locale_catalogs.py`（配置项本地化，7 语言硬编码 652 行），改配置文案要同时改两处 | 低 | `ktoolbox/webui/config_locale_catalogs.py:1`（"do not edit directly"生成文件） | 砍掉服务端目录，配置项文案放前端一处 |
| E5 | e2e 用 Playwright 8 个 spec + 页面截图 showcase，但**依赖 `webui_showcase_data.py` 造数据**，验证深度依赖后端行为 | 低 | `webui/e2e/*.spec.ts`(8 个)、`tests/webui_showcase_data.py` | 我们前端自检用真实后端（frontend-real-render-preview 思路） |

## 六、性能/资源

| # | 不足描述 | 严重度 | 证据 | 启示 |
|---|---------|--------|------|------|
| F1 | 任务/事件/进度全部存 **SQLite + JSON 列**（`progress_json`/`spec_json`/`scopes_json`），高频进度更新频繁写库（有 `UPDATE tasks SET progress_json`），大任务时 IO 压力 | 中 | `ktoolbox/webui/database.py`(19 张表)、`task_store.py:80,205` | 我们 Node 版进度可用内存 + 定期落盘 |
| F2 | 媒体代理内存缓存上限 64MB（LRU）+ PIL 同步缩略图（`asyncio.to_thread(process_media)`），并发缩略图请求会排队 | 低 | `ktoolbox/webui/media.py:69,163` | 借鉴 LRU + 大小/像素双重上限；我们 Node 版可用磁盘缓存 |
| F3 | 命名转换全量扫描：遍历下载根下**所有 post.json 逐个 Pydantic 解析**（`_outermost_metadata_paths`），几万帖规模下预览生成耗时长且占内存 | 中 | `naming_service.py:1504-1530` | 砍掉该功能即可规避 |
| F4 | 并发模型优秀：per-creator 公平队列（`FairJobQueue` 轮询 lane）+ 共享连接池（`max_connections=concurrency`）+ producer/consumer 分离 + 取消时干净关闭 | — | `ktoolbox/job/stream.py:37-94,117-150`、`ktoolbox/sync.py:118-238` | **借鉴**：我们 cli.js 的并发可对照此模型，尤其"按创作者公平轮询"避免单创作者占满 |
| F5 | NFS/大目录：下载写盘用 `aiofiles`（线程池 IO），无专门 NFS 调优；`keep_metadata` 用 `os.utime` 改 mtime（默认 True，每文件一次额外系统调用） | 低 | `downloader.py:330-336` | 我们 Node 版 NFS 上避免频繁 stat/utime |

## 七、代码质量

| # | 不足描述 | 严重度 | 证据 | 启示 |
|---|---------|--------|------|------|
| G1 | 测试充分（45 个文件/351 个测试函数，覆盖 API/下载器/CLI/WebUI/命名/自动同步），配置 `--disable-socket` 离线测试 + 覆盖率门槛 85%——**这是 KToolBox 最值得学习的部分** | — | `tests/`(45 文件)、`pyproject.toml:111-124` | 借鉴：测试用 respx mock HTTP 而非真网 |
| G2 | `ktoolbox/api/generated/models.py` 仅 209 行（datamodel-code-generator 生成，CI 校验），比手写模型更可信 | — | `pyproject.toml:89,119`（生成 + omit 覆盖率） | 我们 Node 版无类型生成，注意手工模型与 API 漂移 |
| G3 | 大文件单体问题（见 A1），`editor.py` 578 行在 mypy 中直接 `ignore_errors`（`pyproject.toml:148-150`）——**已知的质量豁免点** | 低 | `pyproject.toml:148-150` | 转写时 editor 直接不转 |
| G4 | 文档多语言（7 语言）与代码同步良好（抽查 `docs/zh/api.md` 与 `client.py` 方法一致），但**文档体量巨大**（mkdocs.yml 18KB） | 低 | `docs/zh/api.md`、`docs/zh/index.md` | 我们只需中文 README + 少量 docs |

## 八、依赖与可移植性

| # | 不足描述 | 严重度 | 证据 | 启示 |
|---|---------|--------|------|------|
| H1 | 基础依赖 15 个 + WebUI extra 11 个（fastapi/uvicorn/fastmcp/aiosqlite/argon2/cryptography/pillow/docutils…），poetry.lock 159 个包——**依赖树庞大**，且 fastmcp/cryptography/argon2 都是重量级 | 高 | `pyproject.toml:9-25,51-63`、`poetry.lock`(159 [package]) | 我们 Node 版零依赖（已有 cli.js 基础），WebUI 用原生实现，不引入等价物 |
| H2 | Python 3.10-3.14 兼容 + uvloop/winloop 双环 + Windows x86 用标准 asyncio loop（winloop 无 32 位 wheel）+ pyinstaller 6 平台打包——**跨平台成本极高**（CHANGELOG 大量篇幅在修平台兼容） | 中 | `pyproject.toml:8,45-50`、`CHANGELOG.md`(v1.1.0-beta.1 平台修复条目) | 不模仿；Node 跨平台天然更好 |
| H3 | 依赖版本全部锁 `<大版本` 上限（如 `httpx<0.29`、`pydantic<3`），配合 CI 质量矩阵（ruff/mypy/pytest/coverage）保证稳定 | — | `pyproject.toml` | 借鉴思想：我们 Node 无依赖则无此问题 |

## 九、安全

| # | 不足描述 | 严重度 | 证据 | 启示 |
|---|---------|--------|------|------|
| I1 | 默认 `host=0.0.0.0` 暴露局域网 + 明文 HTTP + README 明说"用可信网络或 HTTPS 反代"——**无 TLS 内置，默认部署不安全** | 中 | `configuration.py:366-367`、`README.md:70` | 我们 Node 后端默认 127.0.0.1 或反代，或内置简单 token |
| I2 | 整体鉴权设计优秀（Argon2 哈希、登录限流 5 次/5 分钟按 IP、CSRF header + Origin 校验、session idle 24h/absolute 168h、CSP 头、HttpOnly SameSite=strict cookie），**无明显高危漏洞**；唯一弱点是明文 `password` 配置项兼容（`_plaintext_password` 分支） | 低 | `ktoolbox/webui/auth.py:29-54,129-137,154-164`、`app.py:180-197` | 借鉴整套；明文密码分支可去掉 |
| I3 | 文件系统浏览器有路径穿越防护（resolve + scope 白名单 + symlink 删除禁止 + 保护目录），但 host scope 默认 `restrict_host_to_roots=False`（**可浏览整个文件系统**，README SECURITY.md 也承认"intentionally exposes filesystem names"） | 中 | `ktoolbox/webui/filesystem.py:62-63,313-322`、`SECURITY.md`(scope 声明) | 我们 Node 版文件选择器默认锁项目目录，host 浏览要显式开启 |
| I4 | MCP token 设计优秀：`ktmcp_` 前缀随机 token、SHA-256 digest 存储、scope（read/manage）、过期/吊销、MCP 内部走 ASGI 直连（`internal_token` + `http://ktoolbox.internal`）避免网络暴露 | — | `ktoolbox/webui/mcp_tokens.py:61-83`、`mcp_server.py:43-48` | 借鉴：MCP 若不转写，至少学 token digest 存储 |
| I5 | 媒体代理 SSRF 防护到位：URL 由固定 host + 规范化路径拼装（拒绝 `..`/query/反斜杠/空字节），大小 32MB/5000 万像素上限，PIL DecompressionBomb 转异常，格式白名单 | — | `ktoolbox/webui/media.py:31-35,189-198,201-218` | 借鉴：我们 Node 版图片代理要同样做路径白名单 |
| I6 | 下载路径写入安全：文件名经 `pathvalidate.is_valid_filename` + `sanitize_filename` + `server_path` 仅用于取 name/URL 构造，**本地写盘路径受控** | — | `ktoolbox/action/job.py:90-94,122-126`、`downloader/utils.py:43-72` | 我们 cli.js 已做，保持一致 |

## 十、其它坑

| # | 不足描述 | 严重度 | 证据 | 启示 |
|---|---------|--------|------|------|
| J1 | **WebUI 与 CLI 共用同一套核心但并发模型不同**：WebUI 任务由 `TaskScheduler`（max_active_tasks 默认 2）串行排队 + 资源冲突检测（输出目录/创作者/帖子重叠即拒绝并行），CLI 无此限制——两套调度语义 | 低 | `ktoolbox/webui/task_scheduler.py:24-37`（TaskResources.conflicts_with） | 我们 Node 后端用统一任务队列 |
| J2 | `include_revisions` 默认 False 但**一旦开启会对每帖额外请求 revisions API**（N 帖 = N 次额外请求），且 job 生成阶段对 `extract_content` 每帖无 content 时再发 `get_post`——**组合开启时请求量暴涨**（代码有 warning 提示，但默认文档推荐值低） | 中 | `ktoolbox/action/job.py:142-173,393-399` | 我们 Node 版默认关闭，明确警告 |
| J3 | `extract_content_images` 从 content 里抓图片 URL 的路径判断逻辑复杂（相对/绝对/跳过 data URL），存在图片顺序计数器错乱修复痕迹（`sequential_counter` 双重递增 217-235 行），属历史 bug 修补区 | 低 | `ktoolbox/action/job.py:192-244` | 转写时此功能简化或去掉 |
| J4 | **无现成安装/运行验证**：本机 Python 3.8.15 不满足 >=3.10，未实测运行、未实测 Pawchive API 连通性（审计中遵守 curl 克制要求，仅做静态分析） | — | 环境实测 | 后续如需转写，先 `pip install ".[webui]"` 在 3.10+ 环境实测再动 |

---

## TOP 10 最需要规避/注意的坑

1. **无 UA + 4xx 不重试**：下载器以 `python-httpx` 默认 UA 直连 file.pawchive.pw，403 直接失败——Pawchive 一旦上反爬，KToolBox 首当其冲（C1/C6）
2. **断点续传无 200 fallback**：服务器不支持 Range 即整个文件下载失败（C2）
3. **依赖体量爆炸**：159 个包、fastmcp/pillow/cryptography 等重型依赖，pipx 安装 webui 版体积大（H1）
4. **前端强耦合同源后端**：复用 WebUI 静态产物必须复刻 cookie+CSRF+/api/v1 契约，否则白屏（E1）
5. **beta 未验证**：命名转换/自动同步/MCP 均为 v1 新增，README 自述"未充分实际验证"（B1）
6. **temp 文件失败残留** + `retry_stop_never` 无限重试组合，磁盘被 `.tmp` 占满风险（C5）
7. **bucket 硬链接跨卷 EXDEV 崩溃**（C8）
8. **默认 0.0.0.0 + 明文 HTTP + 随机密码弹浏览器**，无桌面/局域网环境部署体验差且有暴露风险（I1/B4）
9. **每次 CLI 调用都访问 GitHub/PyPI 查更新**，离线环境拖慢启动（B2）
10. **命名转换全量扫描性能**：几万帖规模下 WebUI 预览卡顿（F3）；加上 67 端点中大量是它的 API，转写必须整体裁剪（E2）

## 值得借鉴的 10 点

1. **离线测试体系**：351 个测试函数 + respx mock + `--disable-socket`，CI 矩阵质量门禁（G1）——我们 Node 版补 mock 测试的模板
2. **公平下载队列**：per-creator lane 轮询（FairJobQueue）防单创作者占满并发（F4）
3. **断点续传 + 临时文件原子重命名**：temp 文件 + Range + `rename` 原子提交（C2 思路，补 200 fallback 即可）
4. **schema 版本化 + 自动升级**：ktoolbox.toml schema 1→5 迁移链（A2）
5. **安全基线全套**：Argon2 + 登录限流 + CSRF + SameSite cookie + CSP 头（I2）
6. **路径穿越/SSRF 双防护**：文件系统 scope 白名单 + resolve 校验 + symlink 保护；媒体代理路径规范化 + 像素/大小上限（I3/I5）
7. **API 漂移检测**：响应未知字段收集告警（D3）
8. **上下文隔离配置**：ContextVar + configuration_scope 让多任务各自配置（A3，Node 版可用 AsyncLocalStorage 对应）
9. **失败分类模型**：`failures.py` 的 FailureStage/FailureCode/classify_failure 结构化失败上报（WebUI/CLI/MCP 统一消费）——值得看 `ktoolbox/failures.py`（280 行）
10. **MCP token digest 存储 + scope 分离**：明文 token 只出现一次，库中只存 hash（I4）

---

**收尾说明**：本报告为静态审计，KToolBox 未在本机运行（Python 版本不满足），Pawchive API 连通性未实测；标注"未验证"处需在真实环境复测。代码引用路径均相对 `.probe-ktoolbox/` 仓库根。
