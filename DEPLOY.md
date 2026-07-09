# 部署到 GitHub Pages

本项目已配置好一键部署到 GitHub Pages 的功能。

## 部署步骤

### 1. 安装依赖

```bash
npm install
```

### 2. 部署项目

```bash
npm run deploy
```

这个命令会：
1. 自动构建项目（`npm run build`）
2. 使用 `gh-pages` 工具将 `dist` 目录推送到 `gh-pages` 分支

### 3. 配置 GitHub Pages

在你的 GitHub 仓库设置中：
1. 进入 **Settings** → **Pages**
2. 在 **Source** 中选择 `gh-pages` 分支
3. 点击 **Save**

几分钟后，你的应用就可以通过以下地址访问：
```
https://Aning-Q.github.io/read-something/
```

## 功能说明

### 跨设备同步

本项目新增了 GitHub Gist 跨设备同步功能：

1. **生成 GitHub Token**：
   - 访问 https://github.com/settings/tokens/new
   - 勾选 `gist` 权限
   - 生成并复制 Token

2. **启用同步**：
   - 打开应用 → 设置 → 跨设备同步
   - 粘贴 Token，点击验证
   - 系统会自动创建私有 Gist 用于存储数据

3. **同步方式**：
   - 应用启动时自动拉取远程数据
   - 修改设置/书籍后 3 秒自动推送
   - 可手动点击"立即同步"按钮

### 数据同步范围

当前版本同步以下数据：
- 书籍列表（不含书籍全文内容）
- API 配置和预设
- 应用设置和外观偏好
- 用户人设和角色配置
- 世界书内容
- TTS 配置

## 与个人博客集成

如果你想在你的博客 `https://aning-q.github.io/` 中添加阅读应用入口，可以：

**选项 A：保持独立部署（推荐）**
- 访问地址：`https://aning-q.github.io/read-something/`
- 在你的博客中添加一个导航链接指向此地址

**选项 B：部署到博客子目录**
1. 修改 `vite.config.ts` 中的 `base` 为 `/reader/`
2. 构建后将 `dist` 内容复制到博客仓库的 `/reader` 目录下

## 注意事项

- Gist 同步功能仅同步元数据，书籍全文仍存储在浏览器本地
- Token 仅存储在浏览器本地，不会发送到任何第三方服务器
- 建议定期导出备份完整数据
