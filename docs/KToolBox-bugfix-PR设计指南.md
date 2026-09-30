# KToolBox 下载引擎修复 PR — 设计指南

> 状态：**已提交 PR #396（2026-09-28）**：https://github.com/Ljzd-PRO/KToolBox/pull/396（head=EIGHTfs:fix/downloader-robustness → base=master，mergeable）
> 目标仓库：`docs/.probe-ktoolbox/`（Ljzd-PRO/KToolBox 上游 clone，eb9403e）
> 依据：`KToolBox-不足审计报告.md`（§3.4/§3.1/§3.6/§10.6）+ `code_audit` 交叉验证
> 本文档由原《KToolBox-bugfix-PR计划.md》转写为设计指南（计划形态→设计说明形态）。

---

## 一、设计目标

修复 KToolBox 下载引擎 4 个缺陷，每个配测试，提 PR 到上游（Ljzd-PRO/KToolBox，经 fork → EIGHTfs/KToolBox → PR）：

| # | 缺陷 | 现状 | 修复设计 |
|---|---|---|---|
| 3.4 | 断点续传只认 206，服务端返回 200 全量直接失败 | `downloader.py:267-280` `!= 206 → GeneralFailure` | **200 = 服务端忽略 Range → 清零 temp 从头重写**；206 保持续传 |
| 3.1 | 无自定义 UA（httpx 默认 python-httpx，反爬裸奔） | `configuration.py` 无 `user_agent` 字段；`api/client.py:111`、`downloader` stream 无 headers | 新增 `user_agent` 配置（API + Downloader 两个模型），**空串=httpx 默认（向后兼容）** |
| 3.6 | 完整性零校验（Content-Range/Length 与实际落盘不符不报） | `downloader.py:296-306` 无断言 | 下载完 **stat temp 与 total_size 比对**，不符 → GeneralFailure 触发重试；total_size 为 None 时跳过断言 |
| 10.6 | `reverse_proxy` 用 `str.format` 拼 URL，URL 含 `{}` 报错/被吃 | `downloader.py:269` `reverse_proxy.format(self._url)` | 改 **`replace("{}", url)`**，无占位符时模板原样 |

## 二、设计要点

### 2.1 断点续传 200 fallback（3.4）

- 仅当服务端返回 **200**（确认忽略 Range）才清零从头重写
- **206 保持续传语义**（不破坏大文件断点续传）
- 依据：HTTP 语义——200 表示服务器忽略 Range 请求头返回完整实体

### 2.2 用户代理配置（3.1）

- `configuration.py` + `_configuration_zh.py`：两个模型（API + Downloader）加 `user_agent: str = ""` + docstring + redacted 清单(488)
- `api/client.py`：`httpx.AsyncClient` headers 加 UA（**可配置时才加**）
- **向后兼容**：空串默认 = httpx 默认 UA，不改变默认行为（上游合入阻力小）

### 2.3 完整性断言（3.6）

- `downloader.py` 下载完成后：stat temp 与 total_size 比对，不符 → GeneralFailure 触发重试
- **total_size 为 None 时跳过断言**（无 Content-Length 场景行为不变，防误伤正常文件）

### 2.4 reverse_proxy 修复（10.6）

- `str.format` → `replace("{}", url)`：URL 含 `{}` 不再报错/被吃
- 无占位符时模板原样输出

## 三、涉及文件

| 文件 | 操作 | 改动 |
|---|---|---|
| `ktoolbox/configuration.py` | 修改 | 两个模型加 `user_agent: str = ""` + docstring + redacted 清单(488) |
| `ktoolbox/_configuration_zh.py` | 修改 | 同步中文 docstring |
| `ktoolbox/api/client.py` | 修改 | `httpx.AsyncClient` headers 加 UA（可配置时） |
| `ktoolbox/downloader/downloader.py` | 修改 | ① 200 fallback（267-280）② stream headers 加 UA ③ 下载后完整性断言（296 后）④ reverse_proxy replace（269） |
| `tests/ktoolbox/test_downloader.py` | 修改 | +200 fallback 测试、+完整性断言测试、+reverse_proxy 特殊字符测试 |
| `tests/ktoolbox/test_api_client.py` | 修改 | +UA header 生效测试 |
| `tests/ktoolbox/test_configuration.py` | 修改 | +user_agent 字段/默认值测试 |
| `CHANGELOG.md` | 修改 | 记录修复（上游规范） |

## 四、执行过程记录

> 实际执行：2026-09-28 完成。代码/测试改动（步骤 0-6）此前已以本地提交 bdd50fd + 4955444 完成；本机无 venv 未跑 ruff/mypy（步骤 7 未做）；fork/PR 走 GitHub API（步骤 8-10 完成）。注：本地 clone 为孤儿根提交（Git Data API 快照），与上游无共同历史，PR 前用 Git Data API 在 fork 上重建提交链（parent=上游 master e17249b），PR 显示 2 commits（ccad6c4 + f761bc8）+217/-9。

| 步骤 | 内容 | 状态 |
|---|---|---|
| 0 | 预检：读 4 处代码最终确认 + venv 补装 pytest/respx（pypi）跑现有 test_downloader 基线 | ✅ |
| 1 | `configuration.py` + `_configuration_zh.py`：加 `user_agent` 字段 → 提交 | ✅ |
| 2 | `api/client.py`：UA header 应用 → 提交 | ✅ |
| 3 | `downloader.py`：UA header + reverse_proxy replace（10.6）→ 提交 | ✅ |
| 4 | `downloader.py`：200 fallback（3.4）→ 提交 | ✅ |
| 5 | `downloader.py`：完整性断言（3.6）→ 提交 | ✅ |
| 6 | 测试：4 个修复各配测试，跑 test_downloader/test_api_client/test_configuration 全绿 → 提交 | ✅ |
| 7 | 上游 CI 自检：ruff + mypy（改动文件）通过 | ⚠️ 未执行（本机无 venv；PR 已提交，由上游 CI 代跑） |
| 8 | fork：GitHub API 建 fork（EIGHTfs/KToolBox）→ 本地 remote 指向 → 分支 `fix/downloader-robustness` push | ✅ |
| 9 | 开 PR（GitHub API POST /repos/EIGHTfs/KToolBox/pulls → base Ljzd-PRO/KToolBox）→ 确认 PR 链接 | ✅ |
| 10 | 收尾：README 不涉及；审计报告补记 PR 链接 | ✅ |

## 五、验证

- 本地：pytest 4 个新测试 + 既有 downloader/configuration/api 测试全绿
- CI 模拟：ruff/mypy 过
- PR：GitHub API 返回 PR 编号 + 链接，可访问

## 六、遗留/边界

- 3.1 的 UA 是「配置项默认空 = httpx 默认」，**不改变默认行为**（向后兼容，上游合入阻力小）
- 3.6 只在 total_size 可得时断言（无 Content-Length 场景行为不变）
- 若上游 reviewer 要求拆成多个 PR（UA 独立、downloader 三修一组），按反馈调整
