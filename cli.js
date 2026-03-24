#!/usr/bin/env node
/**
 * Root entry point for playwright-mcp-parallel.
 * Delegates to packages/playwright-mcp/cli-parallel.js
 * 
 * Usage via npx:
 *   npx github:Mokecy/playwright-mcp-parallel
 *   npx github:Mokecy/playwright-mcp-parallel --browser chrome
 *   npx github:Mokecy/playwright-mcp-parallel --headless
 */
require('./packages/playwright-mcp/cli-parallel.js');
