#!/usr/bin/env node
/**
 * CLI entry point for the Parallel Browser MCP Server
 *
 * Usage:
 *   npx mcp-browser-parallel              # stdio mode (default)
 *   npx mcp-browser-parallel --port 3001   # SSE/HTTP mode
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createParallelBrowserServer } from './server.js';

async function main() {
  const args = process.argv.slice(2);
  const portIndex = args.indexOf('--port');
  const port = portIndex !== -1 ? parseInt(args[portIndex + 1], 10) : undefined;

  const server = createParallelBrowserServer();

  if (port) {
    // SSE/HTTP transport
    try {
      const { SSEServerTransport } = await import('@modelcontextprotocol/sdk/server/sse.js');
      const http = await import('http');

      let sseTransport: any;

      const httpServer = http.createServer(async (req, res) => {
        // CORS headers
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

        if (req.method === 'OPTIONS') {
          res.writeHead(204);
          res.end();
          return;
        }

        const url = new URL(req.url || '/', `http://${req.headers.host}`);

        if (url.pathname === '/sse') {
          sseTransport = new SSEServerTransport('/messages', res);
          await server.connect(sseTransport);
        } else if (url.pathname === '/messages' && req.method === 'POST') {
          if (sseTransport) {
            await sseTransport.handlePostMessage(req, res);
          } else {
            res.writeHead(400);
            res.end('No SSE connection established');
          }
        } else if (url.pathname === '/health') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'ok', server: 'mcp-browser-parallel' }));
        } else {
          res.writeHead(404);
          res.end('Not found');
        }
      });

      httpServer.listen(port, () => {
        console.error(`[mcp-browser-parallel] SSE server listening on http://localhost:${port}`);
        console.error(`  SSE endpoint: http://localhost:${port}/sse`);
        console.error(`  Health check: http://localhost:${port}/health`);
      });
    } catch (e) {
      console.error('SSE transport not available, falling back to stdio');
      const transport = new StdioServerTransport();
      await server.connect(transport);
    }
  } else {
    // stdio transport (default)
    console.error('[mcp-browser-parallel] Starting in stdio mode...');
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error('[mcp-browser-parallel] Server started. Waiting for MCP client connection...');
  }
}

main().catch((error) => {
  console.error('[mcp-browser-parallel] Fatal error:', error);
  process.exit(1);
});
