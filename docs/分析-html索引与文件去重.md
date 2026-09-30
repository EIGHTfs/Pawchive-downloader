# Pawchive 下载器扩展分析：html 索引 + 文件去重

> 2026-10-01 讨论产物（只分析，未写代码）。基于 cli.js 现状（178 帖 / 711 文件计划，索引断点续拉、curl 传输、查重跳过已验证）。
> 关联：gbmd（gamebanana-mods-downloader）description.html 索引机制、KToolBox bucket 存储复用。

---

## 一、背景

cli.js 已完成最小下载链路，用户提出两项扩展需求：

1. **学 gbmd 建立 html 充当索引**：下载内容用 html 做索引（人可浏览 + 机器可解析），下载时用**真实文件名**、不对文件名重命名。
2. **同作者不同渠道文件重复怎么解决**：创作者在多个平台（patreon/fanbox/fantia…）发相同内容，或同帖 file 与附件同文件，下载会重复拉取同一文件。

---

## 二、html 索引方案（gbmd 模式）

### 2.1 gbmd 机制（已读源码）

每个 mod 目录写 `description.html`，**双结构**：

```
description.html
├─ 人类可读：标题 / meta（作者·游戏·版本·时间·原链接·下载路径）/ 文件列表表格（文件名·大小·MD5·状态）/ 图片墙 / 描述
└─ 机器可读：<script id="gbmd-index" type="application/json">{schema:1, ...}</script>
              ↑ 重跑/扫描时 parseIndexObj() 读回 JSON，不重爬 API
```

`description.html` 存在 = 该 mod 已处理；配合 incomplete-scan 识别缺失文件补下。

### 2.2 本项目映射（已确认 4 项决策）

| # | 决策点 | 结论 |
|---|--------|------|
| 1 | 索引粒度 | 帖子级 `pawchive-index.html` + **创作者级总览** `pawchive-index.html` |
| 2 | 命名 | 用 `pawchive-index.html`（**不覆盖** KToolBox 旧 `index.html` 正文裸 HTML） |
| 3 | 与 .pawchive json 关系 | **并存**：`.pawchive/<service>-<id>.index.json` 管拉取进度/游标/断点续拉；html 管每帖下载结果索引 |
| 4 | 文件名 | **真实原名落盘**（`file.name` / `attachments.name` / path 末段）；`filename_format` 保留配置但默认不启用 |

### 2.3 数据结构

**帖子级**（`<creatorDir>/<postDir>/pawchive-index.html`）：

- 人读：标题、meta（平台/创作者/发布时间/原链接/本地目录）、文件列表表（文件名/大小/状态：已下载|缺失）、**正文内容**（get_post 拉全量 `content` 嵌入，人读完整）
- 机读 JSON 块（**同时承担去重登记**：files 数组含 serverPath/hash，全局去重索引由此聚合，不另建 json）：
```json
{
  "schema": 1, "type": "post", "service": "patreon", "userId": "96944064", "postId": "...",
  "title": "...", "creatorName": "RenKamui", "url": "https://pawchive.pw/patreon/user/96944064/post/...",
  "published": "...", "postDir": "...",
  "files": [{ "filename": "...", "size": 123, "exists": true, "serverPath": "/25/b5/<sha256>.png" }]
}
```

**创作者级**（`<creatorDir>/pawchive-index.html`）：

- 人读：创作者名、meta（平台/ID/帖子数/本地目录）、帖子导航表（标题链接 / 发布时间 / 文件数 / 已下载数）
- 机读 JSON 块：schema + posts 精简列表（postId/title/published/relDir/fileCount/downloaded）

### 2.4 生成时机

- 真实下载过程中/结束后：逐帖写帖子级 html（含正文：content 不足时 get_post 拉全量；文件大小 stat 实测）+ 写创作者级总览
- **去重登记随 html 落盘**：每帖 html 的 JSON 块即该帖文件的去重登记，全局 hash 索引 = 扫描目标树 `**/pawchive-index.html` 聚合（读 JSON 块，文件小、成本低）
- dryrun 不写盘
- 重跑逻辑（后续）：帖子 html 存在 = 已处理标记；可扩展「读 html 补缺」（对齐 gbmd readIndexObj / incomplete-scan）

