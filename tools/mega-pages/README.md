# MEGA 中转站（Cloudflare Pages 部署）

## 为什么需要中转

部分网络对 `mega.nz` 只做 **TLS SNI 阻断**（ClientHello 里带该关键词就 RST），IP 层与 TCP 都是通的，MEGA 服务端也不校验 SNI。所以：

| 方式 | 实测 | 说明 |
|---|---|---|
| 域名访问 MEGA | 连不上 | SNI 被 RST |
| hosts / `--resolve` 指向真实 IP | 仍连不上 | SNI 仍是域名，照样 RST |
| IP + `Host` 头（SNI 用 IP） | 能连，但**约 10 KB/s** | 4 并发约 40 KB/s，1GB 要 28 小时，不可用 |
| **Cloudflare Pages 中转** | **约 120–470 KB/s** | Worker 在 Cloudflare 边缘取文件并解密，客户端只需访问 Pages |

结论：大文件必须走中转；同时 MEGA 免费配额按 IP 计（约 5GB / 6 小时），中转顺带避开了家宽 IP 被限的问题。

## 为什么用 Pages 而不是 Workers

- `workers.dev`：DNS 污染 + SNI 阻断，`--resolve` 到真实 IP 也返回 000
- `pages.dev`：可达（301），且 **Pages Functions 与 Workers 是同一 runtime**

另一个坑：`* pages.dev` 子域在 **HTTP/2 下会失败（000）**，**HTTP/1.1 正常**。所以客户端必须强制 HTTP/1.1（本项目 `streamOnce` 的 curl 已固定 `--http1.1`）。

## 目录结构

```
tools/mega-worker/
└── worker.js           # 上游 Worker 源码（唯一来源，Module 语法 export default { fetch }）

tools/mega-pages/
├── _routes.json        # 上传目录里的路由声明（让所有路径都进 Worker）
└── README.md           # 本文件
```

上传目录在部署时临时组装：把 `tools/mega-worker/worker.js` 复制成上传目录里的 `_worker.js`，再把 `_routes.json` 一并拷入（见下）。仓库里不保留第二份 worker 副本，避免同一份代码出现多个真相。

## 部署步骤（Direct Upload，推荐）

官方文档明确：**高级模式（`_worker.js`）在 Direct Upload 下不生效，必须由 wrangler 或 Git 集成上传**。本项目用 wrangler：

```bash
# 1) 准备上传目录（含 _worker.js + _routes.json；wrangler 会把 _worker.js 编译成 Worker bundle）
mkdir -p /path/mega-pages-upload
cp tools/mega-worker/worker.js /path/mega-pages-upload/_worker.js
printf '{ "version": 1, "include": ["/*"], "exclude": [] }\n' > /path/mega-pages-upload/_routes.json

# 2) 部署（token 见下；注意必须放在可执行卷上，/tmp 是 noexec，esbuild 起不来）
CLOUDFLARE_API_TOKEN=xxx CLOUDFLARE_ACCOUNT_ID=yyy CI=true \
  npx wrangler pages deploy /path/mega-pages-upload --project-name=mega-index --branch=main
```

成功标志：日志出现 `Compiled Worker successfully` 与 `Uploading Worker bundle`。若只看到 `Uploaded N files` 而没有 worker bundle，说明 `_worker.js` 没被识别（会被当成普通静态文件，根路径 404）。

API Token 权限：`Cloudflare Pages:Edit` + `Account:Read`。

## 部署后验证

```bash
BASE=https://<项目名>.pages.dev

# 站点可达（必须带 --http1.1）
curl -sk --http1.1 -o /dev/null -w '%{http_code}\n' "$BASE/"

# 文件元信息（HANDLE/KEY 来自 mega.nz/file/<HANDLE>#<KEY>）
curl -sk --http1.1 "$BASE/pf/<HANDLE>/<KEY>"

# 解密后字节（前 32 字节应有文件魔数，如 MP4 的 ftypmp42）
curl -sk --http1.1 -r 0-31 "$BASE/pf/<HANDLE>/<KEY>/download" | od -A x -t x1z

# 断点续传前提：任意偏移 Range 返回 206 + 正确 Content-Range
curl -sk --http1.1 -D - -o /dev/null -r 524288000-528482303 "$BASE/pf/<HANDLE>/<KEY>/download" | grep -i content-range
```

## 接入下载器

`.env` 里配置中转站基址，网盘 provider 会自动把 MEGA 链接改写成 `"$BASE/pf/<HANDLE>/<KEY>/download"`：

```
PAWCHIVE_MEGA_WORKER=https://<项目名>.pages.dev
```

留空则不下载 MEGA（直连速度不可用，不会静默降速硬下）。

## 上游来源

Worker 源码来自 https://github.com/developeranaz/MEGA-INDEX-CLOUDFLARE（作者 developeranaz），原样保存在 `tools/mega-worker/worker.js`，说明见该目录 README。原仓库未声明明确开源许可，仅作个人自用部署。
