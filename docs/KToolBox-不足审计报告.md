# KToolBox v1.1.0-beta.1 全量不足审计报告

- 审计对象：`docs/.probe-ktoolbox/`（Ljzd-PRO/KToolBox master 完整 clone，本地提交 `eb9403e`，2026-09-27）
- 审计方式：只读代码审查（read/grep 源码与文档），未修改任何文件
- 审计日期：2026-09-28
- 用途：为「Node 后端 + 复用 KToolBox WebUI 前端」转写方案提供借鉴/规避依据

## 0. 规模盘点（实测）

| 指标 | 数值 | 证据 |
|---|---|---|
| Python 源码+测试 | 132 文件 / 32437 行 | `find ktoolbox tests -name '*.py' \| wc`（任务描述称 2.06 万行，含测试 3.24 万行） |
| 前端源码（webui/src） | 94 文件 / 34467 行 TS/TSX/CSS | 同上 |
| 前端打包产物 | `ktoolbox/webui/static/assets` 共 2.7MB | 主 JS 730KB、主 CSS 464KB、date-runtime 404KB、locales 391KB、heroui 308KB、react-runtime 221KB（`du` 实测） |
| 最大单文件 | `ktoolbox/webui/naming_service.py` 2342 行；`tests/ktoolbox/test_webui_naming.py` 1411 行 | `wc -l` |
| 测试数量 | 351 个 `def test_`（grep 实测 351 matches） | `tests/**` |
| 覆盖率门槛 | `fail_under = 85`，`ktoolbox/api/generated/*` 排除 | `pyproject.toml:116-124` |
| WebUI API 契约 | 107 个 `OPERATIONS` 元数据 + 7 语言配置目录 652 行 | `ktoolbox/webui/openapi_contract.py`、`config_locale_catalogs.py` |
| 依赖 | 核心 16 个（pydantic/pydantic-settings/tenacity/httpx[socks]/cyclopts/loguru/aiofiles/pathvalidate/settings-doc/rich/tomlkit/croniter/tzdata/tzlocal/python-dotenv），webui extras 再 +12（fastapi/uvicorn/aiosqlite/argon2-cffi/cryptography/fastmcp/pillow/docutils…） | `pyproject.toml:9-63` |

---

## 1. 架构 / 设计

| # | 不足描述 | 严重度 | 证据 | 启示 |
|---|---|---|---|---|
| 1.1 | 单一「config 单例 + ContextVar 切换」双轨制：全局 `config` 是 `_ActiveConfigurationProxy`（每访问读 ContextVar），并发任务需 `configuration_scope` 切换，语义隐蔽、易踩坑；新模块容易忘在 scope 里读错配置 | 高 | `ktoolbox/configuration.py:446-461`（`config = cast(Configuration, _ActiveConfigurationProxy())`）、`:424-443` | **借鉴**其"任务级配置快照"（`RuntimeContext.snapshot()` 深拷贝）；**规避**全局可变单例，Node 侧用显式 ctx 参数/AsyncLocalStorage |
| 1.2 | 配置系统三层分裂：`ktoolbox.toml`（项目：作者名册/命名/自动同步/blocker）+ `.env`/`prod.env`（引擎：api/downloader/job/logger/webui）+ 进程环境变量。README 宣称"创建 ktoolbox.toml 即可"（`README.md:42`），但引擎参数（并发/重试/UA 等）实际只能走 env/dotenv，WebUI"项目设置"页对引擎层是只读 schema 展示+env 文件编辑，体验割裂 | 高 | `ktoolbox/configuration.py:417-421`（`load_configuration` 只读 .env/prod.env）；`ktoolbox/project_config.py`（toml 只含 creators/naming/automatic_sync/blockers）；`README.md:42` | **规避**双源配置；转写时统一为单一 JSON/TOML 项目配置，env 仅做覆盖 |
| 1.3 | 中文本地化靠**平行模型副本** `_configuration_zh.py` + docutils 解析 docstring `:ivar` 文本（`config_schema.py:317-339`）：改字段要同步改 7 语言目录（`config_locale_catalogs.py` 652 行硬编码翻译表）+ 英文 docstring + 中文 docstring，一致性全靠 `missing_config_metadata` 测试兜底 | 中 | `ktoolbox/_configuration_zh.py`（37+ 行 ivar 表）、`ktoolbox/webui/config_schema.py:36-45`（`_MODEL_TRANSLATIONS`）、`config_locale_catalogs.py` | **借鉴**"配置 schema 自动生成 + 缺失元数据 CI 校验"思路；**规避**手工平行翻译表（转写用 i18next 标准 JSON 目录） |
| 1.4 | 扩展性弱：API 层 `PawchiveClient` 硬编码 14 个公开端点路径（`api/client.py`），后端被锁死 Pawchive（Kemono 已弃）；service（fanbox/patreon）只是路径参数，不能注册新数据源；`api/generated/models.py` 由 `k_generator/`（datamodel-code-generator）生成，schema 漂移只能靠 `ResponseDrift` 日志告警（`client.py:53-77`）人工跟进 | 中 | `ktoolbox/api/client.py:230-306`（14 个方法硬编码 path）、`pyproject.toml:89`（datamodel-code-generator） | 若只要 Pawchive 单源可接受；多源需自行抽象 Provider 接口 |
| 1.5 | 模块划分粗糙：`webui/` 下 36 个平铺文件（store/scheduler/routes 混杂），`naming_service.py` 2342 行（扫描+预览+迁移+转换+回滚+布局版本全塞一起） | 中 | `ls ktoolbox/webui/`、`wc -l` | 转写时按域拆分（tasks / naming / config / mcp / fs / media 各一目录） |
| 1.6 | 双 CLI 入口：`cli.py`（cyclopts，命令逻辑）+ `cli_app.py`（rich 表格/格式化/`__main__.py` 挂入），同一命令在两处都有胶水；`editor.py`（urwid TUI）整个模块 mypy `ignore_errors` | 低 | `pyproject.toml:148-150`、`ktoolbox/cli.py:341 行`+`cli_app.py:592 行` | 转写不需要 urwid TUI，直接砍掉 |

