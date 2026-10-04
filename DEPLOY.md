# 部署指南

本项目是纯前端 + 轻量静态服务器，部署非常灵活。

---

## 方案一：局域网演示（最简单）

**适合场景**：内网演示、临时展示、手机扫码看房。

```bash
npm start
```

终端会打印：
```
本机打开    http://localhost:5173/
手机打开    http://192.168.x.x:5173/   ← 同一 WiFi
```

把手机地址发给同事/客户，浏览器打开即可。不需要公网，不需要域名。

**优点**：零配置，npm start 就能用。  
**缺点**：只有同一局域网能访问；电脑关机就断。

---

## 方案二：静态托管 + CDN（推荐生产）

**适合场景**：长期对外服务、客户自助看房、SEO。

### 2.1 准备静态文件

```bash
# 1. 构建 vendor（已在 postinstall 自动完成）
npm run vendor

# 2. 把这些文件打包上传到静态托管：
index.html
styles.css
src/
vendor/
models/          # 只上传你想公开的模型
assets/          # 如果有额外素材
```

**不要上传** `node_modules/`、`serve.js`、`scripts/`。

### 2.2 托管平台选择

| 平台 | 适合 | 备注 |
|---|---|---|
| **Vercel / Netlify** | 免费演示站 | 直接连 GitHub 仓库，自动部署。Vercel 限 100GB/月流量 |
| **Cloudflare Pages** | 无限流量 | 同样连 GitHub，build 命令留空，output 是根目录 |
| **AWS S3 + CloudFront** | 企业生产 | S3 存文件，CloudFront 做 CDN，按流量计费 |
| **阿里云 OSS + CDN** | 国内客户 | 和 AWS 类似，国内访问快 |
| **GitHub Pages** | 开源项目 | 免费但流量限制严（100GB/月），适合开源展示 |

**关键配置**：
- **单页路由**：配置 404 fallback 到 `index.html`（但这个项目不需要，没用到前端路由）
- **MIME 类型**：确保 `.glb` 是 `model/gltf-binary`，`.wasm` 是 `application/wasm`，`.js` 是 `text/javascript`（大部分平台自动识别）
- **CORS**：如果模型放在另一个域（如 CDN），需要设 `Access-Control-Allow-Origin: *`

### 2.3 模型文件建议

静态托管通常限单文件大小（Vercel 限 50MB，Cloudflare 25MB）。

**大模型怎么办？**
1. **放对象存储**：模型上传到 S3/OSS/Backblaze，拿到公开 URL，在页面里填这个 URL
2. **Draco 压缩**：Blender 导出时勾选 Draco，能压到原来的 1/5
3. **精简面数**：用 Blender 的 Decimate modifier 降到 50 万面以下

---

## 方案三：Docker 容器（适合企业内网）

**适合场景**：公司内部服务器、长期运行、需要上传接口。

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY . .
RUN npm run vendor
EXPOSE 5173
CMD ["node", "serve.js"]
```

```bash
docker build -t house-tour .
docker run -d -p 5173:5173 -v $(pwd)/models:/app/models house-tour
```

挂载 `models/` 卷，这样上传的文件能持久化。

---

## 方案四：Serverless（按需启动）

**适合场景**：偶尔用一次、不想一直跑服务器。

### 4.1 Vercel Serverless Functions

把 `serve.js` 改造成 `/api/upload.js` 和 `/api/models.js` 两个函数，静态文件直接托管。

**注意**：Vercel 的 Serverless 函数有 50MB 响应体限制，大模型要走 S3。

### 4.2 Cloudflare Workers

类似，用 Workers 处理上传，R2 存模型（Workers 带 10GB 免费 R2 存储）。

---

## 上传接口安全加固

当前的 `serve.js` 是局域网演示用的，**没有鉴权**。生产环境必须加：

### 选项 A：JWT 鉴权

```javascript
// serve.js 里加一个中间件
function checkAuth(req) {
  const token = req.headers.authorization?.replace('Bearer ', '')
  if (!token || !verifyJWT(token, SECRET)) return false
  return true
}

