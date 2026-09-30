# Pawchive-downloader

**最小 Node.js CLI**：零依赖，Node 18+ 全局 `fetch` 即可运行，Pawchive 公开作品下载器。

## 用法

```bash
node cli.js <url> <path> [--dryrun] [--offset N] [--length N] [--concurrency N] [--index <索引文件>]
```

| 参数 | 说明 |
|------|------|
| `url` | Pawchive 页面 URL：创作者页 `https://pawchive.pw/{service}/user/{creator_id}`，或单帖页 `https://pawchive.pw/{service}/user/{creator_id}/post/{post_id}`，本 CLI 自动识别下载范围（全量或单帖） |
| `path` | 下载目标根目录 |
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

- **拉取索引**：分页每页落盘 `/.pawchive/*.index.json`，中断续拉、缓存复用；**作者更新检测**——全量缓存（done）每次运行拉最新一页校验，作者发新帖自动失效重拉
- **下载流程（并行，每帖 html 前置/后置）**：每帖先生成 `pawchive-index.html` → 大小校验（与 html 记录 size 对比，不符=损坏覆盖）→ 下载（.tmp 断点续传 + Content-Length/Content-Range 头解析作完整性校验，376B 反爬占位与 404 页面不落盘）→ 帖下载完刷新帖 html **并同步刷新创作者级总览 html**（每帖都刷新，含全跳过帖）
- **并行下载**：并发数由 `--concurrency`/`PAWCHIVE_CONCURRENCY` 控制（默认 5，file host 活动下载上限），**持续维持并发数**（完成一个立即补位，非组式等待）；帖启动间隔防 API 解析连发
- **快速跳过**：下载前读创作者级 html 的帖子总览（fileCount/downloaded），已完整下载的帖直接跳过、不解析详情
- **查重跳过**：目标已存在**且大小与 html 记录一致**才跳过；存在但大小不符 → 覆盖重下（.tmp 续传）；**无记录但文件存在 → 保守跳过**（历史下载文件不重下、不覆盖）
- **断点续传**：写入 `<文件>.tmp`，中断重跑从断点继续；失败自动重试（**HTTP 4xx/5xx 确定性失败不重试**，网络错误重试；带 UA，File host Range 续传实测 9.4MB/s）
- **大小写冲突**：不同渠道作者名仅大小写不同（Akt vs akt）时自动加「(平台)」前缀（如 `(patreon) Akt`，前缀格式由 `PAWCHIVE_CREATOR_PREFIX_FORMAT` 配置），兼容大小写不敏感文件系统；同名不同大小写的创作者目录**共用同一目录**（下载按文件级去重，不会覆盖已有内容）
- **同名文件后缀**：同帖内同名不同内容（不同 hash）的文件自动加后缀区分（如 `image-1_4535755.png`，后缀模板由 `PAWCHIVE_FILENAME_SUFFIX_FORMAT` 配置，`{size}`=文件大小，无大小退序号），防互相覆盖
- **缩略图回退**：原图 404（源站失效链接）时自动回退下载 `img.pawchive.pw/thumbnail/` 缩略图（文件名加 `_thumb` 标记，如 `image-1_thumb.webp`），原图恢复后重跑自动换回原图并清理旧缩略图
- **外链表格**：帖子级 html 正文里的外部链接（http/https，一般是网盘下载地址）自动统计成表格（# / 链接 / 域名）
- **网盘下载**：正文里的 Google Drive 链接自动下载（**provider 注册表可扩展**：mega/baidu 等加一个 provider 即可）——下载后记录进帖 html（文件列表 + 机读块），**内容 sha256 跨帖去重复用**（硬链接）；**正文里的网盘链接 a 标签本地化**（指向本地文件），外链表格保持原始 URL；**大文件病毒扫描确认页自动处理**（识别后带 confirm 重下）；**支持断点续传**（.tmp + Range 续传，确认页残留自动清理）
- **TPS 限速（反爬）**：默认每秒最多 1 个新连接（`PAWCHIVE_TPS`；file host 明示要求 ≤1 req/s，超速返回 376B 占位）
- **完整性校验**：下载完成比对落盘大小与响应头（Content-Range/Content-Length）；**376B=反爬占位、404 错误页均删除不落盘**
- **分页拉取**：每页 50 条（Pawchive 分页参数 `o`，stepping of 50 enforced；页间默认 1s 间隔防连发）
- **传输策略**：curl HTTP/1.1 + 浏览器 UA + `-f`（HTTP 错误不落盘）（File host 对 Node TLS 指纹与无 UA 的 Range 请求限速；带 UA 的 HTTP/1.1 实测 9.4MB/s）

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
| `PAWCHIVE_TEMP_SUFFIX` | `.tmp` | 断点续传临时文件后缀 |
| `PAWCHIVE_USER_AGENT` | Chrome 126 UA | 下载/探测请求 UA（file host 要求可识别 UA） |
| `PAWCHIVE_TPS` | `1` | 每秒新建连接上限（反爬要求 ≤1） |
| `PAWCHIVE_PAGE_INTERVAL_MS` | `1000` | 列表翻页间隔（防连发限流） |
| `PAWCHIVE_RETRY_TIMES` | `10` | 下载重试次数 |
| `PAWCHIVE_RETRY_INTERVAL_MS` | `3000` | 下载重试间隔 |
| `PAWCHIVE_POST_INTERVAL` | `5` | 帖间等待秒数（反爬限频） |
| `PAWCHIVE_SLOW_SPEED_KB` / `SLOW_DETECT_MS` / `SLOW_WAIT_MS` / `SLOW_MAX` | `50`/`10000`/`60000`/`3` | 慢速退避与反爬长等待参数 |
| `PAWCHIVE_DATA_ROOT` | 空 | 默认输出根目录（cli 参数 `path` 优先） |
| `PAWCHIVE_CURL` | 自动探测 | curl 可执行文件路径（Alpine/BusyBox/NAS 可显式指定） |
| `PAWCHIVE_LOG` | `./pawchive.log` | 日志文件路径 |

完整变量模板见 `env.example`。

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

- 项目定位 = **纯 CLI 下载器（不做前端）**：继续增强 CLI 能力（并发调度、反爬自适应限速、全量同步调度、更多平台适配）；上游 API 文档类产物由提取工具维护（见 `docs/` 留档）

## 版本记录

| 版本 | 日期 | 说明 |
|---|---|---|
| 1.0.0 | 2026-09-28 | 网盘下载集成（Google Drive provider 注册表可扩展、内容 sha256 跨帖去重复用、正文链接本地化）；缩略图回退；同名文件后缀；快速跳过与创作者 html 每帖刷新；worker 池式并发维持；HTTP 4xx/5xx 不重试；索引作者更新检测；全部环境变量化配置 |