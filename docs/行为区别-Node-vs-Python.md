# Node 后端 vs Python 原版 KToolBox 行为区别（研究日期 2026-09-29）

> 本研究为**独立代码研究**：只读两侧实际代码（Node：cli.js / core.js / adapters/KToolBox-webui.js / server.js；Python：docs/.probe-ktoolbox/ktoolbox/ 下 webui、downloader、api、job、sync、auto_sync），
> 逐项比对行为差异并落盘。代码证据格式：`文件:行`（相对本仓库根；Python 侧相对 docs/.probe-ktoolbox/ktoolbox/）。
> 未修改任何代码。

---

## 逐项对比

### 1. 任务创建去重

- **Python 原版**：创建任务先做**双重去重**。
  - spec 级精确查重：`task_store.py:119-128` `create()` 调 `find_duplicate(spec_json)`；`task_store.py:162-171` 按 `spec_json = ? AND status IN (ACTIVE_TASK_STATUSES)`（queued/blocked/running/pause_requested/stop_requested，`task_models.py:29-35`）查库，命中抛 `DuplicateTaskError(task_id)` → 路由层转 **HTTP 409 + `{"message", "existing_task_id"}`**（`task_routes.py:73-77`；更新任务同样查重 `task_store.py:258-260`）。
  - 资源冲突调度：`task_scheduler.py:39-44` `TaskResources.conflicts_with`（output 路径重叠 且 帖/作者有交集）→ `task_scheduler.py:192-204` 调度循环把冲突任务标 **blocked + blocked_by**，等先占者结束才解除。
- **我们 Node**：无去重。`adapters/KToolBox-webui.js:491-518` POST /tasks 直接 `core.createTask`（`core.js:150-155` 无条件 INSERT）+ `core.downloadTask` 立即执行，恒返回 201。`core.js` 的 `blocked` 状态在 TASK_STATUS 里存在（`core.js:146`）但**无人设置**（无调度循环、无 blocked_by 逻辑）。
- **差异影响**：重复创建同作者/同帖任务时：①Python 直接 409 拒绝并告知已有任务 id；Node 照单全收 → 同一作者被并发下载多遍（文件级去重可能兜住部分，但 API/TPS/网络全量重复消耗）；②两个任务同时下同一帖子会写**同一个 .tmp/正式文件**（无跨任务锁，见第 4 项）→ 文件写竞态/损坏风险。
- **建议对齐**：adapter/core 增加 spec 精确查重（active 状态）→ 409 + existing_task_id；可选加资源冲突 blocked 调度。用户可感知的「重复下载」即源于此。

### 2. 任务控制/取消（stop/pause/resume/rerun）

- **Python 原版**：**真中断**。`task_scheduler.py:124-135` pause() / `137-148` stop_task()：对 running 任务先写 pause_requested/stop_requested 状态，再 `running.task.cancel()` 真取消 asyncio 任务；`task_scheduler.py:241-243` `_execute` 捕获 `asyncio.CancelledError` 按 requested_final_status 落终态。取消**级联到下载器**：executor（`task_executor.py:138` JobRunner.start）→ `stream.py:143-150` gather 异常时 `worker.cancel()` → `stream.py:204-206` worker 抛 CancelledError → `downloader.py:325-327` chunk 循环检查 `self._stop` 抛 `CancelledError`（`downloader.py:144-150` cancel() 置位）。当前文件真被中断、.tmp 保留供续传。
- **我们 Node**：**只改状态标记**。`adapters/KToolBox-webui.js:542-554` run/stop/pause/resume/rerun 全部走 `core.updateTaskStatus`（`core.js:164-168` 仅 UPDATE 状态字段），注释自认「cli 内嵌下载无中断接口，真实取消 TODO」。cli 下载链（`downloadAuthor`→`downloadOnePost`→`downloadFile`→`streamOnce`）**没有任何 abort 通道**（streamOnce 的 abortCtl 只用于慢速退避 `cli.js:741/881`，不响应任务状态）。后果：
  - 点 stop/pause：状态变 stopped/paused，**下载继续跑**；
  - 下载最终完成后 `core.js:296` `updateTaskStatus(taskId, 'completed')` **无条件覆盖 stopped/paused**；
  - rerun → 状态变 queued，但**无调度器**（Node 无 dispatch 循环）→ 永不重跑；
  - resume → 变 running，同样无实际作用。