## 2. 功能缺陷：README/文档声称 vs 实现

| # | 不足描述 | 严重度 | 证据 | 启示 |
|---|---|---|---|---|
| 2.1 | **半成品自认**：README 首屏 WARNING "v1 … not yet received enough real-world validation. Some features may still fail"；版本 `v1.1.0-beta.1`、`Development Status :: 4 - Beta`；CHANGELOG 把 1.1.0 定义为"先发 beta 验证迁移修复" | 高 | `README.md:16-19`、`pyproject.toml:31`、`CHANGELOG.md:3-5` | 直接复用其前端等于继承未验证 API 面；转写前必须对照 OpenAPI 逐项实测 |
| 2.2 | **自动同步是"不补跑"语义**：进程停机期间到期的 run 直接丢弃，启动后只算下一个触发点；同计划已有活动任务时，到点触发静默 `mark_skipped`（reason="an earlier run for this plan is still active"），用户若不打开自动同步页根本不知道错过了一轮 | 中 | `ktoolbox/webui/auto_sync_scheduler.py:151-158`（`_trigger_due_plans` 里 `store.mark_skipped`）、`docs/en/automatic-sync.md:35`（"Runs missed … are not replayed"）、`tests/ktoolbox/test_auto_sync_scheduler.py:162`（`test_scheduler_skips_missed_occurrences_without_catch_up`） | **借鉴**checkpoint 去重（24h 重叠窗 `CHECKPOINT_OVERLAP`）+ 每 creator 独立 checkpoint 设计；**规避**静默 skip，转写时 skip 必须进任务事件流可查 |
| 2.3 | **命名迁移/转换能力集中在 2342 行单文件**，且与 `ktoolbox.toml` 命名布局版本（`naming_layout_versions` 表）强耦合；v0→v1 老项目必须人工走"Legacy migration"确认字段，未确认前新布局不激活（启动时只打 stderr 警告） | 中 | `ktoolbox/webui/naming_service.py`、`ktoolbox/webui/server.py:234-250`（`detect_legacy_naming` 只 print 警告）、`ktoolbox/webui/database.py:174-180`（`naming_layout_versions` 表） | 转写不需要 v0 兼容，可整体砍掉命名迁移子系统，命名转换保留"预览→执行→可暂停回滚"核心（这部分质量很高，值得借鉴） |
| 2.4 | **blockers（屏蔽规则）是"隐式转换"遗留**：`job.keywords_exclude` 标记为 Deprecated，自动转成"隐式全局字段匹配 blocker"，新项目应直接写 `ktoolbox.toml` 结构化 blocker——旧配置者升级后行为可能与预期不符 | 中 | `ktoolbox/configuration.py:232-233`（docstring 明示 deprecated）、`tests/ktoolbox/test_action_job.py:310`（`test_create_creator_jobs_blocks_before_generation`） | 转写直接设计结构化屏蔽（按平台/关键词/文件类型），不要做隐式迁移 |
| 2.5 | **MCP 内嵌在 WebUI 进程**：`/mcp` Streamable HTTP 与 REST 同端口同进程，MCP 鉴权走独立 `ktmcp_` token（sha256 哈希存 SQLite），但写类工具（建任务/删 creator/改命名）直接操作本地项目，MCP 客户端=拥有项目全权；README 宣称支持 Codex/Claude/Cursor/VS Code，属"能跑"而非"安全" | 中 | `ktoolbox/webui/mcp_server.py:37-71`、`ktoolbox/webui/mcp_tokens.py`、`docs/en/mcp.md:44-47`（自述边界） | 转写不做内嵌 MCP，如需 Agent 接口单独出无头 HTTP/MCP 服务并独立鉴权 |
| 2.6 | **WebUI 单进程锁**：`ProjectProcessLock` 使同一项目只能开一个 WebUI 进程，多副本/多终端不可行 | 低 | `ktoolbox/webui/app.py`（`project_lock`）、`tests/ktoolbox/test_webui_tasks.py:861`（`test_project_lock_rejects_a_second_scheduler`） | 单机工具可接受；转写如需常驻服务化要评估 SQLite+WAL 多写者 |

## 3. 下载引擎

