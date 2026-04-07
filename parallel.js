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

  // ── Build tool list ──
  server.setRequestHandler(mcpBundle.ListToolsRequestSchema, async () => {
    // Management tools
    const managementTools = [
      {
        name: 'browser_connect',
        description: 'Connect to an existing Chrome browser via CDP and extract auth cookies/localStorage. Chrome must be running with --remote-debugging-port. This extracts auth so new instances inherit login state.',
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
        description: 'Create a new isolated browser instance. Auth (cookies/localStorage) is automatically cloned from the connected Chrome if available. Each instance has fully isolated state and gets all standard browser_* tools.',
        inputSchema: {
          type: 'object',
          properties: {
            instanceId: { type: 'string', description: 'Unique identifier for this instance (e.g. "task-1", "task-2")' },
            url: { type: 'string', description: 'URL to navigate to after creation' },
            cloneAuth: { type: 'boolean', description: 'Whether to clone auth from the connected Chrome. Default: true' },
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

  // ── Management tool implementations ──

  async function handleBrowserConnect(args) {
    const cdpUrl = args?.cdpUrl || 'http://localhost:9222';
    const pageIndex = args?.pageIndex || 0;

    try {
      connectedBrowser = await playwright.chromium.connectOverCDP(cdpUrl);
      const contexts = connectedBrowser.contexts();
      if (contexts.length === 0) throw new Error('No browser contexts found');

      const context = contexts[0];
      const pages = context.pages();
      if (pages.length === 0) throw new Error('No pages found');

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

      return textResult(`Connected to Chrome at ${cdpUrl}.\nExtracted ${cookies.length} cookies.\nNew instances will inherit auth state.`);
    } catch (error) {
      return errorResult(`Failed to connect: ${error.message}`);
    }
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