- **差异影响**：用户点「停止/暂停/重跑」全部无效（停止后下载照跑、状态还被 completed 覆盖；重跑不执行）。这是最直接的用户可感知差异。
- **建议对齐**：引入 AbortSignal/取消令牌贯穿 `downloadTask → downloadAuthor → downloadFile → streamOnce`（中断 curl 子进程，保留 .tmp）；rerun 需要任务队列调度器（或至少 resume 语义 = 重新执行）。

### 3. 任务进度统计字段（TaskProgress）

- **Python 原版**（`task_models.py:194-206` 字段全集：queued_files/processed_files/completed_files/existing_files/failed_files/transferred_bytes/total_bytes/speed_bps/eta_seconds/active_creators/active_downloads/waiting_retries；聚合实现 `task_reporter.py`）：
  - `transferred_bytes`：**累计**——`task_reporter.py:123` 断点续传起始补差 `+= max(completed - previous_completed, 0)`；`task_reporter.py:157` 每次 chunk `+= amount`。
  - `total_bytes`：已知文件 total **累计**（`task_reporter.py:125-129` first_start 时 `_known_total += total`；出现未知 total 则置 None）。
  - `speed_bps`：5s 滑动窗口差分 `(Δtransferred_bytes / Δt)`（`task_reporter.py:288-297`），空闲 1.5s 清 0（320-327）。
  - `eta_seconds`：`(total - transferred) / speed`（`task_reporter.py:303-309`），无 total/speed 时 None。
  - 终态清理：`task_store.py:512-518` `_finalized_progress` 清空 active_creators/active_downloads/waiting_retries、speed=0、eta=0/None。
- **我们 Node**（`core.js:248-273` progressReducer）：
  - `transferred_bytes = Math.max(prev, d.size)`（`core.js:256`）——**取当前最大单文件瞬时 doneBytes，非累计**（cli 的 job.progress 事件 size 语义 = 当前文件已写字节，见 `cli.js:1517/1640`）→ 任务真实累计流量远大于显示值。
  - `total_bytes` 恒 **null**（`core.js:249` 初始 null，无任何 case 更新）→ 前端百分比无基准。
  - `eta_seconds` 恒 **null**（`core.js:249`，无计算）。
  - `speed_bps` 直接覆盖 `d.speed`（`core.js:257`）——单文件瞬时速度，非总速度。
  - `active_downloads` 只由 job.progress 写入（`core.js:258`），job.downloaded/existed/failed **不清除**（`core.js:261-263`）→ 任务完成后 active_downloads 残留旧条目。
- **差异影响**：Node 任务详情/列表里「已传输字节」严重偏小（只等于当前最大单文件）、「总字节数/ETA」永远显示 null、完成后「活动下载」残留非空。前端统计失真。
- **建议对齐**：transferred_bytes 改累计（cli 事件带增量，或 downloadWithDedup 返回 size 累加）；total_bytes 累计已知 size；speed 用滑动窗口；任务结束（completed/failed/stopped）清 active_downloads、speed=0。

### 4. 下载执行形态（并发模型/串行/同文件锁范围）

