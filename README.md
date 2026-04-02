# playwright-mcp-parallel

[![npm version](https://img.shields.io/npm/v/playwright-mcp-parallel.svg)](https://www.npmjs.com/package/playwright-mcp-parallel)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

> **Drop-in parallel enhancement over [@playwright/mcp](https://github.com/microsoft/playwright-mcp)**  
> Run multiple isolated browser instances simultaneously, each with its own context, auth, and state.

---

## Why playwright-mcp-parallel?

Standard `@playwright/mcp` supports only **one browser instance** per server. This package extends it to support **N parallel instances**, enabling:

- 🔀 **Parallel task execution** — Run multiple browser tasks at the same time
- 🔐 **Auth cloning** — Clone cookies/localStorage from your logged-in Chrome to all new instances
- 🧩 **Isolated contexts** — Each instance has fully independent state
- 🔌 **Drop-in compatible** — All original `@playwright/mcp` tools available via `page_*` prefix

---

## Installation & Setup

### Claude Desktop / Cursor / VS Code / Any MCP client

```json
{
  "mcpServers": {
    "playwright-parallel": {
      "command": "npx",
      "args": [
        "playwright-mcp-parallel@latest"
      ]
    }
  }
}
```

### With options (headless, etc.)

```json
{
  "mcpServers": {
    "playwright-parallel": {
      "command": "npx",
      "args": [
        "playwright-mcp-parallel@latest",
        "--headless"
      ]
    }
  }
}
```

---

## Tools Reference

### 🔌 Connection & Auth

| Tool | Description |
|------|-------------|
| `browser_connect` | Connect to an existing Chrome via CDP and extract auth (cookies + localStorage). Chrome must be started with `--remote-debugging-port=9222`. |
| `instance_export_auth` | Export auth state from a specific instance (or the connected Chrome). Updates global auth so new instances will inherit it. |

### 🖥️ Instance Management

| Tool | Description |
|------|-------------|
| `instance_create` | Create a new isolated browser instance. Optionally auto-clone auth from connected Chrome. |
| `instance_list` | List all active instances with their current URLs and titles. |
| `instance_close` | Close a specific instance and release its resources. |
| `instance_close_all` | Close all instances at once. |

### 🌐 Browser Tools (All Original @playwright/mcp tools)

All tools from `@playwright/mcp` are available with a `page_` prefix and require an `instanceId` parameter:

| Tool | Description |
|------|-------------|
| `page_browser_navigate` | Navigate an instance to a URL |
| `page_browser_click` | Click an element in an instance |
| `page_browser_type` | Type text into an element |
| `page_browser_screenshot` | Take a screenshot of an instance |
| `page_browser_snapshot` | Get accessibility snapshot of an instance |
| `page_browser_evaluate` | Execute JavaScript in an instance |
| `page_browser_wait_for` | Wait for a condition in an instance |
| ... | All other `@playwright/mcp` tools with `page_` prefix |

---

## Usage Examples

### Typical Workflow: Auth Cloning + Parallel Tasks

```
1. Start Chrome with debugging:
   chrome.exe --remote-debugging-port=9222

2. Log in manually in Chrome

3. In your AI agent:
   → browser_connect()                          # Extract auth from Chrome
   → instance_create({ instanceId: "task-1", url: "https://app.example.com" })
   → instance_create({ instanceId: "task-2", url: "https://app.example.com" })
   → (Both instances are logged in automatically!)

4. Run tasks in parallel:
   → page_browser_click({ instanceId: "task-1", ... })
   → page_browser_click({ instanceId: "task-2", ... })

5. Export auth from a running instance (e.g., after login flow):
   → instance_export_auth({ instanceId: "task-1" })
   → instance_create({ instanceId: "task-3" })  # Also logged in
```

### Export Auth from Instance

```
→ instance_create({ instanceId: "login-bot", url: "https://example.com/login" })
→ page_browser_click({ instanceId: "login-bot", ... })   # complete login
→ instance_export_auth({ instanceId: "login-bot" })      # export & set as global auth
→ instance_create({ instanceId: "worker-1" })            # inherits login state
→ instance_create({ instanceId: "worker-2" })            # inherits login state
```

---

## CLI Options

All `@playwright/mcp` CLI options are supported:

```bash
npx playwright-mcp-parallel@latest [options]
```

| Option | Description |
|--------|-------------|
| `--headless` | Run browser in headless mode |
| `--browser <browser>` | Browser to use: `chrome`, `firefox`, `webkit`, `msedge` |
| `--viewport-size <size>` | Viewport size, e.g. `1280x720` |
| `--user-data-dir <path>` | Path to user data directory |
| `--storage-state <path>` | Path to storage state JSON file |
| `--proxy-server <proxy>` | Proxy server, e.g. `http://myproxy:3128` |
| `--no-sandbox` | Disable sandbox |
| `--port <port>` | Port for SSE transport |
| `--isolated` | Keep browser profile in memory only |

For the full list of options, see [@playwright/mcp documentation](https://github.com/microsoft/playwright-mcp#configuration).

---

## How It Works

```
playwright-mcp-parallel
├── Management Layer
│   ├── browser_connect      → Extract auth from existing Chrome
│   ├── instance_create      → Launch isolated browser + clone auth
│   ├── instance_list        → List active instances
│   ├── instance_close       → Dispose instance
│   ├── instance_close_all   → Dispose all
│   └── instance_export_auth → Export cookies/localStorage from instance
│
└── Per-Instance Tool Dispatch
    └── page_* tools → routed to the correct BrowserBackend by instanceId
```

Each `instance_create` call launches a **new Chromium process** with an isolated context. Auth state (cookies + localStorage) extracted via `browser_connect` or `instance_export_auth` is automatically injected into new contexts.

---

## Differences from @playwright/mcp

| Feature | @playwright/mcp | playwright-mcp-parallel |
|---------|----------------|------------------------|
| Browser instances | 1 | Unlimited |
| Parallel execution | ❌ | ✅ |
| Auth cloning | ❌ | ✅ |
| Auth export | ❌ | ✅ |
| Original tools | ✅ | ✅ (via `page_` prefix) |
| Drop-in config | ✅ | ✅ |

---

## Requirements

- Node.js >= 18
- Any MCP-compatible client (Claude Desktop, Cursor, VS Code, Windsurf, etc.)

---

## License

Apache-2.0 — based on [@playwright/mcp](https://github.com/microsoft/playwright-mcp) by Microsoft.