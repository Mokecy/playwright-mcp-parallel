# mcp-browser-parallel

一个支持**并行多浏览器实例**的 MCP (Model Context Protocol) 服务器。

## 核心理念

传统的 Playwright MCP 只能控制单个浏览器窗口。`mcp-browser-parallel` 允许 AI 同时创建和控制**多个独立的浏览器实例**，每个实例有自己的 cookies、localStorage 和页面状态，从而实现真正的并行浏览器自动化。

## 功能特性

- 🔗 **连接已有浏览器** - 通过 CDP 连接正在运行的 Chrome，自动提取认证状态
- 🔀 **多实例并行** - 创建多个完全隔离的浏览器实例，各自独立操作
- 🔐 **认证克隆** - 新实例自动继承已连接浏览器的 cookies/localStorage，无需重新登录
- 📸 **快照与截图** - 对每个实例独立获取页面快照或截图
- 🖱️ **全功能交互** - 点击、填写、拖拽、键盘操作等完整的页面交互能力
- 🔍 **验证与调试** - 文本可见性验证、元素检查、Trace 录制等

## 安装

```bash
cd packages/mcp-browser-parallel
npm install
npm run build
```

## 使用方式

### 1. stdio 模式（默认）

```bash
node dist/cli.js
```

### 2. SSE/HTTP 模式

```bash
node dist/cli.js --port 3001
```

### 3. 在 MCP 客户端配置

**Claude Desktop / Cursor / CodeMaker 配置示例：**

```json
{
  "mcpServers": {
    "mcp-browser-parallel": {
      "command": "node",
      "args": ["path/to/packages/mcp-browser-parallel/dist/cli.js"]
    }
  }
}
```

## 工作流程

### 基本并行操作流程

```
1. browser_connect        → 连接已有 Chrome，提取认证状态
2. instance_create "a"    → 创建实例 A（自动克隆认证）
3. instance_create "b"    → 创建实例 B（自动克隆认证）
4. page_navigate "a" url1 → 实例 A 导航到页面 1
5. page_navigate "b" url2 → 实例 B 导航到页面 2
6. page_snapshot "a"      → 获取实例 A 的快照
7. page_snapshot "b"      → 获取实例 B 的快照
8. page_click "a" "e5"    → 在实例 A 点击元素
9. page_fill "b" "e3" ... → 在实例 B 填写表单
10. instance_close_all    → 关闭所有实例
```

### 无需 Chrome 连接的独立模式

```
1. instance_create "worker-1"  → 直接创建新浏览器实例
2. page_navigate "worker-1" url → 导航到目标页面
3. ... 执行操作 ...
4. instance_close "worker-1"    → 关闭实例
```

## 工具列表

### 连接管理
| 工具 | 说明 |
|------|------|
| `browser_connect` | 连接已有的 Chrome 浏览器（通过 CDP） |

### 实例管理
| 工具 | 说明 |
|------|------|
| `instance_create` | 创建新的隔离浏览器实例 |
| `instance_list` | 列出所有活跃实例 |
| `instance_close` | 关闭指定实例 |
| `instance_close_all` | 关闭所有实例 |

### 页面导航
| 工具 | 说明 |
|------|------|
| `page_navigate` | 导航到 URL |
| `page_navigate_back` | 后退 |

### 页面观察
| 工具 | 说明 |
|------|------|
| `page_snapshot` | 获取无障碍树快照（含交互元素 ref） |
| `page_screenshot` | 截图 |

### 页面交互
| 工具 | 说明 |
|------|------|
| `page_click` | 点击元素 |
| `page_fill` | 填写输入框 |
| `page_type` | 键入文本 |
| `page_select_option` | 选择下拉选项 |
| `page_hover` | 悬停 |
| `page_press_key` | 按键 |
| `page_drag` | 拖拽 |
| `page_file_upload` | 上传文件 |
| `page_fill_form` | 批量填写表单 |

### 等待与执行
| 工具 | 说明 |
|------|------|
| `page_wait` | 等待文本出现/消失/固定时间 |
| `page_evaluate` | 执行 JavaScript |
| `page_run_code` | 运行 Playwright 代码片段 |

### 窗口与对话框
| 工具 | 说明 |
|------|------|
| `page_maximize` | 最大化窗口 |
| `page_resize` | 调整视口大小 |
| `page_handle_dialog` | 处理对话框 |

### 坐标操作
| 工具 | 说明 |
|------|------|
| `page_mouse_click_xy` | 坐标点击 |
| `page_mouse_move_xy` | 移动鼠标 |
| `page_mouse_drag_xy` | 坐标拖拽 |

### 调试与验证
| 工具 | 说明 |
|------|------|
| `page_console_messages` | 获取控制台消息 |
| `page_network_requests` | 获取网络请求 |
| `page_verify_text_visible` | 验证文本可见 |
| `page_verify_element_visible` | 验证元素可见 |
| `page_verify_value` | 验证表单值 |
| `page_generate_locator` | 生成 Playwright 定位器 |
| `page_start_tracing` | 开始 Trace 录制 |
| `page_stop_tracing` | 停止 Trace 录制 |
| `page_pdf_save` | 保存为 PDF |

## 连接 Chrome

启动 Chrome 时开启远程调试端口：

```bash
# Windows
"C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222

# macOS
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --remote-debugging-port=9222

# Linux
google-chrome --remote-debugging-port=9222
```

## License

Apache-2.0