- **Python 原版**：
  - 下载执行 = **文件级 worker 池**：`stream.py:117-151` `DownloadWorkerPool` N 个 worker 共享一个 httpx 连接池，从 `FairJobQueue`（`stream.py:37-94`，每 creator 一个 lane、round-robin）逐个取**文件 job**——同一帖内多个文件可并行下载；单帖任务也全入 "direct" 单 lane（`runner.py:66-68`）。
  - sync 任务 = creator 级并发 semaphore（`sync.py:122`）+ 文件级下载池（`sync.py:109`）。
  - 任务间：TaskScheduler 全局 `max_concurrency` 上限（`task_scheduler.py:207-208`）+ 资源冲突 blocked（见第 1 项）——**跨任务不会同时下载同作者/同帖**。
  - 同文件 in-flight 防护：下载器实例锁 `_finished_lock`（`downloader.py:97/260`，每下载实例一把）+ 类级全局 `wait_lock` 只做 TPS 限速（`downloader.py:53/258-259`）；真正的同文件防重靠 bucket 去重 + 任务级冲突调度。
- **我们 Node**：
  - 下载执行 = **帖子级 worker 池**：`cli.js:1724-1754` `downloadAuthor` 同时最多 concurrency 个**帖子**并行，每帖内文件**串行**（`inPostConcurrency: 1`，`cli.js:1745`）；帖启动间隔 postInterval（`cli.js:1741-1743`）。注释自认「等价 KToolBox DownloadWorkerPool」，但粒度不同（帖级 vs 文件级）。
  - in-flight 锁 = **每帖一个独立 Map**（`cli.js:1628`，downloadRevision 另建 `cli.js:1505`）——只防单帖内同 URL 重复，**不跨帖、不跨任务**。
  - 任务间：**无全局并发上限、无冲突调度**（core.downloadTask 各自独立跑，`core.js:277-306`；并发 N 个任务即 N×concurrency 实际并发）。
- **差异影响**：①单帖任务（1 帖）Node 帖内文件串行 = 实际并发 1，Python 文件级并发（同帖多文件并行）；②Node 跨任务下载同一作者/帖子无保护 → 同一 .tmp/正式文件被两个任务同时写（竞态损坏）；③Node 无全局任务并发闸，多任务并发把 API/TPS 放大 N 倍。
- **建议对齐**：至少把同文件锁提升为**跨任务共享**（进程级 in-flight Map 键 = serverPath）；可选改文件级 worker 池；任务级并发上限与冲突调度对齐。

### 5. 断点续传

- **Python 原版**（`downloader/downloader.py:258-351`）：`.tmp` 临时文件（`{save}.{temp_suffix}`，261 行）→ stat temp_size（263-265）→ 请求 `Range: bytes={temp_size}-`（275 行）→ **显式处理 200/206**：200 时 `temp_size=0` + 删除 temp 从头重写（277-283）；非 206 直接失败（284-290）；Content-Range 尾段解析 total（306-316）→ `aiofiles.open(temp, "ab")` 追加写（321）→ **完整性断言**：temp 实际字节 ≠ total → GeneralFailure 触发重试（334-346，temp 保留）→ 完成后 rename 落盘（351）。**无 fsync**。
- **我们 Node**（`cli.js:702-850` downloadFile + `861-903` streamOnce）：`.tmp` 后缀 `PAWCHIVE_TEMP_SUFFIX || '.tmp'`（`cli.js:70`）→ stat .tmp 得 tempSize（706-707）→ `curl -C {tempSize}`（`cli.js:869`）由 curl 处理 Range/200（200 时 curl 从头覆盖重写）→ 完整性校验在 downloadFile（`cli.js:799-823`：Content-Length/预期大小比对、376B 反爬占位、404 页特征）→ rename 落盘（825）。**无 fsync**。
- **差异影响**：机制基本对齐（.tmp + Range 续传 + 200 重置 + 完整性校验 + rename）。细微差别：Python 完整性失败**保留 .tmp 重试**；Node 反爬占位/大小不符**删除 .tmp 重试**（`cli.js:812`）；Python 用 Content-Range 拿 total（Node 用 Content-Length/API size）。两者都能续传，无重大用户差异。
- **建议对齐**：行为已等价，无需强制对齐；可选补显式 206/200 分支（不依赖 curl 语义）与 fsync（掉电安全，可选）。

### 6. 硬链接去重（同 serverPath 多位置）

