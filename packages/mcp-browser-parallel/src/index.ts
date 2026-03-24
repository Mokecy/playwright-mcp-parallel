/**
 * mcp-browser-parallel
 * Parallel Browser MCP Server - manage multiple isolated browser instances
 */

export { createParallelBrowserServer } from './server.js';
export { BrowserInstanceManager } from './instanceManager.js';
export type { AuthState, BrowserInstance } from './instanceManager.js';
