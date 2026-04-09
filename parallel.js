#!/usr/bin/env node
/**
 * Parallel Browser MCP - Multi-instance wrapper around @playwright/mcp
 * 
 * Creates a MCP server that manages multiple isolated BrowserBackend instances.
 * Each tool call carries an `instanceId` parameter, dispatched to the right backend.
 * All original playwright-mcp tools are reused as-is.
 */

// Use only exported paths from playwright-core
const {
  filteredTools,
  BrowserBackend,
  createConnection,
  toMcpTool,
  start,
} = require('playwright-core/lib/tools/exports');
const mcpBundle = require('playwright-core/lib/mcpBundle');
const playwright = require('playwright-core');
const packageJSON = require('./package.json');
const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');

/**
 * Create a parallel MCP connection that supports multiple isolated browser instances.
 * 
 * All original @playwright/mcp tools are available, prefixed with `page_` and 
 * requiring an `instanceId` parameter to specify which instance to operate on.
 * 
 * @param {object} config - Resolved config (from resolveCLIConfig or resolveConfig)
 * @returns {import('@modelcontextprotocol/sdk/server/index.js').Server}
 */
function createParallelConnection(config) {
  const tools = filteredTools(config);

  const server = new mcpBundle.Server(
    { name: 'playwright-mcp-parallel', version: packageJSON.version },
    { capabilities: { tools: {} } }
  );

  // ── Instance Registry ──
  const instances = new Map();
  let authState = null;
  let connectedBrowser = null;
  let connectedCdpUrl = null;
  let connectedBrowserType = null;
  let clientInfo = { cwd: process.cwd() };

  // ── Build tool list ──
  server.setRequestHandler(mcpBundle.ListToolsRequestSchema, async () => {
    // Management tools
    const managementTools = [
      {
        name: 'browser_connect',
        description: [
          'Connect to an existing Chrome/Edge browser via CDP and extract auth cookies/localStorage.',
          'Chrome/Edge must be running with --remote-debugging-port.',
          '',
          '⚠️ IMPORTANT RULES — READ BEFORE USING:',
          '1. ALWAYS call browser_connect FIRST before doing anything. Try common ports: 9222, 9223, 9224.',
          '2. If connection SUCCEEDS → proceed immediately, do NOT restart Chrome.',
          '3. If connection FAILS with "ECONNREFUSED" → Chrome debug port is NOT open. Ask the user to start Chrome with the debug port; do NOT kill or restart any Chrome process.',
          '4. NEVER kill Chrome, NEVER run pkill/killall/taskkill on Chrome unless the user explicitly asks.',
          '5. If the result says "already connected" → skip and proceed, no action needed.',
        ].join('\n'),
        inputSchema: {
          type: 'object',
          properties: {
            cdpUrl: { type: 'string', description: 'Chrome CDP URL. Default: http://localhost:9222' },
            pageIndex: { type: 'number', description: 'Index of the page to extract auth from (0-based). Default: 0' },
          },
        },
      },
      {
        name: 'instance_create',
        description: 'Create a new isolated browser instance. Auth (cookies/localStorage) is automatically cloned from the connected Chrome/Edge if available. Each instance has fully isolated state and gets all standard browser_* tools.\n\nBy default (useCDP=true), creates a new BrowserContext inside the already-connected CDP browser. This preserves httpOnly cookies and SSO session — no re-login needed. Set useCDP=false to launch a completely separate browser process (full isolation, but httpOnly cookies cannot be transferred).',
        inputSchema: {
          type: 'object',
          properties: {
            instanceId: { type: 'string', description: 'Unique identifier for this instance (e.g. "task-1", "task-2")' },
            url: { type: 'string', description: 'URL to navigate to after creation' },
            cloneAuth: { type: 'boolean', description: 'Whether to clone auth from the connected Chrome. Default: true' },
            useCDP: { type: 'boolean', description: 'Whether to create context inside the connected CDP browser (true, default) or launch a new separate browser (false). CDP mode preserves httpOnly cookies/SSO session.' },
          },
          required: ['instanceId'],
        },
      },
      {
        name: 'instance_list',
        description: 'List all active browser instances with their current URLs.',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'instance_close',
        description: 'Close a specific browser instance and release its resources.',
        inputSchema: {
          type: 'object',
          properties: {
            instanceId: { type: 'string', description: 'Instance to close' },
          },
          required: ['instanceId'],
        },
      },
      {
        name: 'instance_close_all',
        description: 'Close all browser instances and release resources.',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'instance_export_auth',
        description: 'Export auth state (cookies/localStorage) from a specific instance or the connected Chrome. Useful for saving login state to reuse later.',
        inputSchema: {
          type: 'object',
          properties: {
            instanceId: { type: 'string', description: 'Instance ID to export auth from. If not provided, exports the auth state from browser_connect.' },
          },
        },
      },
    ];

    // Original tools with instanceId injected
    const parallelTools = tools.map(tool => {
      const mcpTool = toMcpTool(tool.schema);
      const newProperties = {
        instanceId: { type: 'string', description: 'Target browser instance ID' },
        ...(mcpTool.inputSchema.properties || {}),
      };
      const newRequired = ['instanceId', ...(mcpTool.inputSchema.required || [])];
      return {
        ...mcpTool,
        name: 'page_' + mcpTool.name,
        description: `[Parallel] ${mcpTool.description || ''} (operates on specified instance)`,
        inputSchema: {
          ...mcpTool.inputSchema,
          properties: newProperties,
          required: newRequired,
        },
      };
    });

    return { tools: [...managementTools, ...parallelTools] };
  });

  // ── Tool call handler ──
  server.setRequestHandler(mcpBundle.CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      // ── Management tools ──
      if (name === 'browser_connect') return await handleBrowserConnect(args);
      if (name === 'instance_create') return await handleInstanceCreate(args);
      if (name === 'instance_list') return await handleInstanceList();
      if (name === 'instance_close') return await handleInstanceClose(args);
      if (name === 'instance_close_all') return await handleInstanceCloseAll();
      if (name === 'instance_export_auth') return await handleInstanceExportAuth(args);

      // ── Parallel tool dispatch ──
      if (name.startsWith('page_')) {
        const originalName = name.slice(5);
        const instanceId = args?.instanceId;
        if (!instanceId) return errorResult('instanceId is required for parallel tools.');

        const entry = instances.get(instanceId);
        if (!entry) return errorResult(`Instance "${instanceId}" not found. Create it first with instance_create.`);

        // Remove instanceId before passing to original tool
        const toolArgs = { ...args };
        delete toolArgs.instanceId;

        return await entry.backend.callTool(originalName, toolArgs);
      }

      return errorResult(`Unknown tool: ${name}`);
    } catch (error) {
      return errorResult(`Error: ${error.message || error}`);
    }
  });

  // ── Helper: detect browser type from CDP ──
  async function detectBrowserType(cdpUrl) {
    try {
      const http = require('http');
      const versionUrl = cdpUrl.replace(/\/?$/, '/json/version');
      const data = await new Promise((resolve, reject) => {
        http.get(versionUrl, { timeout: 2000 }, res => {
          let body = '';
          res.on('data', chunk => body += chunk);
          res.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve({}); } });
        }).on('error', reject);
      });
      const ua = (data.Browser || data['User-Agent'] || '').toLowerCase();
      if (ua.includes('edg')) return 'Edge';
      if (ua.includes('chrome')) return 'Chrome';
      if (ua.includes('chromium')) return 'Chromium';
      return data.Browser || 'Browser';
    } catch { return 'Browser'; }
  }

  // ── Helper: auto-launch a debug browser ──
  async function autoLaunchDebugBrowser(port = 9222) {
    const debugDataDir = path.join(os.homedir(), '.playwright-mcp-debug-profile');
    try { fs.mkdirSync(debugDataDir, { recursive: true }); } catch {}

    const isWin = process.platform === 'win32';
    const isMac = process.platform === 'darwin';
    const candidates = [];
    if (isWin) {
      candidates.push(
        path.join(process.env['PROGRAMFILES'] || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(process.env['PROGRAMFILES'] || 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      );
    } else if (isMac) {
      candidates.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge');
    } else {
      candidates.push('google-chrome', 'google-chrome-stable', 'chromium-browser', 'microsoft-edge');
    }
    for (const exe of candidates) {
      try {
        if ((isWin || isMac) && !fs.existsSync(exe)) continue;
        const args = [`--remote-debugging-port=${port}`, `--user-data-dir=${debugDataDir}`, '--remote-allow-origins=*', '--no-first-run', '--no-default-browser-check'];
        const child = spawn(exe, args, { detached: true, stdio: 'ignore', windowsHide: false });
        child.unref();
        const cdpUrl = `http://localhost:${port}`;
        for (let attempt = 0; attempt < 15; attempt++) {
          await new Promise(r => setTimeout(r, 500));
          try {
            await playwright.chromium.connectOverCDP(cdpUrl, { timeout: 1000 }).then(b => b.close());
            const browserType = exe.toLowerCase().includes('edge') ? 'Edge' : 'Chrome';
            console.error(`[playwright-mcp-parallel] Auto-launched ${browserType} with debug port ${port}`);
            return { cdpUrl, childProcess: child, browserType };
          } catch { /* not ready */ }
        }
        try { child.kill(); } catch {}
      } catch { /* try next */ }
    }
    return null;
  }

  // ── Management tool implementations ──

  async function handleBrowserConnect(args) {
    const pageIndex = args?.pageIndex || 0;
    const explicitUrl = args?.cdpUrl;
    const urlsToTry = explicitUrl
      ? [explicitUrl]
      : ['http://localhost:9222', 'http://localhost:9223', 'http://localhost:9224'];

    // If already connected and still alive, skip reconnect
    if (connectedBrowser) {
      try {
        connectedBrowser.contexts();
        const displayUrl = connectedCdpUrl || '(previous session)';
        const displayType = connectedBrowserType || 'Browser';
        return textResult(
          `✅ Already connected to ${displayType} at ${displayUrl}.\n` +
          `Auth state is intact (${authState?.cookies?.length ?? 0} cookies).\n` +
          `No action needed — proceed with your task.`
        );
      } catch (_) {
        connectedBrowser = null;
        connectedCdpUrl = null;
        connectedBrowserType = null;
      }
    }

    // Try each candidate URL
    let lastError = null;
    for (const cdpUrl of urlsToTry) {
      try {
        const browser = await playwright.chromium.connectOverCDP(cdpUrl, { timeout: 3000 });
        const contexts = browser.contexts();
        if (contexts.length === 0) { await browser.close().catch(() => {}); continue; }
        const context = contexts[0];
        const pages = context.pages();
        if (pages.length === 0) { await browser.close().catch(() => {}); continue; }

        const browserType = await detectBrowserType(cdpUrl);
        connectedBrowser = browser;
        connectedCdpUrl = cdpUrl;
        connectedBrowserType = browserType;
        const targetPage = pages[Math.min(pageIndex, pages.length - 1)];
        const cookies = await context.cookies();

        const localStorageData = {};
        try {
          const origin = new URL(targetPage.url()).origin;
          const storage = await targetPage.evaluate(() => {
            const items = {};
            for (let i = 0; i < window.localStorage.length; i++) {
              const key = window.localStorage.key(i);
              if (key) items[key] = window.localStorage.getItem(key) || '';
            }
            return items;
          });
          localStorageData[origin] = storage;
        } catch (e) { /* ignore */ }

        authState = {
          cookies: cookies.map(c => ({
            name: c.name, value: c.value, domain: c.domain,
            path: c.path, expires: c.expires, httpOnly: c.httpOnly,
            secure: c.secure, sameSite: c.sameSite,
          })),
          origins: Object.entries(localStorageData).map(([origin, items]) => ({
            origin,
            localStorage: Object.entries(items).map(([name, value]) => ({ name, value })),
          })),
        };

        const httpOnlyCount = cookies.filter(c => c.httpOnly).length;
        return textResult(
          `✅ Connected to ${browserType} at ${cdpUrl}.\n` +
          `Extracted ${cookies.length} cookies (${httpOnlyCount} httpOnly).\n` +
          `New instances (useCDP=true) will share the same browser session including httpOnly cookies.\n` +
          `⚠️ Do NOT kill or restart ${browserType} — it is already running correctly.`
        );
      } catch (err) {
        lastError = err;
      }
    }

    // All attempts failed — try auto-launch
    const isConnRefused = lastError?.message?.includes('ECONNREFUSED') || lastError?.message?.includes('connect');
    const portList = urlsToTry.join(', ');

    if (isConnRefused) {
      console.error(`[playwright-mcp-parallel] No debug port found (tried: ${portList}). Attempting auto-launch...`);
      const launchResult = await autoLaunchDebugBrowser(9222);

      if (launchResult) {
        try {
          const browser = await playwright.chromium.connectOverCDP(launchResult.cdpUrl, { timeout: 5000 });
          const contexts = browser.contexts();
          let context;
          if (contexts.length === 0) {
            context = await browser.newContext();
            await (await context.newPage()).goto('about:blank');
          } else {
            context = contexts[0];
          }
          connectedBrowser = browser;
          connectedCdpUrl = launchResult.cdpUrl;
          connectedBrowserType = launchResult.browserType;
          const cookies = await context.cookies();
          authState = { cookies: cookies.map(c => ({ name: c.name, value: c.value, domain: c.domain, path: c.path, expires: c.expires, httpOnly: c.httpOnly, secure: c.secure, sameSite: c.sameSite })), origins: [] };

          return textResult(
            `✅ Auto-launched ${launchResult.browserType} with debug port 9222.\n` +
            `Connected at ${launchResult.cdpUrl}.\n` +
            `⚠️ This is a NEW browser profile (no existing login state).\n` +
            `   Profile: ${path.join(os.homedir(), '.playwright-mcp-debug-profile')}\n` +
            `   User's existing browser is NOT affected.`
          );
        } catch (connectErr) {
          return errorResult(`❌ Auto-launched browser but failed to connect: ${connectErr.message}\n\n⚠️ Do NOT kill user's existing Chrome/Edge.`);
        }
      }

      return errorResult(
        `❌ No debug port found (tried: ${portList}) and auto-launch failed.\n\n` +
        `Please start a browser with debug port manually:\n` +
        `  Windows: start chrome.exe --remote-debugging-port=9222 --user-data-dir="%USERPROFILE%\\.playwright-mcp-debug-profile"\n` +
        `  Mac:     open -a "Google Chrome" --args --remote-debugging-port=9222 --user-data-dir="$HOME/.playwright-mcp-debug-profile"\n\n` +
        `⚠️ Do NOT kill user's existing Chrome/Edge.`
      );
    }

    return errorResult(
      `❌ Failed to connect (tried: ${portList}).\nError: ${lastError?.message}\n\n⚠️ Do NOT kill Chrome/Edge.`
    );
  }

  async function handleInstanceCreate(args) {
    const instanceId = args?.instanceId;
    if (!instanceId) return errorResult('instanceId is required.');
    if (instances.has(instanceId)) return errorResult(`Instance "${instanceId}" already exists.`);

    const cloneAuth = args?.cloneAuth !== false;
    const url = args?.url;
    const useCDP = args?.useCDP !== false && !!connectedBrowser;

    let browser, browserContext, mode;

    if (useCDP && connectedBrowser) {
      // ── CDP mode: new BrowserContext inside connected browser ──
      try { connectedBrowser.contexts(); } catch (_) {
        connectedBrowser = null; connectedCdpUrl = null; connectedBrowserType = null;
        return errorResult('CDP browser is no longer available. Call browser_connect first.');
      }
      browser = connectedBrowser;
      const contextOptions = { ...(config.browser?.contextOptions || {}) };
      if (cloneAuth && authState) { contextOptions.storageState = authState; }
      browserContext = await browser.newContext({ ...contextOptions, viewport: null });
      mode = 'cdp';
    } else {
      // ── Launch mode: new browser process ──
      const contextOptions = { ...(config.browser?.contextOptions || {}) };
      if (cloneAuth && authState) { contextOptions.storageState = authState; }
      const browserName = config.browser?.browserName || 'chromium';
      const isHeadless = config.browser?.launchOptions?.headless ?? false;
      const extraArgs = isHeadless ? [] : ['--start-maximized'];
      browser = await playwright[browserName].launch({
        ...(config.browser?.launchOptions || {}), headless: isHeadless,
        args: [...((config.browser?.launchOptions?.args) || []), ...extraArgs],
        handleSIGINT: false, handleSIGTERM: false,
      });
      browserContext = await browser.newContext({
        ...contextOptions,
        viewport: isHeadless ? (contextOptions.viewport ?? { width: 1920, height: 1080 }) : null,
      });
      mode = 'launch';
    }

    const backend = new BrowserBackend(config, browserContext, tools);
    await backend.initialize(clientInfo);
    instances.set(instanceId, { backend, browser, browserContext, mode });

    if (url) { await backend.callTool('browser_navigate', { url }); }

    const browserTypeLabel = connectedBrowserType || 'Chromium';
    return textResult(
      `Instance "${instanceId}" created (mode: ${mode}).\n` +
      (mode === 'cdp'
        ? `Using connected ${browserTypeLabel} — httpOnly cookies and SSO session are preserved.\n`
        : `Launched new isolated browser — httpOnly cookies NOT transferred.\n`) +
      (url ? `Navigated to: ${url}\n` : '') +
      `Auth cloned: ${cloneAuth && !!authState}\n` +
      `Total instances: ${instances.size}`
    );
  }

  async function handleInstanceList() {
    if (instances.size === 0) return textResult('No active instances.');

    const lines = [];
    for (const [id, entry] of instances) {
      let url = 'about:blank', title = '';
      try {
        const pages = entry.browserContext.pages();
        if (pages.length > 0) {
          url = pages[0].url();
          title = await pages[0].title();
        }
      } catch (e) { /* ignore */ }
      lines.push(`• ${id}: ${title} (${url})`);
    }
    return textResult(`Active instances (${instances.size}):\n${lines.join('\n')}`);
  }

  async function handleInstanceClose(args) {
    const instanceId = args?.instanceId;
    if (!instanceId) return errorResult('instanceId is required.');

    const entry = instances.get(instanceId);
    if (!entry) return errorResult(`Instance "${instanceId}" not found.`);

    try {
      await entry.backend.dispose?.();
      await entry.browserContext.close().catch(() => {});
      // Only close the browser process if it was launched by us (not a shared CDP connection)
      if (entry.mode !== 'cdp') {
        await entry.browser.close().catch(() => {});
      }
    } catch (e) { /* ignore */ }

    instances.delete(instanceId);
    return textResult(`Instance "${instanceId}" closed (was ${entry.mode || 'launch'} mode). Remaining: ${instances.size}`);
  }

  async function handleInstanceCloseAll() {
    const count = instances.size;
    const ids = [...instances.keys()];
    for (const id of ids) {
      await handleInstanceClose({ instanceId: id });
    }
    return textResult(`Closed ${count} instance(s).`);
  }

  async function handleInstanceExportAuth(args) {
    const instanceId = args?.instanceId;

    // Export from a specific instance
    if (instanceId) {
      const entry = instances.get(instanceId);
      if (!entry) return errorResult(`Instance "${instanceId}" not found.`);

      try {
        const cookies = await entry.browserContext.cookies();
        const pages = entry.browserContext.pages();
        const localStorageData = {};

        for (const page of pages) {
          try {
            const origin = new URL(page.url()).origin;
            if (origin === 'null' || !origin) continue;
            const storage = await page.evaluate(() => {
              const items = {};
              for (let i = 0; i < window.localStorage.length; i++) {
                const key = window.localStorage.key(i);
                if (key) items[key] = window.localStorage.getItem(key) || '';
              }
              return items;
            });
            if (Object.keys(storage).length > 0) localStorageData[origin] = storage;
          } catch (e) { /* ignore */ }
        }

        const exportedAuth = {
          cookies: cookies.map(c => ({
            name: c.name, value: c.value, domain: c.domain,
            path: c.path, expires: c.expires, httpOnly: c.httpOnly,
            secure: c.secure, sameSite: c.sameSite,
          })),
          origins: Object.entries(localStorageData).map(([origin, items]) => ({
            origin,
            localStorage: Object.entries(items).map(([name, value]) => ({ name, value })),
          })),
        };

        // Also update the global authState so new instances can inherit it
        authState = exportedAuth;

        return textResult(
          `Auth exported from instance "${instanceId}".\n` +
          `Cookies: ${exportedAuth.cookies.length}\n` +
          `localStorage origins: ${exportedAuth.origins.length}\n\n` +
          `Auth state updated globally — new instances will inherit this auth.\n\n` +
          `\`\`\`json\n${JSON.stringify(exportedAuth, null, 2)}\n\`\`\``
        );
      } catch (error) {
        return errorResult(`Failed to export auth from instance "${instanceId}": ${error.message}`);
      }
    }

    // Export from browser_connect auth state
    if (!authState) {
      return errorResult('No auth state available. Run browser_connect first, or provide an instanceId.');
    }

    return textResult(
      `Auth state from browser_connect:\n` +
      `Cookies: ${authState.cookies.length}\n` +
      `localStorage origins: ${authState.origins.length}\n\n` +
      `\`\`\`json\n${JSON.stringify(authState, null, 2)}\n\`\`\``
    );
  }

  // ── Cleanup ──
  process.on('SIGINT', async () => {
    await handleInstanceCloseAll();
    if (connectedBrowser) connectedBrowser.close().catch(() => {});
    process.exit(0);
  });

  return server;
}

// ── Helpers ──
function textResult(text) {
  return { content: [{ type: 'text', text }] };
}

function errorResult(text) {
  return { content: [{ type: 'text', text: `### Error\n${text}` }], isError: true };
}

module.exports = { createParallelConnection };