- **Python 原版**：
  - 去重判据 = **目标路径存在即跳过**（`downloader/utils.py:75-96` `duplicate_file_check`），**无大小比对**（损坏文件存在也会被跳过）。
  - 跨位置复用靠 **use_bucket 桶**：server_path 本身就是 hash 路径（`/xx/yy/hash`，见 `downloader.py:93` 注释），`bucket_file_path = bucket_path / server_relpath`（246-248）——bucket 文件存在 → `os.link(bucket, local)` 硬链接（utils.py:91）；下载完成后 `os.link(temp, bucket)` 写桶（347-349）。**链接源 = bucket 桶文件**（全局跨作者复用）；不启用 use_bucket 时只查目标路径。
- **我们 Node**：
  - 去重索引 `buildHashIndex`（`cli.js:1213-1264`）：扫描**该作者全部账号目录**（主账号 + 关联渠道 links）的 pawchive-index.html files 记录 → `Map<serverPath, {rel, size}>`（键是 serverPath，不是内容 hash，`cli.js:1255`）。
  - 去重流程 `downloadWithDedup`（`cli.js:1289-1338`）：目标已存在 + 大小与记录一致 → exists 跳过；**大小不符 → 删旧重下**（1299-1302，Node 有 Python 没有的损坏自愈）；in-flight 同 URL 等待首个完成（1309-1317）；记录 rel 存在 → `linkOrCopy` 硬链接复用（1320-1323）；`linkOrCopy`（`cli.js:1267-1276`）硬链接失败（跨卷/NFS）**回退 copyFile**。**链接源 = 扫描中最后写入记录的目录**（`index.set` 后写覆盖先写，`cli.js:1255`，遍历顺序依赖，非确定性）。
- **差异影响**：①Node 无 bucket → 首次下载后，**其他作者的目录**想复用同一文件只能靠再扫该作者目录（跨作者不复用；Python bucket 全局复用）；②Node 有大小比对自愈（Python 损坏文件永久跳过——见第 9e 项）；③Node 链接源选择依赖目录遍历顺序（多个位置命中同一 serverPath 时可能链到「最后扫到」的位置，不保证最优/稳定）。
- **建议对齐**：跨作者复用可引入全局 bucket（可选，Node 目前按作者扫描够用）；保留大小比对（Node 优势）；链接源选择建议按「存在 + 大小匹配」显式择优（消除遍历顺序依赖）。

### 7. .tmp 残留清理

- **Python 原版**：**基本不清**。中断（CancelledError）保留 .tmp 供续传（`downloader.py:260-330` 无 except 清理）；4xx（非 200/206）直接失败**不删** temp（284-290）；完整性校验失败**不删**（334-346）；**仅** 200 响应（服务端忽略 Range）时删 temp（277-283）。→ 永久性失败（如 404 链接）的 .tmp 会一直留在磁盘。
- **我们 Node**：**中断保留、异常内容清理**。中断/重试/慢速退避均保留 .tmp 供续传（`cli.js:751/762/842`）；但 4xx/404（curl_exit_22）**删 .tmp**（`cli.js:769`）、反爬占位（376B/404 页/大小不符）**删 .tmp**（`cli.js:812`）、缩略图回退失败**删 .tmp**（`cli.js:794`）；成功 rename（825）。
- **差异影响**：两边中断都留 .tmp（正常续传行为，不构成 bug）；区别在「无效内容」：Node 会把 404/占位 .tmp 清掉，Python 会残留（磁盘垃圾 + 下次任务 stat 到无效 temp 仍发 Range 请求）。若用户反馈「有 .tmp 残留」，Python 侧更可能堆积，Node 侧主要在「进程被 SIGKILL/断电」场景残留。
- **建议对齐**：Node 行为已优于 Python，无需对齐；可加可选「启动时清理超过 N 天的 .tmp」策略（两边都可受益）。

### 8. auto-sync（计划触发查重 + 增量窗口）

