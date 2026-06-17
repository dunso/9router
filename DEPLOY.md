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
npm install
npm run dev

# 生产构建
npm install
npm run build && npx next start --port 20128


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

## 开发环境

### 项目目录

```
/tmp/9router-build
```

### 使用 WebStorm 打开

1. File → Open
2. 选择 `/tmp/9router-build`
3. 点击 Open

### 数据库位置

```
~/.9router/db/data.sqlite
```

### 关键目录结构

```
/tmp/9router-build/
├── src/                    # Next.js 源代码
│   ├── app/               # Next.js App Router
│   ├── lib/               # 工具库
│   │   ├── oauth/         # OAuth 相关
│   │   └── ...
│   └── sse/               # SSE 相关
├── open-sse/              # Open SSE 执行器
│   ├── executors/         # 执行器实现
│   ├── handlers/          # 请求处理器
│   └── config/            # 配置文件
├── docs/                  # 文档
├── DEPLOY.md              # 部署指南（本文件）
├── package.json
└── tsconfig.json
```

## 发布到 tnpm（新版 CLI 架构）

### 架构说明

新版发布采用 CLI 与服务分离的架构（参考 decolua/9router）：

**包名**: `@tencent/9router`
**Registry**: `https://mirrors.tencent.com/npm/`

```
/tmp/9router-build/
├── .next/standalone/           # Next.js standalone 构建输出
├── cli/                        # CLI 包（独立发布）
│   ├── cli.js                  # CLI 入口
│   ├── app/                    # Standalone 服务（构建后复制）
│   │   ├── server.js           # 服务入口
│   │   ├── custom-server.js    # 自定义服务器
│   │   ├── .next-cli-build/    # 构建产物
│   │   └── node_modules/       # 运行时依赖
│   ├── src/                    # CLI 源码
│   ├── hooks/                  # 安装钩子
│   ├── scripts/                # 构建脚本
│   ├── package.json            # CLI 包配置
│   └── 9router-*.tgz           # 打包文件
└── package.json                # 主项目配置
```

### 完整发布流程

#### 1. 编译构建

```bash
cd /tmp/9router-build

# 1.1 构建主项目（生成 .next/standalone/）
npm install
npm run build

# 1.2 构建 CLI 包（复制 standalone 到 cli/app/）
cd cli
npm install
npm run build
```

**build-cli.js 执行流程：**
1. 同步版本号到 app/package.json
2. 构建 Next.js（设置 NEXT_DIST_DIR=.next-cli-build）
3. 复制 standalone 到 cli/app/
   - 优先找 `.next-cli-build/standalone/server.js`
   - 否则找 `.next-cli-build/standalone/app/`
   - Next.js 16.2+ 可能在 `.next-cli-build/standalone/<package-name>/`
4. 配置 SQLite（确保 sql.js 打包）
5. 复制静态文件（.next/static、public、vendor-chunks）
6. 复制 MITM 文件（src/mitm、src/lib/updater）
7. 构建 MITM 服务（buildMitm.js）

**验证编译结果：**
```bash
ls -la cli/app/server.js  # 应该存在
ls -la cli/app/node_modules/  # 应该有内容
du -sh cli/app/  # 应该约 50MB
```

#### 2. 打包（可选）

```bash
cd /tmp/9router-build/cli
npm pack --dry-run  # 预览打包内容
npm pack  # 生成 tgz 文件
```

#### 3. 发布

```bash
cd /tmp/9router-build/cli

# 3.1 首次发布需要登录
npm adduser --registry=https://mirrors.tencent.com/npm/

# 3.2 发布 CLI 包
npm --no-git-tag-version version patch && npm publish --registry=https://mirrors.tencent.com/npm/
```

**注意事项：**
- 包名必须使用 `@tencent/` 前缀
- 使用 `https://mirrors.tencent.com/npm/` 而不是 `http://r.tnpm.oa.com/`（后者会重定向到 mirrors）
- 发布包约 13MB（压缩后），解压约 48MB

#### 4. 安装

```bash
# 全局安装
npm install -g @tencent/9router --registry=https://mirrors.tencent.com/npm/

# 或指定版本
npm install -g @tencent/9router@0.5.8 --registry=https://mirrors.tencent.com/npm/

# 更新到最新版
npm install -g @tencent/9router@latest --registry=https://mirrors.tencent.com/npm/
```

#### 5. 验证安装

```bash
# 检查版本
9router --version

# 启动服务
9router

# 或指定端口
9router -p 3000
```

### CLI 命令（安装后可用）

```bash
# 启动服务（默认端口 20128）
9router

# 指定端口启动
9router -p 3000

# 显示日志启动
9router --log

# 后台模式（隐藏到托盘）
9router --tray

# 跳过更新检查
9router --skip-update

# 查看帮助
9router --help

# 查看版本
9router --version
```

### 选项说明

| 选项 | 说明 |
|------|------|
| `-p, --port <port>` | 指定端口（默认: 20128） |
| `-H, --host <host>` | 绑定地址（默认: 0.0.0.0） |
| `-n, --no-browser` | 不自动打开浏览器 |
| `-l, --log` | 显示服务器日志 |
| `-t, --tray` | 后台模式（系统托盘） |
| `--skip-update` | 跳过更新检查 |

### 旧版发布方式（已废弃）

```bash
# 旧版直接发布主项目（不推荐）
cd /tmp/9router-build
npm run build
npm --no-git-tag-version version patch && tnpm publish
```

### 注意事项

1. **发布前必须构建**：CLI 包发布前需要执行 `npm run build` 确保 standalone 输出到 `cli/app/`
2. **包名格式**：内部包必须使用 `@tencent/` 前缀
3. **Registry 配置**：使用 `https://mirrors.tencent.com/npm/` 而不是 `http://r.tnpm.oa.com/`（后者会重定向）
4. **用户首次使用**：安装后首次运行会自动检测并安装 SQLite 运行时依赖
5. **端口占用**：CLI 启动时会自动清理占用 20128 端口的旧进程
