# 版本更新提示功能

## 概述

为 Grove 的 Web 和 GUI 界面添加了版本更新检测和提示功能，与 TUI 的更新检测逻辑保持一致。

## 实现架构

```
┌──────────────────────────────────────────────────────────────┐
│  TUI (已有)                                                   │
│  - src/update/mod.rs: 核心检测逻辑                            │
│  - 24小时缓存机制                                             │
│  - GitHub API 检测最新版本                                    │
└────────────────────┬─────────────────────────────────────────┘
                     │
                     ├─────> 后端 API
                     │       src/api/handlers/update.rs
                     │       GET /api/v1/update-check
                     │
                     └─────> 前端组件
                             grove-web/src/components/ui/UpdateBanner.tsx
                             ├─ 自动检测更新
                             ├─ 顶部横幅提示
                             ├─ 查看发布说明
                             └─ 复制更新命令
```

## 新增文件

### 后端

1. **`src/api/handlers/update.rs`** - 更新检测 API Handler
   - 端点：`GET /api/v1/update-check`
   - 复用 TUI 的更新检测逻辑
   - 使用 24 小时缓存避免频繁请求
   - 返回更新信息和更新命令

2. **修改文件**：
   - `src/api/handlers/mod.rs` - 注册 update 模块
   - `src/api/mod.rs` - 添加 `/update-check` 路由

### 前端

1. **`grove-web/src/components/ui/UpdateBanner.tsx`** - 更新提示横幅
   - 在 App 启动时自动检查更新
   - 固定在页面顶部的彩色横幅
   - 功能按钮：
     - **View Release**: 跳转到 GitHub Releases 页面
     - **Copy Command**: 复制更新命令到剪贴板
     - **关闭按钮**: 在当前会话中隐藏（使用 sessionStorage）

2. **修改文件**：
   - `grove-web/src/api/version.ts` - 添加 `checkUpdate()` API 调用
   - `grove-web/src/api/index.ts` - 导出更新相关类型和函数
   - `grove-web/src/App.tsx` - 集成 UpdateBanner 组件

## API 响应格式

```typescript
{
  current_version: string;        // 当前版本 (如 "0.4.11")
  latest_version: string | null;  // 最新版本 (如 "0.5.0")
  has_update: boolean;            // 是否有更新
  install_method: string;         // 安装方式 (CargoInstall/Homebrew/GitHubRelease)
  update_command: string;         // 更新命令 (如 "cargo install grove-rs")
  check_time: string | null;      // 检查时间 (RFC 3339 格式)
}
```

## 特性

### 1. 智能缓存
- 24 小时内不会重复检查
- 缓存存储在 `~/.grove/config.toml` 中
- 避免频繁请求 GitHub API

### 2. 用户体验
- **非侵入式**: 横幅固定在顶部，不遮挡内容
- **会话级别关闭**: 关闭后在当前浏览器会话中不再显示
- **自动检测**: 页面加载时自动检查更新
- **平滑动画**: 滑入动画，视觉效果友好

### 3. 跨平台支持
- 自动检测安装方式（Cargo/Homebrew/GitHub Release）
- 提供对应的更新命令
- 支持 Web 和 GUI 两种界面

## 使用示例

### 用户视角

1. **打开 Grove Web**:
   ```bash
   grove web
   ```

2. **如果有新版本**:
   - 顶部会显示高亮横幅
   - 显示：`New version available: 0.5.0`
   - 当前版本：`Current: 0.4.11`
   - 更新命令：`Run: cargo install grove-rs`

3. **用户操作**:
   - 点击 "View Release" 查看更新日志
   - 点击 "Copy Command" 复制更新命令
   - 点击 ✕ 关闭提示（会话级别）

### 开发者视角

#### 后端调用示例

```bash
# 检查更新
curl http://localhost:9527/api/v1/update-check
```

#### 前端使用示例

```typescript
import { checkUpdate } from "./api";

// 检查更新
const updateInfo = await checkUpdate();

if (updateInfo.has_update) {
  console.log(`New version: ${updateInfo.latest_version}`);
  console.log(`Update command: ${updateInfo.update_command}`);
}
```

## 配置

更新检测的缓存数据存储在 `~/.grove/config.toml`:

```toml
[update]
last_check = "2026-02-11T17:30:00Z"
latest_version = "0.5.0"
```

## 样式定制

UpdateBanner 使用 CSS 变量，可以通过主题配置调整：

```css
--color-highlight  /* 横幅背景色 */
--color-bg         /* 按钮文字色 */
```

## 未来改进

1. **可配置检查频率**: 允许用户在设置中调整检查间隔
2. **自动更新**: 集成自动更新功能（特定安装方式）
3. **更新日志预览**: 在横幅中直接显示更新摘要
4. **通知中心**: 将更新提示集成到统一的通知系统中

## 测试

### 手动测试

1. **测试有更新的情况**:
   - 修改 `Cargo.toml` 中的版本号为旧版本（如 0.1.0）
   - 运行 `grove web`
   - 应该看到更新横幅

2. **测试缓存**:
   - 第一次访问会检查更新
   - 刷新页面，查看 Network 请求是否使用缓存

3. **测试关闭功能**:
   - 点击 ✕ 关闭横幅
   - 刷新页面，横幅不应该再出现
   - 重新打开浏览器（新会话），横幅应该再次出现

### API 测试

```bash
# 启动服务
grove web

# 测试 API
curl http://localhost:9527/api/v1/update-check | jq
```

## 相关文件

### 核心文件
- `src/update/mod.rs` - 更新检测核心逻辑
- `src/api/handlers/update.rs` - API Handler
- `grove-web/src/components/ui/UpdateBanner.tsx` - 前端组件

### 配置文件
- `~/.grove/config.toml` - 缓存更新信息

### 测试文件
- `src/update/mod.rs` (tests module) - 后端测试

## 常见问题

**Q: 为什么横幅关闭后刷新又出现了？**
A: 横幅使用 sessionStorage 存储关闭状态，关闭浏览器后会重置。这样可以在新会话中再次提醒用户。

**Q: 可以完全禁用更新检查吗？**
A: 目前不支持。未来可以在设置中添加开关。

**Q: GitHub API 有速率限制吗？**
A: 有，匿名请求限制为 60 次/小时。Grove 通过 24 小时缓存大大降低了请求频率。

**Q: 为什么我看不到更新横幅？**
A: 可能原因：
  1. 当前版本已经是最新版
  2. 网络问题导致无法访问 GitHub API
  3. 在会话中已经关闭过横幅