if (pathname === '/_upload' && req.method === 'POST') {
  if (!checkAuth(req)) return send(res, 401, 'Unauthorized')
  return handleUpload(req, res, url)
}
```

前端在设置面板输入 token，存到 `localStorage`，上传时带上。

### 选项 B：只读模式

删掉 `/_upload` 接口，模型全部通过 SSH/FTP 手动上传到 `models/` 文件夹。

### 选项 C：IP 白名单

```javascript
const ALLOWED_IPS = ['192.168.1.100', '10.0.0.5']
if (pathname === '/_upload') {
  const ip = req.socket.remoteAddress
  if (!ALLOWED_IPS.includes(ip)) return send(res, 403, 'Forbidden')
}
```

只允许公司内网 IP 上传。

---

## 环境变量

`serve.js` 支持的环境变量：

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | 5173 | 服务器端口 |
| `HOST` | 0.0.0.0 | 监听地址，改成 127.0.0.1 禁止外网访问 |

```bash
PORT=8080 HOST=127.0.0.1 npm start
```

---

## 性能优化

### 1. 开启 Gzip

静态托管平台通常自动开。Docker 部署的话，前面挂一个 nginx：

```nginx
location / {
  gzip on;
  gzip_types text/css application/javascript model/gltf-binary;
  proxy_pass http://localhost:5173;
}
```

### 2. 浏览器缓存

`serve.js` 默认是 `Cache-Control: no-cache`（每次都验证），生产环境改成：

```javascript
headers['Cache-Control'] = type.startsWith('model/') || ext === '.wasm' 
  ? 'public, max-age=31536000, immutable'  // 模型缓存一年
  : 'public, max-age=3600'                 // HTML/CSS 缓存 1 小时
```

### 3. CDN

把 `vendor/` 和 `models/` 扔到 CDN，改 `index.html` 里的 import map：

```json
{
  "imports": {
    "three": "https://cdn.example.com/vendor/three/build/three.module.js",
    "three/addons/": "https://cdn.example.com/vendor/three/examples/jsm/"
  }
}
```

---

## 监控与日志

生产环境建议加：

1. **错误上报**：前端接入 Sentry，捕获 JS 异常和 WebGL 错误
2. **访问日志**：nginx access.log 或者 Cloudflare Analytics
3. **性能监控**：加一个 `performance.now()` 埋点，记录载入时长、帧率

---

## 故障排查

**问题：打开是黑屏**
- 检查浏览器控制台，看有没有 CORS 错误或 404
- 确认 import map 路径正确（vendor/ 已上传）
- 用 `file://` 打开不行，必须走 HTTP 服务器

**问题：模型载入失败**
- 大文件被 CDN 限制？试试分段加载或换 Range 支持的 CDN
- Draco/KTX2 解码器路径不对？`vendor/three/examples/jsm/libs/` 要完整上传

**问题：手机上很卡**
- 模型面数太多（超 100 万面），用 Blender 精简
- 贴图太大（4K），压到 1K
- 设置里把画质锁到「流畅」，关掉阴影

---

## 成本估算（按月）

| 方案 | 流量 1TB | 存储 50GB | 备注 |
|---|---|---|
| Vercel | ❌ 超免费额度 | 免费 | 免费版 100GB/月流量 |
| Cloudflare Pages | 免费 | 免费 | 无流量限制🎉 |
| AWS S3 + CloudFront | ~$90 | ~$1 | 按量付费 |
| 阿里云 OSS + CDN | ~¥60 | ~¥1 | 国内便宜些 |
| 自建 VPS (4核8G) | 固定 ~¥100 | 包含 | DigitalOcean / Vultr |

**推荐**：先用 Cloudflare Pages 免费跑，流量大了再迁到 AWS/阿里云。