---

## 三、同作者不同渠道文件重复问题

### 3.1 问题场景（已实测/已见）

| 场景 | 说明 | 现状 |
|------|------|------|
| 同帖 file 与附件同文件 | 如 [Genshin] Lumine 帖：file 与 attachments 指向**同一 hash 路径** `39f95ad...png` | cli.js 计划中已见：同一 URL 被计划 2 次，下载 2 份 |
| 跨帖共享 | Pawchive 有 `shared_file` 字段，但实测最近 5 帖全 false，**字段不可靠** | — |
| 同作者跨渠道 | 同创作者在不同 service 有不同 id 账号（实测：RenKamui 在 patreon id=96944064 178 帖 + fanbox id=107514250 58 帖），发相同主题内容 | 靠目录合并 + 已存在检查 |

### 3.2 去重硬判据

Pawchive 文件路径是 **SHA-256 内容寻址**：`/<2位>/<3位>/<64位hash>.<ext>``（如 `/25/b5/25b52502...png`）。

> **同文件 ⇒ 同 server_path（hash 路径），这是唯一且最强的判据**。比文件名/大小更可靠（同名可不同内容、同内容可不同名），比 `shared_file` 字段准确（实测字段不可靠）。

### 3.2a 网站自身的去重机制（2026-10-01 实测）

**网站有去重，且就是 hash 内容寻址去重**：

1. **存储层**：文件按 SHA-256 全站存唯一一份（hash 分段路径即内容指纹），帖子的 `file`/`attachments` 只是**引用**同一路径 → 同一文件多帖共享时物理只存一份（`shared_file` 字段标记共享）。
2. **API 层**：`GET /search_hash/{hash}` 返回该文件全部引用帖（跨帖共享时 `posts` 为多个；实测单帖引用时 1 个）。
3. **对下载器的意义**：本地「同 hash 只下一份 + 硬链接复用」= 把网站的一份存储多帖引用语义搬到本地，方向一致。

### 3.2b 实测案例：RenKamui 双渠道（2026-10-01 实测）

patreon `96944064`（178 帖）与 fanbox `107514250`（58 帖）是**同一创作者两个渠道**，内容高度重叠（同名 mod 帖），但文件**hash 各不相同**：

| 帖子（同名） | patreon 文件 | fanbox 文件 | 结论 |
|---|---|---|---|
| [Genshin] Lumine — Eye of Graeae | `LumineEyeP.png` `39f95ad...png`（file=附件同 hash） | `cover.jpeg` `2713c5...jpeg` + **`LumineEyeofGraeaeNudeModRenKamui.zip`** `ac0f0e...zip`（mod 本体） | 同标题帖，hash 全不同，各有价值，**不能按标题/文件名去重** |
| 各渠道文件扩展名 | 多为 .png | 多为 .jpeg（48/50 帖）+ zip mod 包 | — |

要点：
1. **目录合并后同标题帖并存**：creator 目录同名（纯名模板）→ 两渠道帖进同一创作者目录；同标题帖目录（{title}）冲突 → 但文件 hash 不同、文件名不冲突（png/jpeg/zip）→ 不误删、全保留 ✅
2. **hash 判据安全**：不会把「渠道 A 的 png」误判成「渠道 B 的同名 jpeg」而跳过；只有**真同 hash**（如 patreon 帖 file 与附件同 hash、日后某文件跨帖共享）才去重/硬链接 ✅
3. **zip 是本体**：fanbox 渠道含 mod zip 完整包，patreon 只有预览图——双渠道全下才有价值，印证「不同 hash 全保留」策略正确。

### 3.2c 实测案例：标题/文件名全不同而内容相同（2026-10-01 实测）

用户场景「作者不同平台、名字/帖子名/文件名都不一样但内容相同」——实测 RenKamui 双平台全集 hash 求交（fanbox 117 唯一 hash + patreon 567 唯一 hash），**交集 2 个文件**：

| 文件（hash） | fanbox 引用 | patreon 引用 | 文件名是否相同 |
|---|---|---|---|
| `089053c5...png` | [ZZZ] Yixuan 帖 `VJdICJVIdJcRmixVkLgbASwo.png` | [ZZZ] Yixuan 帖 `yixuanP.png` | ❌ 完全不同 |
| `4355f02f...png` | [Genshin] Escoffier 帖 `d4eBYsbSBNpGipmwwtTWPw7p.png` | [Genshin] Escoffier 帖 `bikini.png` | ❌ 完全不同 |

结论：**「名称层级」（作者名/帖子名/文件名）全部失效时，hash 是唯一不变的判据**。文件名判重必然漏（`VJdICJ...png` vs `yixuanP.png` 不同名各下一份）；hash 判重精确命中（只下 1 份 + 硬链接）。
配套：`GET /search_hash/{hash}` 可反查同文件全站引用（上面即用它确认），可作为 html 标注「该文件同时出现在 X 渠道」的可选增强。

### 3.3 方案对比

| 方案 | 做法 | 优点 | 缺点 |
|------|------|------|------|
| **A. hash 去重表 + 硬链接复用**（推荐） | 下载前查 hash 表（`server_path → 首个落盘位置`）；命中 → `fs.link` 硬链接到本位置（同卷秒级、共享 inode 不占双倍空间），硬链接失败回退复制；未命中 → 正常下载并登记 | 省带宽（同文件只下 1 次）+ 省磁盘（硬链接同 inode）+ 跨帖/跨渠道/跨会话持久生效 | 需维护持久表（由 html 承载，见下）；硬链接同卷限制（本机 /volume1 同卷满足） |
| B. 目录级已存在检查（现状） | 目标文件非空即跳过 | 无需新机制 | 只按文件名判重（改名即失去关联）；重复文件在「不同位置」仍会各下 1 份 |
| C. 跨渠道目录合并 | creator 目录用 `{creator_name}` 纯名模板 → 同作者多渠道(同名)下载进同一目录，文件重名天然被「已存在」跳过 | 已生效（现有 102 个已存在即此效果） | 依赖「跨渠道同名」；不同名（多渠道别名）则失效 |
| **D. links 官方跨渠道关联**（新增，2026-10-01 实测） | 调 `GET /{service}/user/{id}/links` 拿同作者全部渠道账号（id/service/name 数组），作为**账号身份层**：跨渠道识别 → 统一目录/提示一并下载 | 官方权威数据、**跨不同名渠道也有效**；实测双向（fanbox→patreon 96944064 / patreon→fanbox 107514250） | 返回空=无关联；本质是补充 C，仍需 hash 去重做文件层 |

### 3.4 推荐方案：A + C + D 互补（去重登记由 html 承载）

```
下载流程（downloadFile 前置）：
  1. 算 job.serverPath（hash 路径）
  2. 查 hash 索引（扫描已有 pawchive-index.html 的 JSON 块聚合 + 内存缓存，无独立去重 json）
     ├─ 命中 → fs.link(源位置, 本位置)（失败回退 copyFile）→ 状态=linked，0 下载
     └─ 未命中 → 查 in-flight（见 3.6）→ curl 下载 → 落盘 → 该帖 html JSON 块登记（含 hash）
  3. 目录合并（C）+ links 关联（D）兜底：多渠道同目录/同作者识别；hash 去重跨渠共享
