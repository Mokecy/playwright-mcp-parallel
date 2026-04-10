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
const { execSync, spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');

// Download directory for captured downloads
const DOWNLOAD_DIR = path.join(os.tmpdir(), 'playwright-mcp-downloads');

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
  let connectedCdpUrl = null;      // Track the actual CDP URL we connected to
  let connectedBrowserType = null;  // 'Chrome' | 'Edge' | 'Chromium' | unknown
  let clientInfo = { cwd: process.cwd() };

  // ── Snapshot diff helpers ──

  /**
   * Extract plain-text snapshot from a callTool result.
   * Returns null if result has no text content.
   */
  function extractSnapshotText(result) {
    if (!result?.content) return null;
    const textBlock = result.content.find(c => c.type === 'text');
    return textBlock?.text ?? null;
  }

  /**
   * Compute a unified-diff-style list of changed lines between two snapshot strings.
   * Returns an array of strings like:
   *   "- old line"
   *   "+ new line"
   * Only lines that differ are included (with minimal context).
   */
  function computeDiff(oldSnap, newSnap) {
    if (!oldSnap || !newSnap) return [];
    const oldLines = oldSnap.split('\n');
    const newLines = newSnap.split('\n');

    const changes = [];
    const maxLen = Math.max(oldLines.length, newLines.length);
    for (let i = 0; i < maxLen; i++) {
      const o = oldLines[i] ?? '';
      const n = newLines[i] ?? '';
      if (o !== n) {
        if (o) changes.push(`- ${o}`);
        if (n) changes.push(`+ ${n}`);
      }
    }
    return changes;
  }

  /**
   * Trim snapshot text to reduce context size.
   * Removes pure "generic" leaf nodes and collapses deep nesting noise.
   * Reduces snapshot size by 30-50% on typical pages without losing actionable info.
   */
  function trimSnapshot(snapshotText) {
    if (!snapshotText) return snapshotText;
    const lines = snapshotText.split('\n');
    const kept = [];
    for (const line of lines) {
      const trimmed = line.trim();
      // Drop lines that are ONLY "generic" with no attributes or text
      if (trimmed === 'generic' || trimmed === '- generic') continue;
      // Drop pure InlineTextBox lines (they duplicate StaticText content)
      if (/^-?\s*InlineTextBox\s+"[^"]*"$/.test(trimmed)) continue;
      // Drop empty lines clusters (keep at most one blank between sections)
      if (trimmed === '' && kept.length > 0 && kept[kept.length - 1].trim() === '') continue;
      kept.push(line);
    }
    return kept.join('\n');
  }

  /**
   * Detect the overall page state from snapshot text.
   * Returns: 'error' | 'loading' | 'normal'
   */
  function detectPageState(snapshotText) {
    if (!snapshotText) return 'normal';
    const errorKeywords = ['错误', 'Error', '404', '500', '无权限', '加载失败', '网络异常', 'Uncaught', 'TypeError'];
    const loadingKeywords = ['加载中', 'Loading', '...'];
    const t = snapshotText.slice(0, 2000); // only check header
    if (errorKeywords.some(k => t.includes(k))) return 'error';
    if (loadingKeywords.some(k => t.includes(k))) return 'loading';
    return 'normal';
  }

  /**
   * Use CDP DOMSnapshot to extract interactive field states (value, placeholder, checked, etc.)
   * Returns a formatted string block, or null on failure.
   */
  async function getCdpFieldStates(browserContext) {
    try {
      const pages = browserContext.pages();
      if (!pages.length) return null;
      const page = pages[0];

      // Collect form field states via evaluate (works without full CDP DOMSnapshot)
      const fields = await page.evaluate(() => {
        const results = [];
        const selectors = 'input, textarea, select, [contenteditable="true"]';
        document.querySelectorAll(selectors).forEach(el => {
          const rect = el.getBoundingClientRect();
          if (rect.width === 0 && rect.height === 0) return; // skip hidden
          const entry = {
            tag: el.tagName.toLowerCase(),
            type: el.type || null,
            name: el.name || el.id || el.placeholder || null,
            placeholder: el.placeholder || null,
            value: el.tagName === 'SELECT'
              ? (el.options[el.selectedIndex]?.text || el.value)
              : (el.value || el.textContent?.trim() || null),
            checked: el.type === 'checkbox' || el.type === 'radio' ? el.checked : null,
            disabled: el.disabled || null,
            ariaLabel: el.getAttribute('aria-label') || null,
          };
          // Only include entries that have useful info
          if (entry.value || entry.placeholder || entry.ariaLabel) {
            results.push(entry);
          }
        });
        return results;
      });

      if (!fields.length) return null;

      const lines = ['[CDP Field States]'];
      for (const f of fields) {
        const parts = [];
        if (f.tag === 'select') parts.push(`<select>`);
        else parts.push(`<${f.tag}${f.type ? ` type="${f.type}"` : ''}>`);
        if (f.ariaLabel) parts.push(`aria-label="${f.ariaLabel}"`);
        if (f.placeholder) parts.push(`placeholder="${f.placeholder}"`);
        if (f.checked !== null) parts.push(`checked=${f.checked}`);
        if (f.disabled) parts.push('disabled');
        parts.push(`value="${f.value ?? ''}"`);
        lines.push('  ' + parts.join(' '));
      }
      return lines.join('\n');
    } catch (e) {
      return null; // silently ignore CDP errors
    }
  }

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
        name: 'instance_export_auth',
        description: 'Export auth state (cookies/localStorage) from a specific instance or the connected Chrome. Useful for saving login state to reuse later.',
        inputSchema: {
          type: 'object',
          properties: {
            instanceId: { type: 'string', description: 'Instance ID to export auth from. If not provided, exports the auth state from browser_connect.' },
          },
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
      if (name === 'instance_export_auth') return await handleInstanceExportAuth(args);
      if (name === 'instance_list') return await handleInstanceList();
      if (name === 'instance_close') return await handleInstanceClose(args);
      if (name === 'instance_close_all') return await handleInstanceCloseAll();

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

        // ── Snapshot enhancement: diffSnapshot + pageState + CDP field states ──
        const isSnapshotTool = originalName === 'browser_snapshot';
        const prevSnapshot = isSnapshotTool ? (entry.lastSnapshot ?? null) : null;

        const result = await entry.backend.callTool(originalName, toolArgs);

        if (isSnapshotTool) {
          const rawSnapshotText = extractSnapshotText(result);
          if (rawSnapshotText) {
            // Trim noise from snapshot before any processing
            const newSnapshotText = trimSnapshot(rawSnapshotText);

            // Compute diff against previous snapshot (use trimmed for consistency)
            const diffLines = computeDiff(prevSnapshot, newSnapshotText);
            // Detect page health state
            const pageState = detectPageState(newSnapshotText);
            // Fetch CDP field states (form values, placeholders, etc.)
            const cdpFields = await getCdpFieldStates(entry.browserContext);

            // Save trimmed snapshot for next diff
            entry.lastSnapshot = newSnapshotText;

            // ── Smart snapshot strategy ──
            // Decide whether to return full snapshot or diff-only based on change ratio.
            //
            // "Major change" means: page navigation / modal appeared / tab switch / etc.
            // In these cases AI MUST see the full snapshot to understand the new context.
            // "Minor change" means: form field filled / button state changed / text updated.
            // In these cases diff-only is safe and saves significant context tokens.
            const isMajorChange = (() => {
              if (!prevSnapshot) return true;            // first snapshot ever → always full
              if (diffLines.length === 0) return false;  // no change at all
              const newLineCount = newSnapshotText.split('\n').length;
              const changeRatio = diffLines.length / newLineCount;
              return changeRatio > 0.35;                 // >35% lines changed = major change
            })();

            const sections = [];

            if (isMajorChange) {
              // Full snapshot so AI can re-orient to the new page context
              sections.push(newSnapshotText);
              if (cdpFields) sections.push('\n' + cdpFields);
              if (prevSnapshot && diffLines.length > 0) {
                // Still show a change summary so AI knows WHY the page looks different
                const added   = diffLines.filter(l => l.startsWith('+')).length;
                const removed = diffLines.filter(l => l.startsWith('-')).length;
                sections.push(
                  `\n[Page change detected: ${added} lines added, ${removed} lines removed — full snapshot provided]`
                );
              } else if (!prevSnapshot) {
                sections.push('\n[First snapshot — full view provided]');
              }
            } else {
              // Minor change: diff-only to save context
              sections.push('[Snapshot diff — minor page update, full structure unchanged]');
              sections.push('\n' + (diffLines.length > 0
                ? diffLines.join('\n')
                : '  (no visible changes)'));
              if (cdpFields) sections.push('\n' + cdpFields);
            }

            sections.push(`\n[pageState: ${pageState}]`);

            return { content: [{ type: 'text', text: sections.join('') }] };
          }
          // If extraction failed, still save whatever we got
          entry.lastSnapshot = rawSnapshotText;
        }

        return result;
      }

      return errorResult(`Unknown tool: ${name}`);
    } catch (error) {
      return errorResult(`Error: ${error.message || error}`);
    }
  });

  // ── Download handler: capture downloads to prevent CDP disconnection ──

  /**
   * Set up download event handlers on a browserContext.
   * This prevents file downloads from navigating the page and breaking CDP connection.
   * Downloads are saved to a temp directory.
   */
  function setupDownloadHandler(browserContext, instanceId) {
    const downloadDir = path.join(DOWNLOAD_DIR, instanceId);

    const handleDownload = async (download) => {
      try {
        await fs.promises.mkdir(downloadDir, { recursive: true });
        const suggestedFilename = download.suggestedFilename();
        const savePath = path.join(downloadDir, suggestedFilename);
        await download.saveAs(savePath);
        console.error(`[playwright-mcp-parallel] [${instanceId}] Download saved: ${savePath}`);
      } catch (e) {
        // Ignore canceled downloads
        if (!e.message?.includes('canceled') && !e.message?.includes('Download deleted')) {
          console.error(`[playwright-mcp-parallel] [${instanceId}] Download error: ${e.message}`);
        }
      }
    };

    // Add listener to all existing pages
    for (const page of browserContext.pages()) {
      page.on('download', handleDownload);
    }

    // Add listener to future pages
    browserContext.on('page', (page) => {
      page.on('download', handleDownload);
    });
  }

  // ── Connection watchdog: auto-reconnect if CDP connection is lost ──

  let reconnectAttempts = 0;
  const MAX_RECONNECT_ATTEMPTS = 3;
  let watchdogInterval = null;

  /**
   * Start a watchdog that monitors CDP connection health and attempts reconnection.
   */
  function startConnectionWatchdog() {
    if (watchdogInterval) return; // Already running

    watchdogInterval = setInterval(async () => {
      if (!connectedBrowser || !connectedCdpUrl) return;

      try {
        // Simple liveness check
        connectedBrowser.contexts();
        reconnectAttempts = 0; // Reset on success
      } catch (e) {
        console.error(`[playwright-mcp-parallel] CDP connection lost, attempting reconnect (${reconnectAttempts + 1}/${MAX_RECONNECT_ATTEMPTS})...`);
        
        if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
          console.error(`[playwright-mcp-parallel] Max reconnect attempts reached. Call browser_connect manually.`);
          stopConnectionWatchdog();
          connectedBrowser = null;
          return;
        }

        reconnectAttempts++;

        try {
          const browser = await playwright.chromium.connectOverCDP(connectedCdpUrl, { timeout: 5000 });
          connectedBrowser = browser;
          console.error(`[playwright-mcp-parallel] Reconnected to ${connectedBrowserType || 'browser'} at ${connectedCdpUrl}`);

          // Update browser reference for all CDP-mode instances
          for (const [id, entry] of instances) {
            if (entry.mode === 'cdp') {
              entry.browser = browser;
              // Re-setup download handlers for the new connection
              try {
                const contexts = browser.contexts();
                for (const ctx of contexts) {
                  setupDownloadHandler(ctx, id);
                }
              } catch { /* ignore */ }
            }
          }

          reconnectAttempts = 0;
        } catch (reconnectErr) {
          console.error(`[playwright-mcp-parallel] Reconnect failed: ${reconnectErr.message}`);
        }
      }
    }, 3000); // Check every 3 seconds
  }

  function stopConnectionWatchdog() {
    if (watchdogInterval) {
      clearInterval(watchdogInterval);
      watchdogInterval = null;
    }
  }

  // ── Instance badge: visually mark browser windows with instanceId ──

  /**
   * Inject a persistent visual badge showing the instanceId into every page.
   * Also sets up a listener so future navigations re-inject the badge.
   */
  async function markBrowserWithInstanceId(browserContext, instanceId) {
    const badgeScript = (id) => `
      (function() {
        if (document.getElementById('__mcp_instance_badge__')) return;
        const badge = document.createElement('div');
        badge.id = '__mcp_instance_badge__';
        badge.textContent = '🤖 ' + ${JSON.stringify(id)};
        badge.style.cssText = 'position:fixed;top:4px;right:4px;z-index:2147483647;' +
          'background:linear-gradient(135deg,#1a1a2e,#16213e);color:#00d4ff;' +
          'font:bold 12px/1 "Consolas","Monaco","Courier New",monospace;' +
          'padding:5px 10px;border-radius:6px;border:1px solid #00d4ff40;' +
          'box-shadow:0 2px 8px rgba(0,212,255,0.2);pointer-events:none;' +
          'opacity:0.85;user-select:none;white-space:nowrap;';
        (document.body || document.documentElement).appendChild(badge);
      })();
    `;

    // Inject into all existing pages
    const pages = browserContext.pages();
    for (const page of pages) {
      try { await page.evaluate(badgeScript(instanceId)); } catch { /* ignore */ }
    }

    // Auto-inject on every future page and navigation
    browserContext.on('page', async (page) => {
      try {
        await page.waitForLoadState('domcontentloaded').catch(() => {});
        await page.evaluate(badgeScript(instanceId));
      } catch { /* ignore */ }
    });

    // Re-inject after navigation on existing and new pages
    const injectOnNav = (page) => {
      page.on('load', async () => {
        try { await page.evaluate(badgeScript(instanceId)); } catch { /* ignore */ }
      });
    };
    for (const page of pages) { injectOnNav(page); }
    browserContext.on('page', injectOnNav);
  }

  // ── Management tool implementations ──

  /**
   * Detect browser type from CDP version endpoint or user-agent.
   */
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
    } catch {
      return 'Browser';
    }
  }

  /**
   * Try to auto-launch a new Chrome/Edge with --remote-debugging-port.
   * Uses a dedicated user-data-dir so it does NOT interfere with user's browser.
   * Returns { cdpUrl, process } on success, null on failure.
   */
  async function autoLaunchDebugBrowser(port = 9222) {
    const debugDataDir = path.join(os.homedir(), '.playwright-mcp-debug-profile');
    try { fs.mkdirSync(debugDataDir, { recursive: true }); } catch {}

    // Candidate browser executables (Chrome and Edge)
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
      candidates.push(
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      );
    } else {
      candidates.push('google-chrome', 'google-chrome-stable', 'chromium-browser', 'microsoft-edge');
    }

    for (const exe of candidates) {
      try {
        if (isWin || isMac) {
          if (!fs.existsSync(exe)) continue;
        }

        const args = [
          `--remote-debugging-port=${port}`,
          `--user-data-dir=${debugDataDir}`,
          '--remote-allow-origins=*',
          '--no-first-run',
          '--no-default-browser-check',
        ];

        const child = spawn(exe, args, {
          detached: true,
          stdio: 'ignore',
          windowsHide: false,
        });
        child.unref();

        // Wait for the debug port to become available
        const cdpUrl = `http://localhost:${port}`;
        for (let attempt = 0; attempt < 15; attempt++) {
          await new Promise(r => setTimeout(r, 500));
          try {
            await playwright.chromium.connectOverCDP(cdpUrl, { timeout: 1000 }).then(b => b.close());
            // Port is responding — but we need to connect properly in the caller
            const browserType = exe.toLowerCase().includes('edge') ? 'Edge' : 'Chrome';
            console.error(`[playwright-mcp-parallel] Auto-launched ${browserType} with debug port ${port}`);
            console.error(`[playwright-mcp-parallel] Debug profile: ${debugDataDir}`);
            return { cdpUrl, childProcess: child, browserType };
          } catch { /* not ready yet */ }
        }
        // Timed out — kill the process we started
        try { child.kill(); } catch {}
      } catch { /* try next candidate */ }
    }
    return null;
  }

  async function handleBrowserConnect(args) {
    const pageIndex = args?.pageIndex || 0;

    // If a specific URL is given, use it directly; otherwise auto-probe common ports
    const explicitUrl = args?.cdpUrl;
    const urlsToTry = explicitUrl
      ? [explicitUrl]
      : ['http://localhost:9222', 'http://localhost:9223', 'http://localhost:9224'];

    // If already connected and still alive, skip reconnect
    if (connectedBrowser) {
      try {
        // Quick liveness check — contexts() throws if browser is gone
        connectedBrowser.contexts();
        const displayUrl = connectedCdpUrl || '(previous session)';
        const displayType = connectedBrowserType || 'Browser';
        return textResult(
          `✅ Already connected to ${displayType} at ${displayUrl}.\n` +
          `Auth state is intact (${authState?.cookies?.length ?? 0} cookies).\n` +
          `No action needed — proceed with your task.`
        );
      } catch (_) {
        // Browser gone, reset and try fresh
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

        // Detect browser type (Chrome vs Edge vs Chromium)
        const browserType = await detectBrowserType(cdpUrl);

        connectedBrowser = browser;
        connectedCdpUrl = cdpUrl;
        connectedBrowserType = browserType;
        const targetPage = pages[Math.min(pageIndex, pages.length - 1)];
        const cookies = await context.cookies();

        // Extract localStorage
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
        
        // Start connection watchdog for auto-reconnect
        startConnectionWatchdog();
        
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

    // All attempts failed — try to auto-launch a debug browser
    const isConnRefused = lastError?.message?.includes('ECONNREFUSED') || lastError?.message?.includes('connect');
    const portList = urlsToTry.join(', ');

    if (isConnRefused) {
      console.error(`[playwright-mcp-parallel] No debug port found (tried: ${portList}). Attempting auto-launch...`);

      // Pick a port that's not commonly used by user's browser
      const autoPort = 9222;
      const launchResult = await autoLaunchDebugBrowser(autoPort);

      if (launchResult) {
        // Successfully launched — now connect to it
        try {
          const browser = await playwright.chromium.connectOverCDP(launchResult.cdpUrl, { timeout: 5000 });
          const contexts = browser.contexts();
          // New browser may not have any contexts yet — create one
          let context;
          if (contexts.length === 0) {
            context = await browser.newContext();
            const page = await context.newPage();
            await page.goto('about:blank');
          } else {
            context = contexts[0];
          }

          connectedBrowser = browser;
          connectedCdpUrl = launchResult.cdpUrl;
          connectedBrowserType = launchResult.browserType;

          const cookies = await context.cookies();
          authState = {
            cookies: cookies.map(c => ({
              name: c.name, value: c.value, domain: c.domain,
              path: c.path, expires: c.expires, httpOnly: c.httpOnly,
              secure: c.secure, sameSite: c.sameSite,
            })),
            origins: [],
          };

          return textResult(
            `✅ Auto-launched ${launchResult.browserType} with debug port ${autoPort}.\n` +
            `Connected at ${launchResult.cdpUrl}.\n` +
            `⚠️ This is a NEW browser profile (no existing login state).\n` +
            `   Profile location: ${path.join(os.homedir(), '.playwright-mcp-debug-profile')}\n` +
            `   You can log in via instance_create + navigate, and the session will persist across restarts.\n` +
            `   User's existing ${launchResult.browserType} is NOT affected.`
          );
        } catch (connectErr) {
          return errorResult(
            `❌ Auto-launched browser but failed to connect: ${connectErr.message}\n\n` +
            `You can try manually:\n` +
            `  Windows: start chrome.exe --remote-debugging-port=9222 --user-data-dir="%USERPROFILE%\\.playwright-mcp-debug-profile"\n` +
            `  Mac:     /Applications/Google\\ Chrome.app/Contents/MacOS/Google\\ Chrome --remote-debugging-port=9222 --user-data-dir="$HOME/.playwright-mcp-debug-profile"\n\n` +
            `⚠️ Do NOT kill user's existing Chrome/Edge.`
          );
        }
      }

      // Auto-launch also failed
      return errorResult(
        `❌ No debug port found (tried: ${portList}) and auto-launch failed.\n\n` +
        `Please start a browser with debug port manually:\n` +
        `  Windows: start chrome.exe --remote-debugging-port=9222 --user-data-dir="%USERPROFILE%\\.playwright-mcp-debug-profile"\n` +
        `  Mac:     /Applications/Google\\ Chrome.app/Contents/MacOS/Google\\ Chrome --remote-debugging-port=9222 --user-data-dir="$HOME/.playwright-mcp-debug-profile"\n\n` +
        `⚠️ Do NOT kill user's existing Chrome/Edge — use a separate profile directory.`
      );
    }

    return errorResult(
      `❌ Failed to connect (tried: ${portList}).\n` +
      `Error: ${lastError?.message}\n\n` +
      `⚠️ Do NOT kill Chrome/Edge. Check if the browser is running and which debug port is in use.`
    );
  }

  async function handleInstanceCreate(args) {
    const instanceId = args?.instanceId;
    if (!instanceId) return errorResult('instanceId is required.');
    if (instances.has(instanceId)) return errorResult(`Instance "${instanceId}" already exists.`);

    const cloneAuth = args?.cloneAuth !== false;
    const url = args?.url;
    // Default to CDP mode when a browser is connected
    const useCDP = args?.useCDP !== false && !!connectedBrowser;

    let browser, browserContext, mode;

    if (useCDP && connectedBrowser) {
      // ── CDP mode: create a new BrowserContext inside the connected browser ──
      // This shares the same browser process, so httpOnly cookies and SSO sessions are preserved.
      try {
        connectedBrowser.contexts(); // liveness check
      } catch (_) {
        connectedBrowser = null;
        connectedCdpUrl = null;
        connectedBrowserType = null;
        return errorResult(
          `CDP browser is no longer available. Call browser_connect first to reconnect.`
        );
      }

      browser = connectedBrowser; // shared — do NOT close this on instance_close
      const contextOptions = { ...(config.browser?.contextOptions || {}) };
      // In CDP mode with cloneAuth, we clone cookies from the connected browser's default context
      if (cloneAuth && authState) {
        contextOptions.storageState = authState;
      }
      browserContext = await browser.newContext({
        ...contextOptions,
        viewport: null, // use browser default
      });
      mode = 'cdp';
    } else {
      // ── Launch mode: start a completely new browser process ──
      const contextOptions = { ...(config.browser?.contextOptions || {}) };
      if (cloneAuth && authState) {
        contextOptions.storageState = authState;
      }

      const browserName = config.browser?.browserName || 'chromium';
      const isHeadless = config.browser?.launchOptions?.headless ?? false;
      const extraArgs = isHeadless ? [] : ['--start-maximized'];
      browser = await playwright[browserName].launch({
        ...(config.browser?.launchOptions || {}),
        headless: isHeadless,
        args: [
          ...((config.browser?.launchOptions?.args) || []),
          ...extraArgs,
        ],
        handleSIGINT: false,
        handleSIGTERM: false,
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

    // ── Setup download handler to prevent CDP disconnection ──
    // Captures downloads and saves them to temp directory instead of navigating the page
    setupDownloadHandler(browserContext, instanceId);

    // Navigate if URL provided
    if (url) {
      await backend.callTool('browser_navigate', { url });
    }

    // ── Mark browser with instanceId ──
    // Inject a visual badge into every new page so the user can identify which browser belongs to which instance.
    await markBrowserWithInstanceId(browserContext, instanceId);

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

  async function handleInstanceExportAuth(args) {
    const instanceId = args?.instanceId;

    // If no instanceId, export from the connected CDP browser
    if (!instanceId) {
      if (!connectedBrowser) {
        return errorResult('No instance specified and no browser connected. Call browser_connect first or provide an instanceId.');
      }
      // Re-extract auth from the connected browser's default context
      try {
        const contexts = connectedBrowser.contexts();
        if (contexts.length === 0) return errorResult('Connected browser has no contexts.');
        const context = contexts[0];
        const storageState = await context.storageState();
        authState = storageState;
        const cookieCount = authState.cookies?.length || 0;
        const httpOnlyCount = authState.cookies?.filter(c => c.httpOnly)?.length || 0;
        const originCount = authState.origins?.length || 0;
        return textResult(
          `✅ Auth exported from connected ${connectedBrowserType || 'browser'}\n` +
          `🔐 Extracted: ${cookieCount} cookies (${httpOnlyCount} httpOnly), ${originCount} origins\n\n` +
          `Auth has been saved. New instances created with cloneAuth=true will automatically inherit this login state.`
        );
      } catch (error) {
        return errorResult(`Failed to export auth from connected browser: ${error.message}`);
      }
    }

    const entry = instances.get(instanceId);
    if (!entry) return errorResult(`Instance "${instanceId}" not found.`);

    try {
      // Export storageState from the instance's context
      const storageState = await entry.browserContext.storageState();
      authState = storageState;

      const cookieCount = authState.cookies?.length || 0;
      const httpOnlyCount = authState.cookies?.filter(c => c.httpOnly)?.length || 0;
      const originCount = authState.origins?.length || 0;

      return textResult(
        `✅ Auth exported from instance "${instanceId}"\n` +
        `🔐 Extracted: ${cookieCount} cookies (${httpOnlyCount} httpOnly), ${originCount} origins\n\n` +
        `Auth has been saved. New instances created with cloneAuth=true will automatically inherit this login state.`
      );
    } catch (error) {
      return errorResult(`Failed to export auth: ${error.message}`);
    }
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
    return textResult(`Instance "${instanceId}" closed (was ${entry.mode} mode). Remaining: ${instances.size}`);
  }

  async function handleInstanceCloseAll() {
    const count = instances.size;
    const ids = [...instances.keys()];
    for (const id of ids) {
      await handleInstanceClose({ instanceId: id });
    }
    return textResult(`Closed ${count} instance(s).`);
  }

  // ── Cleanup ──
  process.on('SIGINT', async () => {
    stopConnectionWatchdog();
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