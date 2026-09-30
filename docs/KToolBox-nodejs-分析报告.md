# KToolBox 转 Node.js 项目——分析报告

> 2026-09-30 只读分析（未改任何代码）。来源：github.com/Ljzd-PRO/KToolBox（master @ e17249be，474 文件，clone 至 .probe-ktoolbox/）

## 一、项目概况

KToolBox 是一个 **Pawchive 站（pawchive.pw）公开作品下载器**：WebUI + CLI + Python 客户端三合一。作者 Ljzd-PRO，Python 3.10–3.14，MIT 协议。

- 功能：创作者下载/同步、任务计划（cron）、命名模板、过滤/屏蔽、断点续传、重试、TPS 限速、本地存储桶（bucket）复用、查重跳过
- WebUI：React + TypeScript（webui/src/App.tsx 等），Playwright e2e；含内置 MCP 服务
- v1 新版本；Kemono 已不可用，默认走 Pawchive 镜像

## 二、核心架构与下载链路（实测）

```
PawchiveClient (Python httpx) → https://pawchive.pw/api/v1
  ├─ list_creators / list_recent_posts / get_creator_profile / list_creator_posts / get_post / search_file_by_hash ...
  └─ Post 模型: file + attachments (FileReference 数组) → 文件 URL

Downloader (httpx stream) → file.pawchive.pw/data/... 
  ├─ Range: bytes={temp_size}- → 断点续传（.tmp 后缀）
  ├─ tenacity 重试（retry_times/retry_interval）
  ├─ TPS 限速（asyncio.sleep(1/tps_limit)）
  ├─ 查重（本地文件 + bucket 复用）
  └─ 进度观察者（DownloadProgressObserver）
```

**网络实测（2026-09-30）**：
- `GET https://pawchive.pw/api/v1/creators?service=fantia` → **HTTP 200 JSON**（创作者列表直接返回，**免 CF 免登录**）
- 下载文件在 `file.pawchive.pw/data/...`（DownloaderConfiguration: files_netloc + file_path_prefix）

**结论：转 Node.js 无网络阻碍**——API 直连 JSON、下载是标准 HTTP 流，与 gbmd/iwara 同模式。

## 三、转 Node.js 方案

### 范围建议（最小可用优先）

| 范围 | 内容 | 工作量 |
|------|------|--------|
| **A. 核心下载器（本次建议）** | Pawchive API client + 下载器 + CLI/HTTP 入口 | 中 |
| B. 进阶 | 命名模板/过滤/屏蔽/任务计划/自动同步 | 中-大 |
| C. WebUI 挂载 | 前端 React 已现成，后端补 API 契约 | 中 |

### 架构（Node.js，零依赖风格）

```
lib/
  pawchive-api.js     # Pawchive API client（fetch 封装，与 gbmd gb-api.js 同构）
    - listCreators / listRecentPosts / getCreatorProfile / listCreatorPosts / getPost
  downloader.js       # 流式下载器（fetch body 流）
    - Range 断点续传（.tmp）、重试（指数/固定）、TPS 限速、查重跳过、进度回调
  config.js           # ktoolbox.toml 等效配置（API base/files netloc/retry/tps/bucket）
server/
  index.js            # HTTP 入口（下载任务提交/状态查询）
cli.js                # CLI（单作品下载 / 创作者同步）
```

### 关键技术点（转写对应）

| Python 原实现 | Node.js 对应 |
|---------------|--------------|
| httpx.AsyncClient.stream | fetch + ReadableStream / undici |
| tenacity.AsyncRetrying | 手写重试循环（retry_times/interval + HTTPError 判定） |
| aiofiles stat + Range 断点 | fs.stat + Range 头 + append 流 |
| TPS 限速（asyncio.sleep） | setTimeout 节流 |
| pydantic BaseModel | 手写校验/映射（或轻依赖） |
| pathvalidate 命名清理 | 手写（非法字符替换，同 gbmd 做法） |

### 涉及文件（新项目结构，非修改原仓库）

| 文件 | 功能 | 依赖 |
|------|------|------|
| `lib/pawchive-api.js` | API client | 无（node fetch） |
| `lib/downloader.js` | 流式下载器 | pawchive-api |
| `lib/config.js` | 配置加载（JSON/env） | 无 |
| `server/index.js` | HTTP 接口 | downloader |
| `cli.js` | CLI 入口 | downloader |
| `README.md` | 使用文档 | - |

## 四、潜在问题分析

| 风险 | 可能性 | 影响 | 缓解 |
|------|--------|------|------|
| Pawchive API 字段漂移 | 中 | 解析失败 | 最小字段映射 + 运行时实测 |
| 大文件断点续传损坏 | 低 | 文件损坏 | .tmp + 完成后改名 + 查重校验 |
| 并发下载资源竞争 | 中 | 文件冲突 | 每下载一个临时名，完成后改名 |
| 反爬限制（后续） | 低 | 下载失败 | 重试 + TPS 限速内置 |

边界：空作品列表/空 attachments → 跳过；API 超时 → 重试兜底；同一文件并发 → 锁/查重。

## 五、任务看板（确认后执行，从简到难）

- [ ] step 1: 项目骨架（目录 + git init + README 草稿）
- [ ] step 2: `lib/pawchive-api.js`（creators/posts/getPost，实测）
- [ ] step 3: `lib/downloader.js`（流式 + Range 断点 + 重试 + TPS）
- [ ] step 4: `cli.js`（单作品下载）
- [ ] step 5: `server/index.js`（HTTP 提交/状态）
- [ ] step 6: 验证（真实下载 1 个作品）+ README 完善
- [ ] step 7: 提交推送（仓库私有，推 EIGHTfs 或用户指定）

## 六、验证方案

- API client：真实调 creators/posts 输出 JSON 结构
- 下载器：真实下载 Pawchive 公开作品 1 个，验证落盘 + 断点（中断再续）+ 查重跳过
- CLI/HTTP：提交下载 → 状态轮询 → 文件存在

## 七、待确认

1. **范围**：A（核心下载器）还是含 B/C？
2. **落地位置**：新项目目录名（如 `ktoolbox-nodejs`）？放当前工作区还是工作区根？
3. **推送**：仓库可见性/归属（private EIGHTfs 同名？）

确认后按看板执行；未确认不改代码。