| # | 不足描述 | 严重度 | 证据 | 启示 |
|---|---|---|---|---|
| 3.1 | **无任何自定义 User-Agent 配置项**：`DownloaderConfiguration`/`APIConfiguration` 无 `user_agent` 字段（全仓 grep `user_agent/User-Agent` 无命中），API 客户端与下载流共用 httpx 默认 UA（`python-httpx`），反爬只能靠 `session_key` cookie + `tps_limit` 硬扛 | 高 | `ktoolbox/configuration.py:43-111`（两个 model 字段全列，无 UA）、`ktoolbox/api/client.py:111`（`httpx.AsyncClient(verify=verify)` 无 headers）、`ktoolbox/downloader/downloader.py:267-272`（stream 请求只有 Range 头） | **转写必加**：可配置 UA（浏览器伪装）+ 每 worker 独立 UA 池；Pawchive 文件 CDN 大概率按 UA 风控 |
| 3.2 | **tps_limit 默认 5/s 是"每 worker 串行锁"实现**：所有 worker 共享一把 `wait_lock`，每次请求前 `sleep(1/5)`——等价于全局限速 5 req/s，N 个并发下载器被同一把锁排队，`job.count`（默认 4、上限 64）调越大浪费越大（锁等待占比上升） | 高 | `ktoolbox/downloader/downloader.py:53`（`wait_lock = Lock()` 类属性）、`:258-259`（`async with self.wait_lock: await asyncio.sleep(1 / config.downloader.tps_limit)`）、`configuration.py:106`（默认 5.0） | 语义坑："每秒连接数"≠令牌桶。转写用全局令牌桶（asyncio.Semaphore 按速率填充），与并发数解耦 |
| 3.3 | **min_file_size 默认 None=不过滤**（不是默认值过大导致漏下载，而是没开就全下），max_file_size 同样 None；只有手动设了才跳过 | 低 | `ktoolbox/configuration.py:293-294`、`downloader.py:153-167`（`_size_filter_result`） | 转写给实用默认（如 min=0、max=512MB），并在 WebUI 明示 |
| 3.4 | **断点续传只认 206，无全量 fallback**：`Range: bytes={temp_size}-` 发出后若服务端返回非 206（含 200 全量），直接 `GeneralFailure` 返回、**已追加的 temp 字节不重传也不清零**（保留 temp 文件留待下次）；若服务端忽略了 Range 但返回 200，整个文件下载失败 | 中 | `ktoolbox/downloader/downloader.py:267-280`（`if res.status_code != httpx.codes.PARTIAL_CONTENT: return DownloaderRet(GeneralFailure)`）、`:271-272`（无 Range 场景也总带 `bytes=0-` 头，首传也发 Range） | 转写：非 206 时应 fallback 到全量下载（temp 清零重写），而非直接失败 |
| 3.5 | **temp 失败残留无清理**：下载失败/取消后 `.tmp` 文件留在目标目录；只有成功路径 rename/bucket-link。任务恢复（`recover_interrupted`）只改数据库状态，不清 temp | 中 | `ktoolbox/downloader/downloader.py:261-327`（成功才 rename）、`ktoolbox/webui/task_store.py:73-115`（recover 只 UPDATE 状态） | 转写加 temp GC（按 mtime 超龄清理 + 任务删除时一并清） |
| 3.6 | **完整性零校验**：无 sha256/etag 比对，落盘靠 `Content-Length/Content-Range` 推断 total_size；`Content-Length` 缺失或非法就 total=None 直接写（size 过滤也自动失效）；已有文件的"去重"只比 `is_file()` 存在性，不比大小/hash——**同名旧文件内容已坏/被截断也不会重下** | 中 | `ktoolbox/downloader/downloader.py:296-306`、`ktoolbox/downloader/utils.py:75-96`（`duplicate_file_check` 仅 `is_file()`） | 转写：落盘前按 Content-Length 断言已写字节数（可测）；去重升级为 size+（可选）hash 索引，坏文件自动重下 |
| 3.7 | **失败重试策略**：429/5xx/无状态码（异常）才重试，`retry_times=10`、`retry_stop_never` 可无限；4xx（403/404/410）不重试直接返回（设计如此，FAQ 明示）；重试等待 `wait_fixed(3s)` 无退避、无 jitter，429 时 10 次 ×3s 可能撞死速率限制 | 中 | `ktoolbox/downloader/downloader.py:28-33`（`_retryable_result`）、`:185-195`（tenacity 配置）、`configuration.py:103-105`、`docs/en/faq.md:18`（"ordinary 4xx … are not retried"） | **借鉴**"按结果分类可重试"（429/5xx/None=retry，FileExisted=不 retry）思路；**规避**固定间隔，转写用指数退避+抖动 |
| 3.8 | **bucket 模式硬链接**：`use_bucket` 下 `os.link(temp, bucket_path)` 同卷去重，跨设备/NFS 子卷直接 EXDEV；配置校验阶段就用 `os.link` 探针，失败会**静默把 use_bucket 置 False**（只打 exception 日志） | 中 | `ktoolbox/downloader/utils.py:84-91`（`os.link(bucket_file_path, local_file_path)`）、`configuration.py:112-136`（`check_bucket_path` 探针，异常→`self.use_bucket=False` + `logger.exception`） | 转写默认用 copy/硬链接自动探测；EXDEV 场景降级为 copy 而不是禁用 |
| 3.9 | **403 只给"配 session_key"一条路**：文件 CDN 需要 session 时必须手动抓 cookie 填 `KTOOLBOX_DOWNLOADER__SESSION_KEY`（仅发给文件 host），cookie 过期=全量 403，无自动刷新 | 中 | `ktoolbox/configuration.py:97`（`session_key: str = ""`）、`docs/en/faq.md:20-28` | 转写支持 cookie 文件/刷新回调 |

## 4. API / 网络（httpx 用法、Pawchive 兼容、错误处理）