- **Python 原版**：**双重查重 + 增量窗口**。
  - 计划到期 `_trigger_due_plans`（`auto_sync_scheduler.py:143-166`）：先查 `store.active_run(plan.id)` —— 同计划已有 active run → `mark_skipped`（不重复触发，152-158）；无 → 才 _enqueue（160-165）。
  - 手动 run `run_now`（100-106）：active run 且带 task_id → `AutomaticSyncConflictError` → 路由 **HTTP 409 + `{"message", "current_task_id"}`**（`auto_sync_routes.py:191-196`）。
  - _enqueue 再经 `task_scheduler.create` 的 spec 查重（DuplicateTaskError → 同样 conflict，`auto_sync_scheduler.py:205-209`）。
  - 增量窗口：`_window`（216-243）用 checkpoint（上次成功位置 - 24h overlap）限定帖子时间范围，避免全量。
- **我们 Node**：**无查重、无增量**。
  - `core.js:372-380` `triggerAutoSyncPlan`：遍历 plan.creators 直接 `createTask` + `downloadTask`（.catch 吞错），无任何「同计划是否已在跑」检查。
  - `startAutoSyncScheduler`（`core.js:382-394`）每分钟 tick，到期即触发（388），**不检查上次任务是否完成**；`adapter` run 端点（`KToolBox-webui.js:290-300`）直接 trigger 返回 200（无 409）。
  - 无 checkpoint：每次触发全量 fetch 作者列表 + 全量扫描（下载阶段靠文件级去重跳过）。
- **差异影响**：①计划到期时上次任务未完成 → Node 再建新任务并真实发起下载（重复请求/并发写竞态）；②手动 run 无 409 告知「已在跑」；③每次全量拉取（API 开销大、慢）。
- **建议对齐**：加计划级 active-run 查重（同 plan 有运行中任务则跳过/409 + current_task_id）；spec 级查重随第 1 项补齐；可选加 checkpoint 增量窗口。

### 9. 其他发现的行为区别

| # | 行为项 | Python 原版 | 我们 Node | 影响 |
|---|--------|------------|-----------|------|
| a | 任务调度/排队 | TaskScheduler 调度循环（`task_scheduler.py:175-209`）`max_concurrency` 全局上限，超出 queued 排队 | 无调度循环，创建即立即执行（adapter 515），无全局上限 | 多任务并发放大实际请求；无排队语义 |
| b | 删除任务 | delete 前必须 stop（`task_store.py:474-477` InvalidTaskStateError） | 直接 `DELETE FROM tasks`（`KToolBox-webui.js:525`），**不停止进行中的下载** | 删除后下载继续跑完、DB 无行（orphan 任务），状态更新落到不存在的行 |
| c | 已完成帖快速跳过 | 无（每次全量 fetch 帖子列表，靠文件级去重） | downloadAuthor 基于创作者 html `downloaded==fileCount` 跳过完整帖（`cli.js:1713-1722`） | Node 省 API 请求（优势）；但快跳过依赖 html 标记，旧数据可能误跳/漏补 |
| d | 原图 404 降级 | 4xx 直接失败（downloader.py:284-290） | 回退缩略图 + `_thumb` 后缀落盘（`cli.js:766-795`） | Node 独有降级产物（行为差异，非问题）；前端/后续迁移需识别 _thumb 语义 |
| e | 损坏文件自愈 | 存在即跳过、不比对大小（utils.py:85） | 大小不符 → 删旧重下（`cli.js:1299-1302`、`1577`） | Python 对「存在但损坏」文件永久跳过；Node 会自愈（Node 优势） |
| f | 认证 | require_session/csrf（`task_routes.py:58-67` 等） | session 全放行 dev-noauth（`KToolBox-webui.js:117-126`） | Node 无鉴权（安全面差异，属设计取舍，用户需知悉） |
| g | 启动恢复中断 | recover_interrupted 把 running 标 interrupted（`task_store.py:73-117`） | 同：启动时 UPDATE 状态为 interrupted（`core.js:82-86`） | 行为一致（无差异） |
| h | 进度事件流 | download.started/advanced/retrying/finished + job.queued，0.2s 合并 flush（`task_reporter.py:339-344`） | cli 原生事件 job.progress（500ms 轮询 `cli.js:878`）/job.queued/job.downloaded/existed/failed + post.completed，逐事件写 DB（`core.js:283-285`） | 事件契约不同（adapter 透传）；Node 每 500ms 写一次 DB（写入频率高） |
| i | sync 任务默认作者 | 无 creators 时默认取全部 enabled 作者（`task_routes.py:270-274`） | 无 creators/service 直接 400（`KToolBox-webui.js:510`） | 契约差异：Python 空 sync 有默认行为，Node 拒绝 |

