# 9Router 部署指南

## 快速开始

### 构建并部署

```bash
cd /tmp/9router-build
npm run deploy
```

### 启动服务（前台）

```bash
npm run deploy:start
```

### 启动服务（后台）

```bash
npm run deploy:start &
```

或使用 nohup（推荐）：

```bash
nohup npm run deploy:start > /tmp/9router.log 2>&1 &
```

查看日志：

```bash
tail -f /tmp/9router.log
```

### 关闭服务

```bash
npm run deploy:stop
```

### 指定端口

```bash
# 启动（端口 3000）
PORT=3000 npm run deploy:start

# 关闭（端口 3000）
npm run deploy:stop:3000
```

## 可用命令

| 命令 | 说明 |
|------|------|
| `npm run deploy` | 构建并部署（复制静态资源） |
| `npm run deploy:build` | 仅构建项目 |
| `npm run deploy:start` | 启动 standalone 服务（默认端口 20128） |
| `npm run deploy:stop` | 关闭服务（默认端口 20128） |
| `npm run deploy:stop:3000` | 关闭端口 3000 上的服务 |
| `npm run deploy:clean` | 清理构建产物 |

## 其他常用命令

```bash
# 开发模式
npm run dev

# 生产构建
npm run build

# 清理 node_modules 后重新安装
rm -rf node_modules package-lock.json
npm install
```

## 目录结构

```
/tmp/9router-build/
├── .next/
│   └── standalone/     # Standalone 构建输出
│       ├── server.js   # 服务入口
│       ├── .next/static/  # chunks、CSS 等（自动复制）
│       └── public/     # 图标、语言文件等（自动复制）
├── public/             # 原始静态资源
├── i18n/               # 语言文件
└── src/                # 源代码
```

## 注意事项

1. **Standalone 模式**：Next.js standalone 模式不会自动服务静态资源，部署脚本会自动复制 `_next/static` 和 `public/`
2. **浏览器缓存**：更新代码后建议使用 `Cmd+Shift+R` (Mac) 或 `Ctrl+Shift+R` (Windows) 强制刷新
3. **Node.js 版本**：better-sqlite3 需要与当前 Node.js 版本匹配，如遇问题执行 `npm rebuild`