```

- **去重登记**：随每帖 `pawchive-index.html` 落盘（files 含 serverPath/hash）；全局索引 = 扫描 html 聚合（文件小、成本低）
- **跨会话持久**：下次运行任何 URL/索引模式重建 hash 索引 → 重跑/多渠道不重复下载
- **硬链接语义**：只读下载场景安全（改一个 inode 影响所有链接点；不会发生）；删除一个链接点不影响其他

### 3.5 边界与风险

| 风险 | 缓解 |
|------|------|
| 硬链接跨卷失败（EXDEV） | 回退 `copyFile`（功能正确，空间双倍） |
| 表过期（文件被删，表仍指向） | 链接前 stat 校验源存在，缺失则重新下载并更新表 |
| 同名不同内容（hash 不同但文件名相同） | hash 判据天然区分；文件名冲突靠目录结构隔离（不同帖不同目录） |
| 表损坏/解析失败 | 损坏即重建（同 loadIndex / parseIndexObj 容错） |

**硬链接迁移语义（2026-10-01 实测定案：默认硬链接，迁移不用管）**：

- 实测（本机）：同卷 `mv` 硬链接文件 **inode/nlink 不变**（rename 保留硬链接，不解开）
- 跨设备 `mv` / 复制工具（cp -r、rsync 不带 -H）：硬链接被解开成普通拷贝——**数据永远完整无损**，仅重复文件恢复各自占用空间（本项目重复文件量极小：RenKamui 全集仅 2 个 hash 重复）
- 本项目目标目录为 **NFS 挂载**（实测 `10.10.10.64:/volume10/Resource/(Pawchive)`）：同挂载点内硬链接由服务端支持（fs.link 成功）；服务端 FS 不支持时 fs.link 抛错 → **自动回退 copyFile**（设计内兜底）
- 结论：默认 `fs.link` 硬链接；README 迁移一句即可（整目录 mv 保留；跨设备建议 rsync -H）

### 3.6 并发竞态防护（2026-10-01 讨论定案）

并发 N 下载时，两个 job 同 hash（不同 savePath）同时查表未命中 → 会重复下载一次（不损坏，只浪费带宽）。防护 = **内存 in-flight 锁**（Map<hash, Promise>）：

```
① 查 hash 索引表（扫描 pawchive-index.html 聚合 + 内存缓存）
   ├─ 命中 → stat 源 ✓ → fs.link / 回退 copyFile
   └─ 未命中 ↓