| # | 不足描述 | 严重度 | 证据 | 启示 |
|---|---|---|---|---|
| 4.1 | **分页只有 offset（`o` 参数，且 `multiple_of=50` 强制）**：`Offset = Annotated[int, Field(ge=0, multiple_of=50)]`，不满足 50 整数倍的 offset 在构造参数时就 ValidationError；offset 分页天然存在"翻页期间创作者发新帖→漏/重"的窗口漂移，靠自动同步 checkpoint（按时间窗+24h 重叠）补救，不靠 API 语义 | 中 | `ktoolbox/api/parameters.py:9`（`multiple_of=50`）、`ktoolbox/api/client.py:258-270`（`list_creator_posts` 传 `q/o`）、`ktoolbox/action/job.py:403-416`（`skip = offset % 50` 手动消化非整页偏移） | 转写保留 offset 分页（Pawchive 契约）但别硬约束 multiple_of=50（放宽校验、服务端行为为准）；去重必须落本地索引而非信 offset 稳定 |
| 4.2 | **API 客户端 5s 硬默认超时、`follow_redirects` 关闭**：`timeout=5.0` 对慢网络（NFS 上的远程调用/跨境）偏紧；redirect 不跟随（测试 `test_redirect_is_not_followed`）意味着 3xx 直接成 `PawchiveHTTPError` | 中 | `ktoolbox/api/client.py:87`（`timeout: float = 5.0`）、`tests/ktoolbox/test_api_client.py:203`（redirect 不跟随） | 转写：timeout 按请求类型分档（list 可 15s、file stream 30s+），redirect 策略对 API 保持不跟随（防重定向到钓鱼）但可配 |
| 4.3 | **4xx 不重试**（除 429）：403/401/404/410 一次性失败；对偶发 403（CDN 抖动）没有二次确认 | 低 | `ktoolbox/api/client.py`（`_retryable` 逻辑：transport/429/5xx）、`docs/en/faq.md:18` | 转写对 429 加 `Retry-After` 解析（当前只固定 `retry_interval=2s`） |
| 4.4 | **下载器 httpx client 无连接池上限/无 keepalive 调参**：`DownloadWorkerPool` 构造 `httpx.AsyncClient` 时（`job/stream.py:137`）未见 `Limits`（对比 media proxy 明确设了 `max_connections=8`），`job.count=64` 时连接数无界；每任务新建 client 池，长任务频繁建连 | 中 | `ktoolbox/job/stream.py:137`（`async with httpx.AsyncClient(...)`，grep 该文件无 `Limits`）、`ktoolbox/webui/media.py:80-84`（media proxy 有 `httpx.Limits`，对比出下载器没有） | **借鉴** media proxy 的 `Limits` 用法；转写全链路统一连接池上限 |
| 4.5 | **Pawchive 兼容性靠"响应漂移日志"被动发现**：`ResponseDrift` 只把未知字段 warning 进日志，无告警通道；`published` 无时区值按 service 时区解释是 beta.1 才修的一长串坑（CHANGELOG 1.1.0 Added 全节） | 中 | `ktoolbox/api/client.py:53-77`、`CHANGELOG.md:9-16`、`tests/ktoolbox/test_api_client.py:291`（`test_observed_post_metadata_variants`） | **借鉴**"生成模型 + drift 观测"防 schema 变化；转写加字段级可配置（宽容 unknown 字段） |
| 4.6 | **代理只走 httpx 标准 env（HTTP_PROXY/ALL_PROXY/socks）**，无配置项、无 WebUI 入口；`httpx[socks]` 依赖常装 | 低 | `docs/en/faq.md:73-87`、`pyproject.toml:14` | 转写加配置字段（env 仍可覆盖） |

## 5. WebUI 前端（打包产物 / API 契约 / 功能面）

| # | 不足描述 | 严重度 | 证据 | 启示 |
|---|---|---|---|---|
| 5.1 | **打包产物 2.7MB 且与后端 `/api/v1` 强耦合**：`static/assets` 8 个 chunk（主 JS 730KB+CJS/CSS 464KB），`vite.config.ts` 用 `rolldownOptions.codeSplitting` 手工分组（date-runtime/heroui/data-runtime/schedule-runtime/icon-runtime/locales）仍压不下来；前端 `lib/api.ts` 硬编码 `fetch('/api/v1'+path)` + `credentials:'same-origin'` + `X-CSRF-Token` 双提交，**复用前端到别的 Node 后端 = 必须实现同一 OpenAPI 面（107 operations）+ 同 cookie 名 `ktoolbox_session` + CSRF 流程 + `/assets` 绝对路径部署假设** | 高 | `ktoolbox/webui/static/assets/*`（du 实测）、`webui/src/lib/api.ts:21-53`、`ktoolbox/webui/auth.py:19-20`（`SESSION_COOKIE="ktoolbox_session"`、`CSRF_HEADER="X-CSRF-Token"`）、`ktoolbox/webui/app.py:290-295`（SPA fallback 只认 `/api/` 前缀 + `/assets`） | 转写建议：① 前端当"参考实现"提取组件/交互，用自己的 React 壳（砍掉 HeroUI 换成轻量组件库可省 ~300KB）；② 若硬要复用原 bundle，Node 后端必须 1:1 复刻 OpenAPI（契约已固化在 `webui/openapi.yaml`，有 `test_committed_webui_openapi_is_valid_and_current` 守护，可当验收基准） |
| 5.2 | **前端 67 端点/84 写操作全带 CSRF token 透传**（写操作逐一点 `session.csrf_token`），批量操作是前端 for 循环逐个 POST（`TasksPage.tsx:203-230` 批量 pause/resume 是串行 await，n 个任务 n 次往返） | 中 | `webui/src/pages/TasksPage.tsx:168-272`（`taskAction`/`batchTaskAction`/`deleteTasks` 全串行循环） | 转写加批量端点（`POST /tasks/actions` 一次多任务） |
| 5.3 | **实时通道=长轮询而非 SSE/WebSocket**：`lib/realtime.tsx` 用事件游标轮询（`lastSignalAt`/`revisions`），`eventTypes` 37 种事件硬编码在前端常量数组；`task_reporter.py` 后端每 0.2s flush 一次写 SQLite `task_events`——高并发下载（每文件 started/progress/retrying/finished 4 事件 ×64 并发）下 SQLite 写放大明显 | 中 | `webui/src/lib/realtime.tsx:56-94`（`eventTypes` 常量）、`ktoolbox/webui/task_reporter.py:34-56`（`flush_interval=0.2` + `_writer_loop` 逐条 INSERT） | 转写用 SSE（单向下发更简单）；事件按"任务级聚合快照"而非逐文件逐事件入库（当前 `task_events` 无上限，只有查询 limit=200） |
| 5.4 | **媒体代理**：`MediaProxyService` 64MB LRU 内存缓存 + PIL 缩略（thumbnail≤480 / preview≤1280 / 原图≤32MB，GIF/JPEG/PNG/WEBP），`MAX_MEDIA_PIXELS=50M` 防 decompression bomb；但代理走 `follow_redirects=False`，**NSFW 预览依赖登录态+代理**，未登录看不到；缓存按 URL 做 key，同一文件不同 variant 各自占一份 | 中 | `ktoolbox/webui/media.py:27-92`（常量与 LRU）、`:80-84`（httpx.Limits） | **借鉴**：像素上限+白名单格式+三档 variant 思路完整；转写可直接照搬参数 |
| 5.5 | **命名转换/自动同步页与 React Query 深耦合**：`naming_service.py` 前端交互（预览指纹 `fingerprint` 失效→`NamingPreviewStaleError` 要求重开预览）实现是好的，但 107 个 API 操作中命名域占 ~20 个，复用前端=必须全实现 | 中 | `ktoolbox/webui/openapi_contract.py`（OPERATIONS 命名域条目）、`ktoolbox/webui/naming_service.py:1222-1228`（stale 校验） | 转写若砍命名迁移，对应 API 可返回 410 让前端降级 |
| 5.6 | **七语言 UI**（en/zh-CN/zh-Hant/ja/ko/fr/ru）+ 7 语言文档（mkdocs-static-i18n）+ 7 语言 README，本地化一致性靠 6 个文档测试文件强制 | 低 | `docs/en|fr|…`、`tests/ktoolbox/test_docs_i18n.py`（grep 8 个 def test） | **借鉴**其"文档链接/本地化结构 CI 校验"；转写不必 7 语言，i18n 目录结构可复用 |