---

## 用户反馈问题对应（研究后判断）

以下差异**最可能**对应到用户可感知的问题（若用户反馈过「重复下载 tmp」「任务停不下来」「进度不对」「自动同步重复跑」，均可从下表定位根因）：

1. **「重复下载 / 重复任务」** → 第 1 项（任务创建无去重）+ 第 8 项（auto-sync 无查重）。我们 Node 对同作者/同帖重复创建任务不拒绝（Python 409 + existing_task_id），计划到期会重复触发任务并真实发起下载请求。文件级去重（`downloadWithDedup` exists 跳过）能兜住「已完整下载」的文件，但 API 拉取/TPS/并发写竞态仍重复发生；.tmp 也因竞态被反复读写。
2. **「任务停不下来 / 点了停止还在下」** → 第 2 项（stop/pause 只改状态标记）。Node 的停止/暂停/重跑全部是空操作（Python 真 cancel 级联到下载器），且下载完成后状态被 `core.js:296` 无条件覆盖为 completed。
3. **「进度数字不对 / 总字节显示空 / ETA 没有」** → 第 3 项（进度统计字段）。Node transferred_bytes 取 max 非累计（远小于真实）、total_bytes 与 eta_seconds 恒 null、完成后 active_downloads 残留。
4. **「自动同步每次全量跑 / 重复触发」** → 第 8 项（auto-sync 无 active-run 查重、无 checkpoint 增量窗口）。
5. **「有 .tmp 文件残留」** → 第 7 项。两边中断时都保留 .tmp（正常续传）；Python 对永久失败（404 等）也不清（易堆积），Node 主要在进程被强杀/断电场景残留。不属于「谁清谁不清」的简单问题，而是两边清留时机不同。

---

## 独立发现总结

最可能导致用户可感知异常、建议优先对齐的 5 个行为差异：

1. **任务创建无去重（Node 无 409 / existing_task_id / blocked 调度）**——重复任务真实重复下载、并发写同一 .tmp 竞态（`adapters/KToolBox-webui.js:491-518` vs `task_store.py:162-171` + `task_routes.py:73-77`）。
2. **stop/pause/resume/rerun 只改状态标记，下载不停、终态被 completed 覆盖、rerun 永不执行**（`adapters/KToolBox-webui.js:542-554` + `core.js:296` vs `task_scheduler.py:124-148` + `stream.py:204-206`）。
3. **进度统计失真：transferred_bytes 取 Math.max 非累计、total_bytes/eta_seconds 恒 null、active_downloads 完成不清理**（`core.js:248-273` vs `task_reporter.py:123/157/288-309` + `task_store.py:512-518`）。
4. **auto-sync 无 active-run 查重、无 checkpoint 增量**——计划到期重复触发任务并全量拉取（`core.js:372-394` vs `auto_sync_scheduler.py:143-166/216-243` + `auto_sync_routes.py:191-196` 的 409 + current_task_id）。
5. **无任务调度器：无全局并发上限、跨任务同文件无锁（in-flight 仅单帖内）、删除任务不停止下载（orphan）**（`cli.js:1628` inFlight 每帖独立 vs `task_scheduler.py:192-209` 冲突 blocked + max_concurrency；`KToolBox-webui.js:525` 直接删行 vs `task_store.py:474-477` 先 stop）。
