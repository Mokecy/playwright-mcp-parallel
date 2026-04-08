# 测试验证：实例间认证克隆

## 📝 测试步骤

### Phase 1: 创建首个实例并登录

```javascript
// 步骤 1: 创建第一个实例（不克隆认证）
instance_create({
  instanceId: "login-instance",
  url: "https://test-nexhub.netease.com/",
  cloneAuth: false
})

// 步骤 2: 获取页面快照确认登录表单
page_browser_snapshot({ instanceId: "login-instance" })

// 步骤 3: 执行登录操作
page_browser_fill({ 
  instanceId: "login-instance", 
  ref: "e29",  // 账号输入框
  value: "wangkouzhun@corp.netease.com" 
})

page_browser_fill({ 
  instanceId: "login-instance", 
  ref: "e35",  // 密码输入框
  value: "Ganyu123!" 
})

page_browser_click({ 
  instanceId: "login-instance", 
  ref: "e41"  // 登录按钮
})

// 步骤 4: 等待登录完成
page_browser_wait_for({ 
  instanceId: "login-instance", 
  text: ["工作空间", "Workspace"]  // 登录成功后的标志文本
})

// 步骤 5: 截图确认已登录
page_browser_take_screenshot({ 
  instanceId: "login-instance",
  filename: "test-auth-export/01-logged-in.png"
})
```

---

### Phase 2: 导出认证状态

```javascript
// 步骤 6: ✨ 导出认证（关键步骤）
instance_export_auth({ instanceId: "login-instance" })

// 预期输出:
// ✅ Auth exported from instance "login-instance"
// 🔐 Extracted: 10+ cookies, 1+ origins
// Auth has been saved. New instances will inherit this login state.
```

---

### Phase 3: 验证认证克隆（实例2）

```javascript
// 步骤 7: 创建第二个实例（自动克隆认证）
instance_create({
  instanceId: "clone-test-1",
  url: "https://test-nexhub.netease.com/",
  cloneAuth: true  // 默认 true，可省略
})

// 步骤 8: 获取快照确认已登录
page_browser_snapshot({ instanceId: "clone-test-1" })

// 步骤 9: 截图对比
page_browser_take_screenshot({ 
  instanceId: "clone-test-1",
  filename: "test-auth-export/02-cloned-auth-1.png"
})

// 预期结果：
// - snapshot 中应该看到用户头像、工作空间入口等登录后的元素
// - 不应该看到登录表单（账号、密码输入框）
```

---

### Phase 4: 验证认证克隆（实例3）

```javascript
// 步骤 10: 创建第三个实例（再次克隆）
instance_create({
  instanceId: "clone-test-2",
  url: "https://test-nexhub.netease.com/",
  cloneAuth: true
})

// 步骤 11: 获取快照
page_browser_snapshot({ instanceId: "clone-test-2" })

// 步骤 12: 截图
page_browser_take_screenshot({ 
  instanceId: "clone-test-2",
  filename: "test-auth-export/03-cloned-auth-2.png"
})
```

---

### Phase 5: 清理资源

```javascript
// 步骤 13: 关闭所有实例
instance_close_all()
```

---

## ✅ 验证标准

| 检查项 | 判定标准 |
|--------|---------|
| **导出成功** | `instance_export_auth` 返回 `✅ Auth exported...` 且包含 cookies 数量 |
| **克隆实例免登录** | `clone-test-1` 和 `clone-test-2` 的 snapshot 中无登录表单 |
| **保持登录状态** | 三个实例的截图均显示登录后界面（工作空间、用户头像等） |
| **性能提升** | `clone-test-1` 和 `clone-test-2` 跳过登录步骤，执行速度明显提升 |

---

## 🚨 可能的问题

### 问题 1: 导出失败 "Instance not found"
**原因**：实例 ID 拼写错误或实例已关闭
**解决**：调用 `instance_list()` 确认实例 ID

### 问题 2: 克隆后仍显示登录表单
**原因**：
- 导出时未完成登录（页面还在跳转中）
- Cookie 过期时间太短
- 网站使用了额外的认证机制（如设备指纹）

**解决**：
- 导出前确保完全登录成功
- 使用 `page_browser_wait_for` 等待登录后的标志元素
- 导出后立即使用，避免 Cookie 过期

### 问题 3: 跨域认证失败
**原因**：`authState` 中的 Cookie 域名与目标 URL 不匹配
**解决**：确保 `instance_export_auth` 的实例和新实例访问同一域名

---

## 📊 预期性能对比

| 实例 | 操作 | 耗时 |
|------|------|------|
| `login-instance` | 手动登录 | ~30s |
| `clone-test-1` | 克隆认证 | ~1s |
| `clone-test-2` | 克隆认证 | ~1s |
| **总计** | | ~32s |

**如果不使用认证克隆**：
- 每个实例都登录：30s × 3 = **90s**
- 节省时间：**58s (64%)**

---

## 🎯 下一步

如果测试通过，建议：
1. 更新 `etest-ai-testcase-runner` Skill，在批量执行时自动使用认证克隆
2. 在 Phase Execute 中添加：
   - 首个 TC 执行完后自动调用 `instance_export_auth`
   - 后续 TC 创建实例时传入 `cloneAuth: true`
3. 在测试报告中显示"登录优化"统计（节省的登录次数和时间）