## 6. 性能 / 资源

| # | 不足描述 | 严重度 | 证据 | 启示 |
|---|---|---|---|---|
| 6.1 | **每任务全量快照重读项目配置**：`TaskScheduler._launch` 每次启动任务 `anyio.to_thread(_load_snapshot)` = 重解析 `.env`+`ktoolbox.toml`+深拷贝 Configuration（`snapshot()` `model_copy(deep=True)`）；调度循环 `_dispatch_ready_tasks` 每 0.25s 轮询 `SELECT * FROM tasks`（全表）判断可派发 | 中 | `ktoolbox/webui/task_scheduler.py:211-213`（`_load_snapshot`）、`:175-209`（0.25s 轮询 + `list_tasks` 全表）、`ktoolbox/configuration.py:481-482`（deep snapshot） | 转写：调度器事件驱动（任务入队/终态时唤醒），配置变更监听（其 `config_monitor.py` 已有 sha256 变更检测可借鉴）而非 0.25s 空转轮询 |
| 6.2 | **NFS 大目录敏感**：`naming_service._filesystem_fingerprint` 全树 stat/hash 计算预览指纹；`creator_profiles` 缓存作者名但作品列表全量进内存（`FetchInterruptError` 中断前 `posts: dict[str, Post]` 累积）；`task_events` 无保留策略，长任务事件表无限增长（查询才 limit） | 中 | `ktoolbox/webui/naming_service.py`（`_filesystem_fingerprint`，约 2180 行附近）、`ktoolbox/action/job.py:577-595`（`_write_creator_indices` 全量写 creator_indices.json 再原子替换）、`ktoolbox/webui/task_store.py`（events 表 schema 无 prune） | 转写：指纹增量（只扫变更子树）、索引文件改按 creator 分片 + 流式 JSONL、事件表加保留策略（按任务终态+N 天清理） |
| 6.3 | **并发模型**：`FairJobQueue`（每 creator 一条 lane、轮询取）+ `DownloadWorkerPool`（N 个 worker，`job.count` 默认 4 上限 64）+ WebUI 顶层 `max_active_tasks` 默认 2 上限 16 ——三层嵌套并发，每任务新建 client 池（4.4）+ 全局 tps_lock（3.2），实际吞吐受最短板（5 req/s）锁死；调 count 无效 | 高 | `ktoolbox/job/stream.py:37-95`（FairJobQueue）、`sync.py:96-100`（creator_concurrency=4）、`configuration.py:243-244,366-374`（count=4/creator=4/max_active=2） | 转写：单一全局速率令牌桶 + 并发池即可，不学三层嵌套 |
| 6.4 | **媒体缓存 64MB 默认固定**（`cache_bytes=64*1024*1024` 写死参数默认值，无配置项） | 低 | `ktoolbox/webui/media.py:69` | 转写做成可配置 |
| 6.5 | **uvloop/winloop 默认开启**（`use_uvloop: bool = True`）：缺失时仅 warning 降级标准 asyncio；Windows x86 无 winloop 32 位 wheel，发布包直接退回标准循环（CHANGELOG 自述） | 低 | `ktoolbox/utils.py:134-180`、`configuration.py:405`、`CHANGELOG.md:27-29` | Node 侧无此问题；保留"可选加速默认开、失败降级"模式可借鉴 |

## 7. 代码质量

