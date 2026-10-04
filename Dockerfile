FROM node:20-alpine

WORKDIR /app

# 复制依赖声明
COPY package*.json ./

# 安装生产依赖
RUN npm ci --only=production --no-audit --no-fund

# 复制源代码
COPY . .

# 构建 vendor（把 node_modules 里的 three.js 拷到 vendor/）
RUN npm run vendor

# 清理 node_modules（vendor 已构建完，运行时只需 serve.js 的依赖）
# 实际上 serve.js 只用 Node.js 内置模块，所以可以全删
RUN rm -rf node_modules && npm ci --only=production --no-audit --no-fund

# 暴露端口
EXPOSE 5173

# 健康检查
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:5173/', (r) => process.exit(r.statusCode === 200 ? 0 : 1))"

# 启动服务
CMD ["node", "serve.js"]
