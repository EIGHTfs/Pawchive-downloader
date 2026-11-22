# MEGA 中转 Worker（部署物料）

## 来源与许可

- 来源项目：https://github.com/developeranaz/MEGA-INDEX-CLOUDFLARE（作者 developeranaz）
- 取用文件：`worker.js`（仓库 main 分支，2026-11-22 拉取，56686 字节）
- 许可：原仓库 README 仅声明「Provided as-is for personal use. Respect the terms of service of MEGA and the rights of file owners.」，**未给出明确开源许可证**，因此仅作个人自用部署，不随本项目再分发。

## 它做什么

把 MEGA 公开分享链接的读取与解密搬到 Cloudflare 边缘执行，客户端只需访问 Worker：

- Worker 内部调用 `https://g.api.mega.co.nz/cs` 拿加密下载地址
- 自己实现 AES-CTR 解密（含 `getCtrIv`、分块解密、`FixedLengthStream`）
- 对外返回解密后的原始字节，并支持 `Range`（206），可断点续传/多线程

## 对外路由

| 路由 | 作用 |
|---|---|
| `/` | 落地页（粘贴 mega 链接） |
| `/pf/<HANDLE>/<KEY>` | 单文件索引页（文件名 + 大小） |
| `/pf/<HANDLE>/<KEY>/download` | **单文件真实字节下载**（本项目网盘 provider 使用此路由） |
| `/p/<HANDLE>/<KEY>` | 文件夹索引页 |
| `/p/<HANDLE>/<KEY>/download/<HASH>` | 文件夹内某文件下载 |

`<HANDLE>` 与 `<KEY>` 来自 MEGA 分享链接：`https://mega.nz/file/<HANDLE>#<KEY>`。

## 部署

用同项目的 `tools/cloudflare-worker-deploy.js`（零依赖直调 Cloudflare API）：

```
CF_API_TOKEN=<token> node tools/cloudflare-worker-deploy.js tools/mega-worker/worker.js mega-index --domain mega.example.com
```

前置条件：域名 NS 已托管到 Cloudflare 且 zone 状态为 active（否则自定义域名无法绑定；`workers.dev` 默认域名在本网络被 SNI 阻断，不能直接用）。

## 网络限制（实测）

- `workers.dev`：DNS 污染 + SNI 阻断，`--resolve` 到 Cloudflare 真实 IP 仍返回 000 —— 必须用自定义域名访问
- `api.cloudflare.com`：可达，部署侧无障碍