| # | 不足描述 | 严重度 | 证据 | 启示 |
|---|---|---|---|---|
| 7.1 | **单文件膨胀**：`naming_service.py` 2342 行、`config_locale_catalogs.py` 652 行、`openapi_contract.py` 657 行（107 个操作元数据全硬编码）；测试侧 `test_webui_naming.py` 1411 行 | 中 | `wc -l`（见 §0） | 拆分标准：单文件 ≤400 行；操作元数据应从路由装饰器自动生成而非手工维护 107 条 |
| 7.2 | **类型标注与静态检查严格**（亮点）：全量 `from __future__ import annotations` + pydantic 模型；mypy `strict=true`（api 层）、`-W error` 测试、ruff 含 ASYNC 规则；唯一 `ignore_errors` 是 urwid `editor.py` | 低（正向） | `pyproject.toml:138-150`、grep `__future__` 全模块命中 | **借鉴**：生成的 API 模型与手写层分目录、生成物排除静态检查（`exclude = ktoolbox/api/generated`）的做法 |
| 7.3 | **测试 351 个 / 覆盖率门槛 85%**（生成模型目录整体 excluded，实际门槛打折）；`pytest-socket` 强制离线（`--disable-socket`），默认测试不触网 | 低（正向，excluded 有水分） | `pyproject.toml:111-124`（addopts/coverage omit）、`tests/**` grep 351 | **借鉴**离线测试策略（respx mock + 禁 socket）；转写用 nock/undici mock 同等隔离 |
| 7.4 | **文档与实现一致性靠 8 个文档测试守护**（链接、本地化树、README 导航、webui-primary 引导位置），README 7 语言手动同步 | 低（正向） | `tests/ktoolbox/test_docs_i18n.py`、`tests/ktoolbox/test_webui_openapi.py:17`（`test_committed_webui_openapi_is_valid_and_current`） | **借鉴**"文档也是测试对象"；`webui/openapi.yaml` 提交入仓 + CI 比对是防前后端漂移的正确姿势，转写 Node 后端务必复刻 |
| 7.5 | **代码真相 vs 文档**：`README.md:42` "creates ktoolbox.toml when missing" 实际创建的是项目配置+默认下载目录，引擎参数仍走 .env（1.2 同源）；`docs/en/faq.md:32` 续传描述"validates the combined size"与代码实际"Content-Range 缺失就 total=None 不校验"（3.6）不符 | 中 | 对照 §1.2、§3.4/§3.6 证据行 | 转写时以代码为准；文档漂移要进 CI（它自己开了先例） |

## 8. 依赖与可移植性

| # | 不足描述 | 严重度 | 证据 | 启示 |
|---|---|---|---|---|
| 8.1 | **依赖面广**：核心 16 包 + webui 12 包；仅 WebUI 就要 `cryptography`（argon2/rehash 校验）、`fastmcp`+`mcp`（MCP 协议栈）、`pillow`（缩略图）、`docutils`（解析自家 docstring！）、`filelock`；构建走 poetry + PyInstaller 六架构独立包 + winget | 中 | `pyproject.toml:44-63`、`docs/` 与 `.github/workflows/release.yml`（grep pyinstaller action） | 转写 Node 后端后依赖可砍到 http 客户端+sqlite 一个库；**规避**docutils 解析 docstring 这种"工具依赖工具文档"的链路 |
| 8.2 | **Python 3.10–3.14 全兼容声明**：为 3.14 修过 `windows-curses`/`uvloop`/`winloop` 锁版；Windows x86 发布包嵌 Python 3.13（32 位无 wheel）；`.probe-ktoolbox/ktoolbox/__pycache__/__init__.cpython-38.pyc` 还残留 py38 字节码（仓库不干净） | 低 | `CHANGELOG.md:27-29`、`glob` 结果第 475 行 | Node 侧无此负担 |
| 8.3 | **前端构建要求 Node ≥24**（`engines.node >=24`，CI 用 Node 24 锁文件）：复用原 bundle 需要 Node 24 工具链 | 低 | `webui/package.json:6-9`、`CHANGELOG.md:231`（"Node 24 锁文件构建"） | 可接受，Vite/Rolldown 生态 |

## 9. 安全

