#!/usr/bin/env node
/**
 * playwright-mcp-parallel
 * 
 * Playwright MCP server with parallel multi-instance browser support.
 * Drop-in enhancement over @playwright/mcp — all original tools available per-instance.
 * 
 * Usage:
 *   npx playwright-mcp-parallel                    # stdio (default)
 *   npx playwright-mcp-parallel --browser chrome   # use Chrome
 *   npx playwright-mcp-parallel --headless         # headless mode
 *   npx playwright-mcp-parallel --port 3001        # SSE/HTTP mode
 */

const { setupExitWatchdog } = require('playwright-core/lib/tools/exports');
const mcpBundle = require('playwright-core/lib/mcpBundle');
const { createParallelConnection } = require('./parallel');
const packageJSON = require('./package.json');

// ── Parse CLI args ──
const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
  console.log(`
playwright-mcp-parallel v${packageJSON.version}
Playwright MCP with parallel multi-instance browser support.

Usage: npx playwright-mcp-parallel [options]

Options:
  --browser <name>          Browser: chromium, chrome, firefox, webkit, msedge
  --headless                Run in headless mode (default: headed)
  --port <number>           Port for SSE/HTTP mode (default: stdio)
  --host <host>             Host to bind (default: localhost)
  --caps <list>             Comma-separated: vision, pdf, devtools
  --user-data-dir <path>    Browser user data directory
  --output-dir <path>       Output directory for screenshots etc.
  --allowed-origins <list>  Semicolon-separated allowed origins
  --blocked-origins <list>  Semicolon-separated blocked origins
  --help                    Show this help

Tools:
  Management:   browser_connect, instance_create, instance_list, instance_close, instance_close_all
  Per-instance: page_browser_navigate, page_browser_snapshot, page_browser_click, ... (all original tools)
`);
  process.exit(0);
}

function getArg(name) {
  const i = args.indexOf(name);
  return i !== -1 && i + 1 < args.length ? args[i + 1] : undefined;
}
function hasFlag(name) { return args.includes(name); }

// ── Build config ──
let browserName = 'chromium';
let channel;
const b = getArg('--browser');
if (b === 'firefox') browserName = 'firefox';
else if (b === 'webkit') browserName = 'webkit';
else if (b === 'chrome' || b === 'msedge') { browserName = 'chromium'; channel = b; }
else if (b) { browserName = 'chromium'; channel = b; }

const config = {
  browser: {
    browserName,
    isolated: true,
    launchOptions: {
      headless: hasFlag('--headless'),
      ...(channel ? { channel } : {}),
    },
    contextOptions: {},
  },
  capabilities: getArg('--caps')?.split(',') || [],
  outputDir: getArg('--output-dir'),
  network: {},
};

const userDataDir = getArg('--user-data-dir');
if (userDataDir) config.browser.userDataDir = userDataDir;

const allowedOrigins = getArg('--allowed-origins');
if (allowedOrigins) config.network.allowedOrigins = allowedOrigins.split(';');

const blockedOrigins = getArg('--blocked-origins');
if (blockedOrigins) config.network.blockedOrigins = blockedOrigins.split(';');

// ── Start server ──
async function main() {
  setupExitWatchdog();

  const server = createParallelConnection(config);

  const port = getArg('--port');
  const host = getArg('--host') || 'localhost';

  if (port) {
    // SSE/HTTP mode
    const http = require('http');
    let sseTransport;

    const httpServer = http.createServer(async (req, res) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

      const url = new URL(req.url || '/', `http://${req.headers.host}`);
      if (url.pathname === '/sse') {
        sseTransport = new mcpBundle.SSEServerTransport('/messages', res);
        await server.connect(sseTransport);
      } else if (url.pathname === '/messages' && req.method === 'POST') {
        if (sseTransport) await sseTransport.handlePostMessage(req, res);
        else { res.writeHead(400); res.end('No SSE connection'); }
      } else if (url.pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', server: 'playwright-mcp-parallel', version: packageJSON.version }));
      } else { res.writeHead(404); res.end('Not found'); }
    });

    httpServer.listen(parseInt(port), host, () => {
      console.error(`[playwright-mcp-parallel] v${packageJSON.version}`);
      console.error(`  Listening: http://${host}:${port}`);
      console.error(`  SSE:      http://${host}:${port}/sse`);
    });
  } else {
    // stdio mode (default)
    const transport = new mcpBundle.StdioServerTransport();
    await server.connect(transport);
  }
}

main().catch(e => {
  console.error('Fatal:', e.message || e);
  process.exit(1);
});