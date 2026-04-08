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
          'Connect to an existing Chrome browser via CDP and extract auth cookies/localStorage.',
          'Chrome must be running with --remote-debugging-port.',
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
        description: 'Create a new isolated browser instance. Auth (cookies/localStorage) is automatically cloned from saved state (via browser_connect or instance_export_auth). Each instance has fully isolated state and gets all standard browser_* tools.',
        inputSchema: {
          type: 'object',
          properties: {
            instanceId: { type: 'string', description: 'Unique identifier for this instance (e.g. "task-1", "task-2")' },
            url: { type: 'string', description: 'URL to navigate to after creation' },
            cloneAuth: { type: 'boolean', description: 'Whether to clone auth from saved state. Default: true' },
          },
          required: ['instanceId'],
        },
      },
      {
        name: 'instance_export_auth',
        description: 'Export authentication state (cookies/localStorage) from an existing instance. This allows other instances to clone the login state without needing external Chrome. Call this after logging in the first instance.',
        inputSchema: {
          type: 'object',
          properties: {
            instanceId: { type: 'string', description: 'Source instance ID to export auth from (must be already logged in)' },
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

  // ── Management tool implementations ──

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
        const alreadyConnectedUrl = connectedBrowser._connection?._url || '(previous session)';
        return textResult(
          `✅ Already connected to Chrome at ${alreadyConnectedUrl}.\n` +
          `Auth state is intact (${authState?.cookies?.length ?? 0} cookies).\n` +
          `No action needed — proceed with your task.`
        );
      } catch (_) {
        // Browser gone, reset and try fresh
        connectedBrowser = null;
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

        connectedBrowser = browser;
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

        return textResult(
          `✅ Connected to Chrome at ${cdpUrl}.\n` +
          `Extracted ${cookies.length} cookies.\n` +
          `New instances will inherit auth state.\n` +
          `⚠️ Do NOT kill or restart Chrome — it is already running correctly.`
        );
      } catch (err) {
        lastError = err;
      }
    }

    // All attempts failed — give clear, actionable guidance to the AI
    const isConnRefused = lastError?.message?.includes('ECONNREFUSED') || lastError?.message?.includes('connect');
    const portList = urlsToTry.join(', ');

    if (isConnRefused) {
      return errorResult(
        `❌ Chrome debug port not found (tried: ${portList}).\n\n` +
        `Chrome is running WITHOUT --remote-debugging-port.\n\n` +
        `ACTION REQUIRED — Ask the user to run this command to restart Chrome with debug port:\n` +
        `  Mac:     /Applications/Google\\ Chrome.app/Contents/MacOS/Google\\ Chrome --remote-debugging-port=9222\n` +
        `  Windows: start chrome.exe --remote-debugging-port=9222\n\n` +
        `⚠️ IMPORTANT: Do NOT kill or pkill Chrome automatically.\n` +
        `⚠️ Do NOT proceed until the user confirms Chrome has been restarted with the debug port.`
      );
    }

    return errorResult(
      `❌ Failed to connect to Chrome (tried: ${portList}).\n` +
      `Error: ${lastError?.message}\n\n` +
      `⚠️ Do NOT kill Chrome. Ask the user to check if Chrome is running and which debug port is in use.`
    );
  }

  async function handleInstanceCreate(args) {
    const instanceId = args?.instanceId;
    if (!instanceId) return errorResult('instanceId is required.');
    if (instances.has(instanceId)) return errorResult(`Instance "${instanceId}" already exists.`);

    const cloneAuth = args?.cloneAuth !== false;
    const url = args?.url;

    // Build context options with auth if available
    const contextOptions = { ...(config.browser?.contextOptions || {}) };
    if (cloneAuth && authState) {
      contextOptions.storageState = authState;
    }

    // Launch a new isolated browser
    const browserName = config.browser?.browserName || 'chromium';
    const isHeadless = config.browser?.launchOptions?.headless ?? false;
    const extraArgs = isHeadless ? [] : ['--start-maximized'];
    const browser = await playwright[browserName].launch({
      ...(config.browser?.launchOptions || {}),
      headless: isHeadless,
      args: [
        ...((config.browser?.launchOptions?.args) || []),
        ...extraArgs,
      ],
      handleSIGINT: false,
      handleSIGTERM: false,
    });

    // viewport: null is required for --start-maximized to take effect
    const browserContext = await browser.newContext({
      ...contextOptions,
      viewport: isHeadless ? (contextOptions.viewport ?? { width: 1920, height: 1080 }) : null,
    });
    const backend = new BrowserBackend(config, browserContext, tools);
    await backend.initialize(clientInfo);

    instances.set(instanceId, { backend, browser, browserContext });

    // Navigate if URL provided
    if (url) {
      await backend.callTool('browser_navigate', { url });
    }

    return textResult(
      `Instance "${instanceId}" created.\n` +
      (url ? `Navigated to: ${url}\n` : '') +
      `Auth cloned: ${cloneAuth && !!authState}\n` +
      `Total instances: ${instances.size}`
    );
  }

  async function handleInstanceExportAuth(args) {
    const instanceId = args?.instanceId;
    if (!instanceId) return errorResult('instanceId is required.');

    const entry = instances.get(instanceId);
    if (!entry) return errorResult(`Instance "${instanceId}" not found.`);

    try {
      // Export storageState from the instance's context
      const storageState = await entry.browserContext.storageState();
      authState = storageState;

      const cookieCount = authState.cookies?.length || 0;
      const originCount = authState.origins?.length || 0;

      return textResult(
        `✅ Auth exported from instance "${instanceId}"\n` +
        `🔐 Extracted: ${cookieCount} cookies, ${originCount} origins\n\n` +
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
      await entry.browser.close().catch(() => {});
    } catch (e) { /* ignore */ }

    instances.delete(instanceId);
    return textResult(`Instance "${instanceId}" closed. Remaining: ${instances.size}`);
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