| # | 不足描述 | 严重度 | 证据 | 启示 |
|---|---|---|---|---|
| 9.1 | **默认 0.0.0.0 + 明文 HTTP + 首次启动随机密码**：`WebUIConfiguration.host="0.0.0.0"`、`port=8789`、无密码时打印随机 `admin/<random>` 到终端（README 引导"照终端登录"）——NAS/服务器场景开 WebUI 即暴露到全网，控制台随机密码在终端历史/CI 日志留痕 | 高 | `ktoolbox/configuration.py:366-374`、`ktoolbox/webui/server.py:82-87`（打印 + "Security warning: HTTP traffic is unencrypted" 仅一行提示）、`docs/en/webui.md:69-73`（建议 127.0.0.1 但默认值不是） | 转写默认 `127.0.0.1` + 强制 HTTPS 提示 + 首启向导强制设密；**绝对不要**照搬 0.0.0.0 默认 |
| 9.2 | **Argon2 密码哈希实现规范**（亮点）：`password_hash` 优先、明文 `password` 仅兼容（hmac.compare_digest 恒定时间比较），启动校验 hash 合法性/`check_needs_rehash`，cookie 仅在 https 时 `Secure`（`test_argon_hash_takes_precedence_and_https_cookie_is_secure`） | 低（正向） | `ktoolbox/webui/auth.py:73-99,163`、`tests/ktoolbox/test_webui_auth.py:73` | **借鉴**整套登录安全件（恒定时间比较/hash 校验/Secure cookie 开关） |
| 9.3 | **登录限流按 `IP+用户名` 内存态**（5 次/300s，deque），多副本/重启即失效；无全局锁 | 中 | `ktoolbox/webui/auth.py:29-54`（`LoginRateLimiter`，`self._attempts` 实例 dict） | 转写落 SQLite（限流计数表）跨重启有效 |
| 9.4 | **MCP token 设计安全**（亮点）：`ktmcp_<secrets.token_urlsafe(36)>` 只展示一次，库内只存 sha256（`token_digest`），read/manage 双 scope，撤销即时（`revoked_at`），last_used 节流写；但 **HTTP 传输层无 TLS 强制**——bearer token 走明文 8789 端口风险由网络环境兜底（文档已自述"never send over untrusted plaintext network"） | 中（传输层短板） | `ktoolbox/webui/mcp_tokens.py:61,83`、`ktoolbox/webui/database.py:16-17`、`docs/en/mcp.md:54-56` | **借鉴** token 哈希存储+scope+过期窗；转写加可选 mTLS/反代强制 |
| 9.5 | **路径穿越防护完整**（亮点）：`FilesystemBrowser` 双 resolve 校验（requested 与 resolved 都 `_ensure_allowed`）、project scope 拒绝父级/符号链接逃逸（`test_filesystem_scope_rejects_parent_and_symlink_escape`）、host scope 可 `restrict_host_to_roots`；删目录只允许空目录；文件创建名校验（禁 `.`/`..`/分隔符/NUL） | 低（正向） | `ktoolbox/webui/filesystem.py:104-118,368-374`、`tests/ktoolbox/test_webui_filesystem.py:228` | **借鉴**双 resolve + 符号链接逃逸测试用例，转写 Node 侧等价实现 `path.resolve` 前缀断言 |
| 9.6 | **SSRF 面收敛**（亮点）：MCP 只暴露"curated"工具（`_route_map` 按 `x-ktoolbox-mcp.enabled` 过滤，搜索类标 `open_world`），登录/登出/raw dotenv 编辑/任意 host 文件访问/删除输出 均不暴露；媒体代理限定白名单格式+大小+像素 | 低（正向） | `ktoolbox/webui/mcp_server.py:90-92`、`docs/en/mcp.md:46` | **借鉴**"工具面显式清单+安全级别注解（readOnly/destructive）"做法 |
| 9.7 | **事件/失败报告脱敏**（亮点）：`FailureItem` 有界字段（max_length 500/100 项截断）、`redacted_configuration` 排除 `session_key/password`，`event_store` 测试 `test_webui_event_store_wakes_subscribers_and_redacts_sensitive_values` | 低（正向） | `ktoolbox/failures.py:42-57`、`ktoolbox/configuration.py:484-490` | **借鉴**失败报告"有界+脱敏"契约，WebUI 直接展示不泄密 |

## 10. 其它坑（清单补充与交叉验证）

| # | 坑 | 严重度 | 证据 | 启示 |
|---|---|---|---|---|
| 10.1 | **每次 CLI 命令查更新**：`check_for_updates` 顺序打 GitHub→PyPI 两个外网（各 5s 超时），`download`/`sync` 前 `_ensure_update_check` 各进程一次（`cls._update_checked` 类属性）——离线/NAS 内网环境每次多 2 次外联 + 最坏 10s 延迟；失败静默吞掉（`except: pass`） | 中 | `ktoolbox/utils.py:240-285`、`ktoolbox/cli.py:64-83`（`_ensure_update_check`） | 转写：更新检查做成显式子命令（`ktoolbox update-check`），下载路径零外联 |
| 10.2 | **bucket EXDEV 静默降级**（同 §3.8）+ **静默降级**：探针失败只 `logger.exception`，用户配置了 `use_bucket=true` 但实际没开，且无 WebUI 提示——"你以为开了去重，其实每次全量下载" | 高 | `ktoolbox/configuration.py:125-130`（异常→`self.use_bucket=False`） | 转写：降级必须进 UI 可见告警（`startup_notices` 表已有此机制，`naming_service` 的 notice 机制可借鉴） |
| 10.3 | **自动同步冲突静默 skip**（同 §2.2）：skip 事件进 `auto_sync.run.skipped` 事件流，但任务列表页看不到；只有自动同步页的"recent updates"可查 | 中 | `ktoolbox/webui/auto_sync_scheduler.py:152-158`、`ktoolbox/webui/auto_sync_store.py:81-95` | 转写：skip 生成一条"可见任务"或全局 banner |
| 10.4 | **`ktoolbox webui` 在 Windows x86 上 auth 栈被锁旧版 cryptography**（32 位 wheel 限制），发布说明自述"保持 WebUI 认证栈可用"的代价是安全库版本落后 | 低 | `CHANGELOG.md:29` | 无直接转写影响，记录即可 |
| 10.5 | **`api.generated` 生成物被 mypy/ruff/coverage 全排除**：生成层是黑盒，漂移只靠 drift 日志；`k_generator/` 脚本与 CI 手动触发，无自动再生成 | 中 | `pyproject.toml:118-129,138-141` | 转写：schema→TS 类型用 openapi-typescript（前端已有 `generate:api` 脚本 `webui/package.json:12` 可复用） |
| 10.6 | **`reverse_proxy` 用 `str.format` 拼 URL**（`config.downloader.reverse_proxy.format(self._url)`）：格式串 `{}` 占位，URL 里若含 `{}` 字符会被 format 吃掉/报 IndexError——边界脆弱 | 中 | `ktoolbox/downloader/downloader.py:269`、`configuration.py:109`（默认 `"{}"`） | 转写用 `url.replace("{}", url)` 或模板引擎安全替换 |
| 10.7 | **外部链接提取=正则黑名单式**（14 条平台正则+一条"generic `(?:file|upload|share|download|drive|storage)`"贪婪正则，误报率高：任何域名含 "drive/share" 的 URL 都算文件托管）；`extract_external_links` 默认 False 才避坑 | 中 | `ktoolbox/configuration.py:254-288`（正则表）、`:251-252`（三个 extract_* 默认 False） | 转写：白名单平台+可配置模式，别用 generic 兜底正则 |
| 10.8 | **`job.count` 上限 64 但下载吞吐被 tps_lock 锁 5/s**（§3.2+§6.3 交叉）：`le=64` 的 Field 校验给人"能开 64 并发"错觉 | 中 | `ktoolbox/configuration.py:243` | 转写并发数与速率桶做成同一屏联动显示 |

