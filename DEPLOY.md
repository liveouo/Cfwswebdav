# R2 WebDAV Worker 部署文档

一个基于 Cloudflare Workers + R2 的轻量私有网盘/对象存储网关。既提供开箱即用的 **Web 文件管理器**，又完整支持 **WebDAV 协议**，可被 rclone、Windows 网络驱动器、RaiDrive、Cyberduck 等客户端直接挂载使用。

- 项目目录：本项目根目录（`/workspace`）
- 核心源码：`src/index.js`（单文件，可直接粘贴部署）
- 在线部署单文件：`dist/worker.js`
- 本地测试：`npm test`

---

## 目录

1. [功能特性](#一功能特性)
2. [技术架构](#二技术架构)
3. [部署前准备](#三部署前准备)
4. [快速部署：Dashboard 可视化（推荐，5 分钟）](#四快速部署dashboard-可视化推荐)
5. [部署：Wrangler CLI](#五部署wrangler-cli)
6. [部署：GitHub Actions 持续集成（可选）](#六部署github-actions-持续集成可选)
7. [配置说明：环境变量与 R2 绑定](#七配置说明环境变量与-r2-绑定)
8. [Web 文件管理器使用说明](#八web-文件管理器使用说明)
9. [WebDAV 客户端配置](#九webdav-客户端配置)
10. [安全建议](#十安全建议)
11. [协议与 API 参考](#十一协议与-api-参考)
12. [目录结构与本地开发](#十二目录结构与本地开发)
13. [常见问题排查](#十三常见问题排查)

---

## 一、功能特性

| 能力 | 说明 |
| --- | --- |
| Web 文件管理器 | 浏览器上传/下载/删除/重命名/新建文件夹/拖拽上传/多选批量删除 |
| WebDAV 协议 | 支持 `PROPFIND / MKCOL / GET / PUT / DELETE / COPY / MOVE / OPTIONS`，兼容 `DAV: 1, 2` |
| 客户端兼容 | rclone、Windows「映射网络驱动器」、RaiDrive、Cyberduck、mount.davfs、手机端 WebDAV 应用 |
| 断点续传 | 支持 HTTP Range（`206 Partial Content`），适配播放器与下载工具 |
| 认证鉴权 | HTTP Basic 认证；支持只读模式、公读模式 |
| 零服务器成本 | 走 Cloudflare 免费额度，R2 免费 10GB 存储 / 每月 100 万次读操作 |
| 部署极简 | 单文件 Worker，Dashboard 粘贴即用，无需构建工具 |

## 二、技术架构

```
        ┌──────────────────────────────────────────────┐
        │        Cloudflare Workers (r2-webdav)        │
        │                                              │
 用户 ──►│  /  (Accept: text/html)   →  Web 管理界面    │
        │                                              │
 用户 ──►│  WebDAV 方法               →  PROPFIND 等    │
        │  (rclone / Windows /...)                      │
        │                          ┌──────────────────┐ │
        │        R2 Binding (R2)    │  R2 存储桶        │ │
        │        env.R2 ───────────►│  (对象存储)       │ │
        └──────────────────────────┴──────────────────┴─┘
```

关键设计：

- **单文件 Worker**：`src/index.js` 内含路由、鉴权、WebDAV 逻辑与 Web 界面（`UI_HTML`），无需额外资源。
- **目录模拟**：R2 是扁平对象存储。用「以 `/` 结尾的占位对象」表示空目录，列表时通过 `prefix + delimiter` 模拟层级。
- **一次鉴权，双端共用**：Web 界面与 WebDAV 使用同一套用户名密码，UI 把凭据保存在 `sessionStorage`，下载时通过 `?token=` 传递。
- **错误与空值处理**：所有 WebDAV 错误均返回标准状态码（`404/405/409/412/416` 等），便于客户端正确处理。

## 三、部署前准备

1. 一个 **Cloudflare 账号**（免费即可）。注册地址：<https://dash.cloudflare.com/sign-up>
2. 域名非必需：开发预览可直接使用 `*.workers.dev` 子域名。

---

## 四、快速部署：Dashboard 可视化（推荐）

全程在浏览器完成，无需安装任何本地工具，约 5 分钟。

### 4.1 创建 R2 存储桶

1. 登录 Cloudflare Dashboard。
2. 左侧菜单点击 **R2 Object Storage**。
3. 点击 **Create bucket**（创建存储桶）。
4. 填写存储桶名称，例如 `r2-webdav-bucket`（名称会用于绑定，记下来）。
   - Location / 存储层级按默认即可。
5. 点击 **Create bucket** 完成创建。

### 4.2 创建 Worker

1. 左侧菜单点击 **Workers & Pages**。
2. 点击 **Create** → **Create Worker**。
3. 填写 Worker 名称，例如 `r2-webdav`。
4. 选择 **Deploy**（可以先创建默认模板，稍后替换代码）。
5. 部署完成后进入 Worker 的 **Overview** 页面，记录下访问地址 `https://r2-webdav.<your-subdomain>.workers.dev`。

### 4.3 粘贴代码

1. 在 Worker 页面点击 **Edit code**（编辑代码）。
2. 全选删除默认模板代码。
3. 打开本项目生成的单文件 `dist/worker.js`，复制全部内容粘贴到编辑器。
4. 点击右上角 **Deploy**（保存并部署）。

> 提示：若使用 Git 检出项目，也可以直接复制 `src/index.js`，二者内容一致。

### 4.4 绑定 R2 存储桶

1. 回到 Worker 的 **Settings（设置）** 页面。
2. 选择 **Bindings（绑定）** 标签页。
3. 找到 **R2 Object Storage**，点击 **Add**（添加）。
4. 配置：
   - **Variable name（变量名）**：必须填写 `R2`（代码中读取的就是这个名字）。
   - **Bucket name（存储桶）**：选择第 4.1 步创建的 `r2-webdav-bucket`。
5. 点击 **Save** 保存。

### 4.5 配置环境变量（用户名 / 密码）

1. 在 **Settings → Variables and Secrets（变量和机密）** 页面。
2. 添加以下两个 **Secret（机密）**（机密类型不会明文显示，推荐）：
   - `R2_USER`：管理界面/WebDAV 登录用户名，如 `admin`
   - `R2_PASS`：登录密码，如 `MyStr0ng!Pass`
3. 可选变量（普通 Variable 即可）：
   - `PUBLIC_READ`：`true` 时允许匿名下载（GET/HEAD 免鉴权），默认 `false`
   - `READ_ONLY`：`true` 时禁止一切写操作，默认 `false`
4. 保存后回到 Worker **Overview**，点击 **Deploy**（如有改动）让配置生效。

### 4.6 验证

- 打开 `https://r2-webdav.<your-subdomain>.workers.dev`，浏览器会进入 Web 文件管理器，输入第 4.5 步的用户名密码登录。
- 上传一个文件测试；若文件正常列出并可下载，说明部署成功。
- 使用 rclone / Windows 网络驱动器连接同一地址，测试 WebDAV（见 [第九节](#九webdav-客户端配置)）。

---

## 五、部署：Wrangler CLI

适合习惯命令行的开发者，支持 `wrangler dev` 本地调试。

### 5.1 安装依赖

```bash
npm install
```

### 5.2 登录 Cloudflare

```bash
npx wrangler login
```

### 5.3 创建 R2 存储桶（仅首次）

```bash
npx wrangler r2 bucket create r2-webdav-bucket
```

### 5.4 配置机密（推荐，不回显）

```bash
npx wrangler secret put R2_USER
npx wrangler secret put R2_PASS
```

### 5.5 修改 `wrangler.toml`

确保 `bucket_name` 与 `preview_bucket_name` 指向你的存储桶名称，绑定变量名固定为 `R2`：

```toml
name = "r2-webdav"
main = "src/index.js"
compatibility_date = "2025-05-01"
compatibility_flags = ["nodejs_compat"]

[[r2_buckets]]
binding = "R2"
bucket_name = "r2-webdav-bucket"
preview_bucket_name = "r2-webdav-bucket"
```

### 5.6 部署

```bash
npx wrangler deploy
```

部署成功后输出中会给出 `https://r2-webdav.<your-subdomain>.workers.dev` 访问地址。

### 5.7 本地调试

```bash
npm run dev
```

`wrangler dev --local` 会在本机模拟 R2，便于开发调试。本地模拟环境中 `R2_USER / R2_PASS` 取 `wrangler.toml` 的 `[vars]` 默认值。

---

## 六、部署：GitHub Actions 持续集成（可选）

在仓库添加 `.github/workflows/deploy.yml`，推送即自动部署：

```yaml
name: Deploy Worker

on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npm ci
      - name: Deploy to Cloudflare Workers
        uses: cloudflare/wrangler-action@v3
        with:
          apiToken: ${{ secrets.CF_API_TOKEN }}
          accountId: ${{ secrets.CF_ACCOUNT_ID }}
          command: deploy
      - name: Put secrets
        run: |
          echo "${{ secrets.R2_PASS }}" | npx wrangler secret put R2_PASS
```

在 GitHub 仓库 Settings → Secrets 中添加：

- `CF_API_TOKEN`：Cloudflare API Token（权限：`Workers Scripts: Edit`、`Account R2 Storage: Edit`）
- `CF_ACCOUNT_ID`：Cloudflare 账户 ID（Dashboard 右下角可查）
- `R2_PASS`：访问密码

---

## 七、配置说明：环境变量与 R2 绑定

### 7.1 R2 绑定

| 配置项 | 必须 | 说明 |
| --- | --- | --- |
| 绑定变量名 `R2` | 是 | 代码中通过 `env.R2` 读写存储桶，名字不可改 |

### 7.2 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `R2_USER` | 空 | Web/WebDAV 登录用户名。为空表示**不开启鉴权**（任何人可读写，慎用） |
| `R2_PASS` | 空 | 登录密码。与 `R2_USER` 配合使用 |
| `PUBLIC_READ` | `false` | `true` 时 GET/HEAD 免鉴权，可匿名下载 |
| `READ_ONLY` | `false` | `true` 时禁止 PUT/MKCOL/DELETE/MOVE/COPY 等写操作 |

> 兼容旧变量名 `ADMIN_USER` / `ADMIN_PASS`（优先级低于 `R2_USER` / `R2_PASS`）。

### 7.3 鉴权策略速查

| `R2_USER` | `PUBLIC_READ` | 读操作（GET/HEAD） | 写操作 |
| --- | --- | --- | --- |
| 空 | 任意 | 免鉴权 | 免鉴权 |
| 已设置 | `false` | 需 Basic 认证 | 需 Basic 认证 |
| 已设置 | `true` | 免鉴权 | 需 Basic 认证 |

---

## 八、Web 文件管理器使用说明

访问 Worker 地址（`https://r2-webdav.<sub>.workers.dev`），浏览器将自动加载管理界面。

| 功能 | 操作 |
| --- | --- |
| 登录 | 首次打开弹出登录框，输入 `R2_USER` / `R2_PASS` |
| 浏览目录 | 点击文件夹名进入，点击面包屑返回上级或根目录 |
| 上传 | 点击「上传文件」选择文件，或直接把文件**拖拽**到列表区域（支持多文件、带进度条） |
| 下载 | 点击文件行名称或「下载」按钮 |
| 新建文件夹 | 点击「新建文件夹」，输入名称 |
| 重命名 | 点击行内「重命名」 |
| 删除 | 点击行内「删除」，或勾选多项后点「删除选中」批量删除 |
| 复制路径 | 点击「复制路径」得到可直接访问该文件的 URL |

> 凭据保存在浏览器 `sessionStorage`，关闭标签页即失效；点击「退出登录」可立即清除。

---

## 九、WebDAV 客户端配置

所有客户端统一使用：

- **服务器地址**：`https://r2-webdav.<your-subdomain>.workers.dev`
- **用户名 / 密码**：`R2_USER` / `R2_PASS`
- **路径**：根目录 `/`

### 9.1 rclone（推荐，全平台）

1. 安装 rclone：<https://rclone.org/downloads>
2. 交互式创建 remote：

```bash
rclone config
```

3. 按提示选择：

```text
n) New remote
Storage: 输入 webdav 或选择对应编号
url: https://r2-webdav.<your-subdomain>.workers.dev
vendor: 选择 other
user: 输入 R2_USER
pass: 输入 R2_PASS（可留空，稍后设置）
```

4. 常用命令：

```bash
# 列出根目录
rclone ls r2:

# 上传本地目录
rclone copy ./photos r2:photos

# 下载
rclone copy r2:docs ./docs

# 双向同步（注意目标为空目录才会删除）
rclone sync ./local r2:local

# 挂载为本地盘（需要 rclone mount）
rclone mount r2: ~/mnt/r2 --vfs-cache-mode full
```

### 9.2 Windows 网络驱动器

> 说明：Windows 系统自带的 WebDAV 客户端体验较差且默认禁用未签名连接，**推荐优先使用 rclone 或 RaiDrive**。若仍要使用系统自带功能：

1. 打开「此电脑」→ 右键「映射网络驱动器」。
2. 文件夹填：`https://r2-webdav.<your-subdomain>.workers.dev`
3. 勾选「使用其他凭据连接」，输入用户名密码。
4. 若提示「需要安全凭据」或失败，请改用 RaiDrive / rclone。

### 9.3 RaiDrive（Windows，图形化挂载盘）

1. 下载安装 RaiDrive：<https://www.raidrive.com>
2. 添加连接：
   - **服务类型**：WebDAV
   - **协议**：HTTPS
   - **地址**：`r2-webdav.<your-subdomain>.workers.dev`
   - **路径**：`/`
   - **账号 / 密码**：`R2_USER` / `R2_PASS`
3. 连接后即可像本地磁盘一样浏览、拖拽文件。

### 9.4 Cyberduck（macOS / Windows 图形客户端）

1. 下载安装 Cyberduck：<https://cyberduck.io/download>
2. 点击「新建连接」：
   - **协议**：WebDAV (HTTPS)
   - **服务器**：`r2-webdav.<your-subdomain>.workers.dev`
   - **用户名 / 密码**：`R2_USER` / `R2_PASS`
3. 连接后拖拽上传/下载即可。

### 9.5 Linux：davfs2（挂载为本地目录）

```bash
sudo apt-get install -y davfs2
sudo mkdir -p /mnt/r2
sudo mount -t davfs https://r2-webdav.<your-subdomain>.workers.dev /mnt/r2
```

首次挂载会交互询问用户名/密码，可按提示保存到 `~/.davfs2/secrets`。

### 9.6 手机端

- **安卓**：Solid Explorer（「新建连接 → WebDAV」）、CX 文件管理器、RCX（Rclone）。
- **iOS**：Documents by Readdle（「连接 → WebDAV」）、FE File Explorer。

---

## 十、安全建议

1. **务必设置 `R2_USER` / `R2_PASS`**，且密码应随机、足够复杂。未配置时任何人可读写存储桶。
2. 密码通过 **Secret** 类型存储，避免明文回显；不要写入 `wrangler.toml`。
3. 生产环境建议把 Worker 绑定到**自己的域名**（Workers → Custom Domains），并在域名下开启 HTTPS（Cloudflare 自动提供）。
4. 如需只对外分享、不让别人写入，可设置 `READ_ONLY=true`。
5. 定期清理不需要的大文件；R2 计费与流量相关，超量可能产生费用，请关注 Dashboard 用量。
6. 不要把 `?token=` 链接分享给不受信任的人（携带完整凭据）。

## 十一、协议与 API 参考

### 11.1 支持的 WebDAV 方法

| 方法 | 功能 | 说明 |
| --- | --- | --- |
| `OPTIONS` | 能力探测 | 返回 `DAV: 1, 2` 与 Allow 列表 |
| `PROPFIND` | 列目录 / 取属性 | 支持 `Depth: 0/1` |
| `MKCOL` | 创建目录 | 使用占位对象模拟空目录 |
| `GET` / `HEAD` | 下载 / 头信息 | 支持 Range 断点续传 |
| `PUT` | 上传 / 覆盖 | 保留 `Content-Type` |
| `DELETE` | 删除文件或目录 | 目录递归删除 |
| `COPY` | 复制 | 支持递归复制目录 |
| `MOVE` | 移动 / 重命名 | 支持递归移动目录 |
| `LOCK` / `UNLOCK` | 锁 | 返回空锁以兼容部分客户端 |

### 11.2 HTTP 状态码

| 状态码 | 场景 |
| --- | --- |
| `200` | GET / HEAD / OPTIONS 成功 |
| `201` | PUT / MKCOL / COPY / MOVE 成功创建 |
| `204` | DELETE 成功 |
| `206` | Range 部分内容 |
| `207` | PROPFIND 多状态响应 |
| `401` | 未认证或凭据错误 |
| `403` | 禁止操作（只读模式 / 删除根目录） |
| `404` | 资源不存在 |
| `405` | 方法不允许 / 目录已存在 |
| `409` | 目录移动到自身内部 |
| `412` | 目标已存在且 `Overwrite: F` |
| `416` | Range 越界 |

### 11.3 额外便利接口

| 用法 | 说明 |
| --- | --- |
| `GET /file.txt?download=1` | 强制下载（`Content-Disposition: attachment`） |
| `GET /file.txt?token=<base64(user:pass)>` | 用 URL 携带凭据下载（供 Web 界面使用） |

---

## 十二、目录结构与本地开发

```
.
├── src/
│   └── index.js          # 全部逻辑：路由 + WebDAV + 鉴权 + Web 界面
├── dist/
│   └── worker.js         # 单文件构建产物，供 Dashboard 直接粘贴
├── scripts/
│   ├── bundle.mjs        # 生成 dist/worker.js
│   └── test-local.mjs    # 本地集成测试（内置内存版 R2 模拟）
├── wrangler.toml         # Wrangler 配置（R2 绑定、环境变量）
├── package.json          # npm 脚本与依赖
├── DEPLOY.md             # 本文档
└── README.md             # 项目简介
```

常用命令：

```bash
npm test          # 本地集成测试（45 项断言；端口冲突时可用 TEST_PORT=xxxx npm test）
npm run build     # 重新生成 dist/worker.js
npm run dev       # wrangler dev --local 本地调试
npm run deploy    # wrangler deploy 部署
```

## 十三、常见问题排查

| 现象 | 可能原因 | 处理 |
| --- | --- | --- |
| 打开地址显示 JSON 或 404 | 绑定了 Worker 但没有绑定 R2，或绑定变量名不是 `R2` | 检查 Settings → Bindings |
| 浏览器弹出登录框无法进入 | 密码错误，或只配置了其中一个变量 | 重新设置 `R2_USER` / `R2_PASS` 并重新部署 |
| WebDAV 客户端 401 | 用户名密码错误，或密码含特殊字符未转义 | 核对凭据；rclone 中密码二次确认保持一致 |
| Windows 映射驱动器失败 | Windows 自带 WebDAV 兼容性差 | 改用 rclone 或 RaiDrive |
| 上传大文件中断 | 单一请求超时 | R2 单请求有大小上限，大文件请用 rclone 分段上传 |
| `wrangler dev` 提示认证 | 需要登录 | 执行 `npx wrangler login` |
| 修改代码后不生效 | 未重新部署 | Dashboard 点击 Deploy；CLI 执行 `npx wrangler deploy` |
| 想撤销误删 | R2 无回收站 | 开启版本管理或定期备份（见 Cloudflare 文档） |
