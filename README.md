# R2 WebDAV Worker

基于 **Cloudflare Workers + R2** 的轻量私有网盘 / 对象存储网关。

- **Web 文件管理器**：浏览器直接管理文件（上传、下载、删除、重命名、新建文件夹、拖拽上传、批量删除）
- **WebDAV 协议**：可被 rclone、Windows 网络驱动器、RaiDrive、Cyberduck、手机端 App 直接挂载使用
- **部署极简**：单文件 Worker，Dashboard 粘贴即用，无需服务器，走 Cloudflare 免费额度

## 快速开始

| 方式 | 步骤 |
| --- | --- |
| Dashboard（推荐） | 创建 R2 存储桶 → 新建 Worker → 粘贴 `dist/worker.js` → 绑定存储桶（变量名 `R2`）→ 设置 `R2_USER` / `R2_PASS` |
| Wrangler CLI | `npm install` → `npx wrangler login` → `npx wrangler r2 bucket create r2-webdav-bucket` → `npx wrangler secret put R2_USER` / `R2_PASS` → `npx wrangler deploy` |

## 使用

- 浏览器访问 Worker 地址即进入文件管理器
- WebDAV 客户端连接同一地址，使用 `R2_USER` / `R2_PASS` 登录

## 常用命令

```bash
npm test          # 本地集成测试
npm run build     # 生成 dist/worker.js
npm run dev       # 本地调试（wrangler dev --local）
npm run deploy    # 部署到 Cloudflare
```

## 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `R2_USER` / `R2_PASS` | 空 | 登录凭据；为空表示不开启鉴权 |
| `PUBLIC_READ` | `false` | 匿名只读下载 |
| `READ_ONLY` | `false` | 禁止一切写操作 |

## 文档

详细部署步骤、客户端配置、协议参考与排障，见 [DEPLOY.md](DEPLOY.md)。
