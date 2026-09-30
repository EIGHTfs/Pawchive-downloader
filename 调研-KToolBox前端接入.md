# 调研：KToolBox 前端直接接我们后端（可行性）

> 日期：2026-09-28 ｜ 结论：**技术可行，但投入产出比低**——本质是「用 Node 复刻 KToolBox WebUI 后端 API 契约」（85 端点），不是「接上」而是「重写后端兼容层」。

## 一、契约面（前端有源码可读——webui/src；bundle 仅为构建产物，兼容层不改动它，后端按契约实现）

> 更正（2026-09-28）：前端**有完整源码**（webui/src——React TS 组件 + lib/api.ts API client + generated/openapi 契约），不是只有不可改的编译产物。契约对齐的依据 = **源码 + openapi.yaml**（响应结构权威），bundle（webui/static）只是构建产物，兼容层选择不改动它（方案 B 收窄接入），而非"不可改"。

来源：`tools/ktool-webui-routes.json`（tools/extract-ktool-apis.py 提取，85 端点）

| 分组 | 端点（示意） | 说明 |
|---|---|---|
| 认证会话 | `session/login` `logout` `session` | argon2 密码哈希 + session token |
| 配置系统 | `config/schema` `dotenv/*` `project` `example` | 前端设置页按 schema 渲染——需返回 KToolBox 兼容完整 schema |
| 创作者 | `creators` CRUD + `avatar/banner` | 创作者管理 |
| 下载任务 | `tasks` CRUD + `run/pause/stop/rerun/events/attempts` | 任务状态机 + 实时事件 |
| 计划 | `plans` CRUD + `run/pause` | 多创作者批量计划 |
| 命名系统 | `naming` `preview` `source/parse` `conversions/*` `legacy-migration/*` | KToolBox 专有命名引擎 |
| 事件流 | `events` `tasks/{id}/events` | SSE 实时进度 |
| 文件系统 | `files` `directories` `filesystem/*` | 文件浏览/操作 |
| 媒体 | `media/*` | 预览 |
| Pawchive 代理 | `pawchive/*` `posts/*` | 后端代理源站 |
| MCP | `mcp/tools` `tokens` `status` | AI 工具面 |
| 杂项 | `about` `health` `updates` `site-version` `openapi.yaml` + SPA 静态 `/{path:path}` | |

## 二、我们可映射的能力（cli.js）

| 我们的能力 | 映射端点 | 可用性 |
|---|---|---|
| `downloadAuthor`/`downloadOnePost` 下载引擎 | `tasks`/`plans` 执行 | ✅ |
| pawchive-index.html 双级索引 | `files`/`creators` 浏览、`posts` | ✅ |
| tracker 进度 | `events` SSE（需事件化封装） | ✅（改造） |
| `PAWCHIVE_*` 配置 | `config/*`（需翻译为 KToolBox schema 结构） | ⚠️ |
| Pawchive API 直连 | `pawchive/*` 代理 | ✅ |
| — | `session` 认证、`naming` 引擎、`mcp` | ❌ 无对应 |

## 三、难点（按影响排序）

1. **契约精确对齐**：前端源码可读（webui/src/api.ts 类型 + openapi.yaml 契约声明）——响应 JSON 字段名/嵌套/枚举必须与前端期望完全一致——任何偏差 = 前端页面挂掉；需逐端点对齐（可从 `openapi.yaml` 提取契约自动生成，仍有语义核对）
2. **命名系统（8 端点）**：preview/source/parse/conversions/legacy-migration 是 KToolBox 专有引擎——我们无对应 → 命名/设置页不可用（或降级空响应）
3. **认证与安全**：argon2 密码 + session token 管理（前端登录页期望）
4. **SSE 事件**：我们的 tracker 是 TTY 行——需事件化推送（下载/任务状态实时流）
5. **任务调度语义**：tasks/plans 生命周期状态机（pending/running/paused/stopped + attempts/events）

## 四、方案与工作量

| 方案 | 说明 | 工作量 | 适合 |
|---|---|---|---|
| A. 完整复刻 | Node 实现 85 端点契约（含 naming/mcp/config schema 翻译） | 大（数千行 / 数天 / 契约对齐调试重） | 坚持完整 KToolBox 体验 |
| B. 收窄接入 | 只实现核心下载流（auth 简化 + creators + tasks + events + files 浏览 + SPA 静态）；naming/config 编辑页降级 | 中（约千行，可落地） | 复用 KToolBox UI 看下载/浏览 |
| C. 自研极简前端 | 不接 KToolBox 前端——极简 HTML+JS 调我们自定义 Node API | 小（几百行） | 少写前端、契约自定 |

## 五、范围决策（2026-09-28 用户确认，方案 B 收窄）

- **认证删除**：`session/login` `logout` `session` 不实现（无登录，前端无认证页可用）
- **MCP 删除**：`mcp/*` 全部不实现
- **naming 简化**：naming = 重命名模板——`naming` GET/PATCH 映射 `PAWCHIVE_CREATOR_DIR_FORMAT/POST_DIR_FORMAT/FILENAME_FORMAT`；`preview` 简化；`conversions`/`legacy-migration` 不做
- **config schema 简化**：`config/schema` 返回最小化 schema（仅命名模板/并发/下载开关等我们支持的键），设置页只显示可用项
- **保留核心下载流**：creators（浏览/管理）→ tasks/plans（创建/控制/进度）→ events（SSE）→ files/directories/media（浏览预览）→ pawchive/posts（代理）→ SPA 静态

## 六、推荐

- 目标「复用 KToolBox 现成 UI 看下载/浏览」→ **方案 B**（收窄接入，核心下载流页面可用）
- 目标「少写前端」→ **方案 C** 更划算（自研极简，无契约对齐成本）
- **方案 A 不推荐**：复刻 85 端点契约 ≈ 用 Node 重写 KToolBox 后端，投入产出比低

## 七、附注：原作者版 vs 用户 PR 版前端（契约差异确认）

- 本项目参考的 KToolBox 源码 = 用户 fork（EIGHTfs/KToolBox）的 `fix/downloader-robustness` 分支（PR 分支）
- 该 PR 改动 12 个文件**全部在 Python 后端**（downloader/cli/api/configuration/tests + webui config_locale/config_schema）——**未触碰 `webui/static` 前端 bundle**
- 结论：**原作者版与用户 PR 版的前端 API 契约完全相同**（前端未重建）——兼容层按 bundle 契约实现即可，两版无区别

（注：此前项目决策为「不做前端、只保留 cli」——本调研供参考；若选择接入/自研，按功能流程先写 README 待办再实现。）