---

## TOP 10 需要规避的坑（转写决策优先级）

1. **【高】默认 0.0.0.0 + 明文 HTTP + 终端随机密码**（§9.1）→ 默认 127.0.0.1、首启强制设密、HTTPS 反代向导。
2. **【高】反爬零手段：无自定义 UA 配置、session_key 靠手填、403 无退路**（§3.1/§3.9）→ 可配置 UA 池 + cookie 自动刷新 + 403 诊断面板。
3. **【高】全局 `wait_lock` tps_limit=5/s 锁死吞吐，并发数形同虚设**（§3.2/§6.3）→ 全局速率令牌桶，与并发解耦。
4. **【高】配置双源分裂（toml 项目层 + .env 引擎层）+ README 误导**（§1.2）→ 单一项目配置，env 仅覆盖。
5. **【高】beta 半成品定位（v1.1.0-beta.1 自认未充分验证）**（§2.1）→ 复用其前端必须逐项实测 107 API，`webui/openapi.yaml` 当验收基准。
6. **【中】断点续传只认 206 无全量 fallback + temp 残留 + 完整性零校验 + 去重只查存在性**（§3.4/§3.5/§3.6）→ 200 fallback 重写、temp GC、Content-Length 断言、size/hash 索引去重。
7. **【中】bucket EXDEV 静默降级 + 自动同步冲突静默 skip**（§10.2/§10.3）→ 任何静默降级/跳变必须进 UI 可见告警（借它自己的 `startup_notices` 机制）。
8. **【中】每次 CLI 命令外联 GitHub/PyPI 查更新**（§10.1）→ 更新检查独立子命令，下载路径零外联。
9. **【中】0.25s 轮询调度 + 每任务 deep 快照重读配置 + 全表 SELECT 派发 + 逐事件写 SQLite**（§6.1/§5.3）→ 事件驱动调度 + SSE + 聚合快照事件。
10. **【中】前端强耦合 `/api/v1`+cookie+CSRF+`/assets` 绝对路径，复用=1:1 复刻 107 操作契约**（§5.1）→ 要么复刻契约，要么只借鉴组件换壳（砍 HeroUI 省 300KB+）。

## 值得借鉴的 10 点

1. **OpenAPI 契约入仓 + CI 比对**（`webui/openapi.yaml` 提交、`test_committed_webui_openapi_is_valid_and_current`、前端 `generate:api` 出 TS 类型）——前后端防漂移的完整闭环。
2. **`PawchiveClient` 结构化错误体系**：transport/http/auth/not-found/conflict/response-validation 六类异常 + `FailureStage`（creator_profile/work_list/work_detail/revisions/job_generation/file_request/file_write/index_write）分类，失败报告有界脱敏（`failures.py` 全文）。
3. **命名转换"预览→指纹失效→执行→可暂停→可回滚"状态机**（`naming_operations` 表逐条 status + `fingerprint` 防陈旧 + `test_cancelled_conversion_rolls_back_every_completed_move`）——大批量文件迁移的正确姿势。
4. **自动同步 checkpoint 去重**：按 creator 独立 checkpoint + 24h 重叠窗 + "no start date=建基线不扫全历史"（`automatic_sync.py`、`auto_sync_scheduler.py:101-126`）。
5. **安全件全家桶**：Argon2 hash 优先+恒定时间明文比较、登录 IP+用户名限流、CSRF 双提交、MCP token 只存 sha256+scope+revoked、媒体代理白名单/像素上限/大小上限（`auth.py`/`mcp_tokens.py`/`media.py`）。
6. **文件系统浏览器双 resolve 防穿越**（requested+resolved 都校验 allow-root，符号链接逃逸有专门测试，`filesystem.py:104-118`）。
7. **`FairJobQueue` 每创作者 lane 轮询公平调度**（`job/stream.py:37-95`）——多作者任务防饿死，思路可移植到 Node。
8. **任务终态恢复**：启动时 `recover_interrupted` 把 running→interrupted 并收尾 attempts（`task_store.py:73-115`）+ `ProjectProcessLock` 单实例锁。
9. **离线测试纪律**：`pytest-socket --disable-socket` + respx mock + 测试全部不触网（`pyproject.toml:112`）；文档/本地化/README 一致性也进测试（`test_docs_i18n.py` 8 用例）。
10. **响应漂移观测**（`ResponseDrift`/`_collect_model_extras`）：上游 API 加字段不崩，日志告警——适配 Pawchive 不稳定性的低成本手段。

## 不确定项（未验证，需后续实测）

- 3.4/3.5 的"temp 残留无清理、无完整性校验"基于源码通读，未跑真实下载复现；Pawchive 文件 CDN 实际是否支持 206/忽略 Range 需 curl 实测（本次审计未执行网络探测，遵守"只读审计"约定）。
- 5.1 前端复用成本：未真正在 Node 环境起一个 107 操作 mock 验证前端可运行性（bundle 是 Rolldown 产物，依赖浏览器环境，静态审查无法确认可直接挂任意后端）。
- 6.2 的 NFS 性能结论是推断（指纹全树 stat、`creator_indices.json` 全量写），未在本机 NFS 上压测。
- `min_file_size` "效果"（3.3）：源码确认默认 None=不过滤；"漏下载"风险是否真实取决于 Pawchive 附件分布，未验证。
