#!/usr/bin/env node
/**
 * CLI entry point for Playwright MCP Parallel mode.
 * 
 * Usage:
 *   node cli-parallel.js                          # stdio mode (default)
 *   node cli-parallel.js --port 3001              # SSE/HTTP mode
 *   node cli-parallel.js --browser chrome         # specify browser
 *   node cli-parallel.js --headless               # headless mode
 *   node cli-parallel.js --caps vision,pdf        # enable capabilities
 * 
 * This is a binary extension of @playwright/mcp that adds multi-instance
 * parallel browser support. All original tools are available per-instance.
 */

const mcpBundle = require('playwright-core/lib/mcpBundle');
const { setupExitWatchdog } = require('playwright-core/lib/tools/exports');
const { createParallelConnection } = require('./parallel');
const packageJSON = require('./package.json');

// Handle install-browser subcommand (same as original cli.js)
if (process.argv.includes('install-browser')) {
  const argv = process.argv.map(arg => arg === 'install-browser' ? 'install' : arg);
  const { program: mainProgram } = require('playwright-core/lib/cli/program');
  mainProgram.parse(argv);
  return;
}

// ── Parse CLI args manually ──
function parseArgs() {
  const args = process.argv.slice(2);
  const options = {};
  
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case '--browser': options.browserName = args[++i]; break;
      case '--headless': options.headless = true; break;
      case '--port': options.port = parseInt(args[++i]); break;
      case '--host': options.host = args[++i]; break;
      case '--cdp-endpoint': options.cdpEndpoint = args[++i]; break;
      case '--user-data-dir': options.userDataDir = args[++i]; break;
      case '--output-dir': options.outputDir = args[++i]; break;
      case '--config': options.configFile = args[++i]; break;
      case '--caps': options.caps = args[++i]?.split(','); break;
      case '--allowed-origins': options.allowedOrigins = args[++i]?.split(';'); break;
      case '--blocked-origins': options.blockedOrigins = args[++i]?.split(';'); break;
      case '--help': case '-h':
        console.error(`
Playwright MCP Parallel v${packageJSON.version}

Usage: node cli-parallel.js [options]

Options:
  --browser <name>          Browser to use: chromium, chrome, firefox, webkit, msedge
  --headless                Run in headless mode (default: headed)
  --port <number>           Port for SSE/HTTP mode (default: stdio)
  --host <host>             Host to bind (default: localhost)
  --cdp-endpoint <url>      CDP endpoint to connect to
  --caps <list>             Comma-separated capabilities: vision, pdf, devtools
  --user-data-dir <path>    Path to user data directory
  --output-dir <path>       Path for screenshots and output files
  --allowed-origins <list>  Semicolon-separated allowed origins
  --blocked-origins <list>  Semicolon-separated blocked origins
  --help                    Show this help

Parallel tools:
  All original @playwright/mcp tools are available, prefixed with page_
  and requiring an instanceId parameter. Plus management tools:
    browser_connect, instance_create, instance_list, instance_close, instance_close_all
`);
        process.exit(0);
    }
  }
  return options;
}

// ── Build config from CLI options ──
function buildConfig(options) {
  // Map browser name to playwright browser name
  let browserName = 'chromium';
  let channel;
  const b = options.browserName;
  if (b === 'firefox') browserName = 'firefox';
  else if (b === 'webkit') browserName = 'webkit';
  else if (b === 'chrome' || b === 'msedge') { browserName = 'chromium'; channel = b; }
  else if (b === 'chromium') browserName = 'chromium';
  else if (b) { browserName = 'chromium'; channel = b; }

  const config = {
    browser: {
      browserName,
      isolated: true, // Always isolated for parallel
      launchOptions: {
        headless: options.headless || false,
      },
      contextOptions: {},
    },
    capabilities: options.caps || [],
    outputDir: options.outputDir,
  };

  if (channel) config.browser.launchOptions.channel = channel;
  if (options.cdpEndpoint) config.browser.cdpEndpoint = options.cdpEndpoint;
  if (options.userDataDir) config.browser.userDataDir = options.userDataDir;

  if (options.allowedOrigins) {
    config.network = { ...(config.network || {}), allowedOrigins: options.allowedOrigins };
  }
  if (options.blockedOrigins) {
    config.network = { ...(config.network || {}), blockedOrigins: options.blockedOrigins };
  }

  // Load config file if specified
  if (options.configFile) {
    try {
      const fs = require('fs');
      const path = require('path');
      const filePath = path.resolve(options.configFile);
      const fileConfig = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      Object.assign(config, fileConfig);
      config.browser.isolated = true; // Enforce
    } catch (e) {
      console.error(`Warning: Could not load config file: ${e.message}`);
    }
  }

  return config;
}

// ── Main ──
async function main() {
  setupExitWatchdog();

  const options = parseArgs();
  const config = buildConfig(options);
  const server = createParallelConnection(config);

  if (options.port) {
    // HTTP/SSE mode
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
        res.end(JSON.stringify({ status: 'ok', server: 'playwright-mcp-parallel' }));
      } else { res.writeHead(404); res.end('Not found'); }
    });

    const host = options.host || 'localhost';
    httpServer.listen(options.port, host, () => {
      console.error(`[playwright-mcp-parallel] Listening on http://${host}:${options.port}`);
      console.error(`  SSE: http://${host}:${options.port}/sse`);
    });
  } else {
    // stdio mode (default)
    console.error('[playwright-mcp-parallel] Starting in stdio mode...');
    const transport = new mcpBundle.StdioServerTransport();
    await server.connect(transport);
    console.error('[playwright-mcp-parallel] Ready.');
  }
}

main().catch(e => {
  console.error('[playwright-mcp-parallel] Fatal:', e);
  process.exit(1);
});