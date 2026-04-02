# 🚀 实例间认证克隆功能 - 使用指南

## ✅ 新增功能

已为 `playwright-mcp-parallel` 添加 **`instance_export_auth`** 工具，支持从已登录的实例中导出认证状态，无需外部 Chrome！

---

## 📖 使用方式

### 方案 1：从已登录实例导出认证（推荐）

**适用场景**：批量执行测试用例，只需登录一次

```javascript
// 1. 创建第一个实例并登录
instance_create({
  instanceId: "tc-001",
  url: "https://test-nexhub.netease.com/",
  cloneAuth: false  // 首次不克隆，需要手动登录
})

// 2. 执行登录操作
page_browser_fill({ instanceId: "tc-001", ref: "e29", value: "wangkouzhun@corp.netease.com" })
page_browser_fill({ instanceId: "tc-001", ref: "e35", value: "Ganyu123!" })
// ... 完成登录 ...

// 3. ✨ 导出认证状态（关键步骤）
instance_export_auth({ instanceId: "tc-001" })
// 输出: ✅ Auth exported from instance "tc-001"
//       🔐 Extracted: 12 cookies, 2 origins
//       Auth has been saved. New instances will inherit this login state.

// 4. 创建其他实例时自动克隆认证
instance_create({
  instanceId: "tc-002",
  url: "https://test-nexhub.netease.com/",
  cloneAuth: true  // 默认 true，自动继承 tc-001 的登录状态
})
// tc-002 已经登录，无需重复输入账号密码！

instance_create({
  instanceId: "tc-006",
  url: "https://test-nexhub.netease.com/",
  cloneAuth: true
})
// tc-006 也已登录！
```

---

### 方案 2：从外部 Chrome 导出认证（原有方式）

**适用场景**：需要可视化调试

```bash
# 1. 启动外部 Chrome（带调试端口）
chrome.exe --remote-debugging-port=9222

# 2. 手动登录一次
# 在打开的 Chrome 中访问 https://test-nexhub.netease.com/ 并登录

# 3. AI 调用 browser_connect 提取认证
browser_connect({ cdpUrl: "http://localhost:9222", pageIndex: 0 })

# 4. 所有后续实例自动克隆
instance_create({ instanceId: "tc-001", cloneAuth: true })
instance_create({ instanceId: "tc-002", cloneAuth: true })
```

---

## 🎯 实际应用效果

### 优化前（每个实例都登录）
```
tc-001: 登录(30s) → 执行TC(60s) = 90s
tc-002: 登录(30s) → 执行TC(60s) = 90s
tc-006: 登录(30s) → 执行TC(90s) = 120s
─────────────────────────────────────
总耗时: 300s
```

### 优化后（只登录一次）
```
tc-001: 登录(30s) → 导出认证(1s) → 执行TC(60s) = 91s
tc-002: 克隆认证(1s) → 执行TC(60s) = 61s
tc-006: 克隆认证(1s) → 执行TC(90s) = 91s
───────────────────────────────────────
总耗时: 243s  节省约 60s (20%)
```

---

## 📝 API 文档

### `instance_export_auth`

**描述**：从已登录实例导出认证状态（cookies + localStorage），其他实例创建时自动克隆

**参数**：
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `instanceId` | string | ✅ | 已登录实例的 ID |

**返回**：
```
✅ Auth exported from instance "tc-001"
🔐 Extracted: 12 cookies, 2 origins

Auth has been saved. New instances created with cloneAuth=true will automatically inherit this login state.
```

**错误处理**：
- 实例不存在：`Instance "xxx" not found.`
- 导出失败：`Failed to export auth: <error>`

---

### `instance_create`（已增强）

**描述**：创建独立浏览器实例，支持认证克隆

**参数变化**：
| 参数 | 旧说明 | 新说明 |
|------|--------|--------|
| `cloneAuth` | 从外部 Chrome 克隆认证 | 从已保存状态克隆认证（`browser_connect` 或 `instance_export_auth`） |

**示例**：
```javascript
// 不克隆（首个实例）
instance_create({ instanceId: "tc-001", cloneAuth: false })

// 克隆认证（默认）
instance_create({ instanceId: "tc-002" })  // cloneAuth 默认 true
```

---

## 🔧 注意事项

1. **调用顺序**：
   - 必须先创建至少一个实例并完成登录
   - 然后调用 `instance_export_auth` 导出认证
   - 最后创建其他实例时自动克隆

2. **认证状态覆盖**：
   - 多次调用 `instance_export_auth` 会覆盖之前保存的认证
   - 也可以先 `browser_connect`，再 `instance_export_auth`，以最后一次为准

3. **跨域限制**：
   - 认证状态按域名隔离
   - 如果测试不同域名的系统，需要分别导出认证

---

## 🎉 总结

这个功能解决了批量测试中最大的痛点：**重复登录**。通过实例间认证克隆，测试效率提升 **15-25%**！

**推荐工作流**：
1. 首个用例执行完整登录流程
2. 立即调用 `instance_export_auth` 保存认证
3. 后续用例直接克隆认证，跳过登录

🚀 享受更快的测试执行速度吧！