② 查 in-flight 表
   ├─ 有（他 job 正在下同文件）→ await → 回 ①（此刻必命中）→ 硬链接
   └─ 无 → 登记本 job Promise → 下载 → 登记 hash 表 → 删 in-flight
```

- 并发=1 时 in-flight 空转零开销；并发>1 保证同 hash 只下一次
- 极端时序漏网至多重复下载 1 次（内容相同无副作用），与「目标已存在兜底检查」三重叠加

---

## 四、实施步骤（2026-10-01 已全部实现并验证）

- [x] 1. cli.js 加 html 生成函数（esc/fmtDate/buildPostIndexHtml/buildCreatorIndexHtml/buildIndexJsonBlock/parseIndexObj）
- [x] 2. planPostFiles 文件名改真实原名（applyFilenameFormat 不再调用，配置保留）
- [x] 3. 下载前 hash 去重：hash 索引 = 扫描目标树 `**/pawchive-index.html` 聚合（html 所在目录即帖子目录，不依赖绝对路径）；命中 → `fs.link` 硬链接（失败回退 copyFile，NFS 兜底）；in-flight 锁防并发竞态
- [x] 4. 真实下载：每帖写 pawchive-index.html（含 get_post 正文 + 相对路径 postDir）+ 创作者级总览（dryrun 不写）
- [x] 5. links 账号关联：buildPlan 时调 `/links`，打印「关联渠道」+ 写入创作者级 html JSON 块
- [x] 6. 验证：小样本真实下载（html 生成 + .tmp 断点续传 + 大小写冲突 (平台) 前缀 + 三号作者 dryrun + 跨文件夹 hash 交集 6 个）
- [x] 7. README 更新（html 索引 / hash 去重 / links / 断点续传 / 传输策略（curl HTTP/1.1+UA）/ 未来规划）

> 额外修复：File host 对 Node TLS 指纹与无 UA 的 Range 请求限速 → 下载层改 curl HTTP/1.1 + 浏览器 UA（实测 9.4MB/s）；断点续传恢复可用（带 UA 后续传正常）。

## 五、待确认决策点（已确认汇总）

1. ✅ 去重登记：**不单独 json，由 pawchive-index.html 承载**（hash 索引扫描 html JSON 块聚合）
2. ✅ 帖子级 html **含正文内容**（get_post 拉全量 content 嵌入）
3. ✅ links 关联账号：**展示 + 记录**（打印关联渠道 + 入创作者 html，不自动合并下载）
4. ✅ 去重表位置/跨渠道合并约定：html 承载去重后无独立 json；目录合并靠纯名模板 + links 展示（不代码强制）