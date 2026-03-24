/**
 * Parallel Browser MCP Server
 * Manages multiple isolated browser instances for concurrent automation.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { BrowserInstanceManager } from './instanceManager.js';
import { takeSnapshot } from './snapshotHelper.js';
import type { Page } from 'playwright';
import * as path from 'path';
import * as fs from 'fs';

export function createParallelBrowserServer(): Server {
  const server = new Server(
    { name: 'mcp-browser-parallel', version: '1.0.0' },
    { capabilities: { tools: {} } }
  );

  const manager = new BrowserInstanceManager();

  // ── Tool Definitions ──────────────────────────────────────────────────

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      // ── Connection ──
      {
        name: 'browser_connect',
        description: 'Connect to an existing Chrome browser via CDP and extract auth cookies. Chrome must be running with --remote-debugging-port. This also extracts cookies/storage so new instances can be created without re-login.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            cdpUrl: { type: 'string', description: 'Chrome CDP URL. Default: http://localhost:9222', default: 'http://localhost:9222' },
            pageIndex: { type: 'number', description: 'Index of the page to extract auth from (0-based). Default: 0', default: 0 },
          },
        },
      },
      // ── Instance Management ──
      {
        name: 'instance_create',
        description: 'Create a new isolated browser instance. Auth (cookies/localStorage) is automatically cloned from the connected Chrome, so no re-login is needed. Each instance has fully isolated state.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            instanceId: { type: 'string', description: 'Unique identifier for this instance (e.g. "batch-1", "batch-2")' },
            url: { type: 'string', description: 'URL to navigate to after creation' },
            cloneAuth: { type: 'boolean', description: 'Whether to clone auth from the connected Chrome. Default: true', default: true },
          },
          required: ['instanceId'],
        },
      },
      {
        name: 'instance_list',
        description: 'List all active browser instances with their current URLs and titles.',
        inputSchema: { type: 'object' as const, properties: {} },
      },
      {
        name: 'instance_close',
        description: 'Close a specific browser instance and release its resources.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            instanceId: { type: 'string', description: 'Instance to close' },
          },
          required: ['instanceId'],
        },
      },
      {
        name: 'instance_close_all',
        description: 'Close all browser instances.',
        inputSchema: { type: 'object' as const, properties: {} },
      },
      // ── Page Navigation ──
      {
        name: 'page_navigate',
        description: 'Navigate an instance to a URL.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            instanceId: { type: 'string', description: 'Target instance' },
            url: { type: 'string', description: 'URL to navigate to' },
            waitUntil: { type: 'string', enum: ['load', 'domcontentloaded', 'networkidle', 'commit'], description: 'When to consider navigation complete. Default: domcontentloaded', default: 'domcontentloaded' },
          },
          required: ['instanceId', 'url'],
        },
      },
      {
        name: 'page_navigate_back',
        description: 'Go back to the previous page in history.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            instanceId: { type: 'string', description: 'Target instance' },
          },
          required: ['instanceId'],
        },
      },
      // ── Page Snapshot & Screenshot ──
      {
        name: 'page_snapshot',
        description: 'Take an accessibility snapshot of the page. Returns a structured text representation with refs for interactive elements. Always use this before performing actions to understand the current page state.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            instanceId: { type: 'string', description: 'Target instance' },
          },
          required: ['instanceId'],
        },
      },
      {
        name: 'page_screenshot',
        description: 'Take a screenshot of the page or a specific element.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            instanceId: { type: 'string', description: 'Target instance' },
            filePath: { type: 'string', description: 'Absolute path to save screenshot' },
            ref: { type: 'string', description: 'Element ref to screenshot (omit for full page)' },
            fullPage: { type: 'boolean', description: 'Capture full scrollable page. Default: false' },
          },
          required: ['instanceId', 'filePath'],
        },
      },
      // ── Page Interactions ──
      {
        name: 'page_click',
        description: 'Click an element identified by ref from the latest page_snapshot.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            instanceId: { type: 'string', description: 'Target instance' },
            ref: { type: 'string', description: 'Element ref from page_snapshot (e.g. "e5")' },
            button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Mouse button. Default: left' },
            doubleClick: { type: 'boolean', description: 'Double click. Default: false' },
            modifiers: { type: 'array', items: { type: 'string', enum: ['Alt', 'Control', 'ControlOrMeta', 'Meta', 'Shift'] }, description: 'Modifier keys to press' },
          },
          required: ['instanceId', 'ref'],
        },
      },
      {
        name: 'page_fill',
        description: 'Clear and fill text into an input element identified by ref.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            instanceId: { type: 'string', description: 'Target instance' },
            ref: { type: 'string', description: 'Element ref from page_snapshot' },
            value: { type: 'string', description: 'Text to fill' },
          },
          required: ['instanceId', 'ref', 'value'],
        },
      },
      {
        name: 'page_type',
        description: 'Type text into editable element. By default fills at once; set slowly=true to type character by character.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            instanceId: { type: 'string', description: 'Target instance' },
            ref: { type: 'string', description: 'Element ref to type into' },
            text: { type: 'string', description: 'Text to type' },
            submit: { type: 'boolean', description: 'Whether to press Enter after typing. Default: false' },
            slowly: { type: 'boolean', description: 'Whether to type one character at a time. Default: false' },
          },
          required: ['instanceId', 'ref', 'text'],
        },
      },
      {
        name: 'page_select_option',
        description: 'Select option(s) in a <select> element.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            instanceId: { type: 'string', description: 'Target instance' },
            ref: { type: 'string', description: 'Element ref of the select element' },
            values: { type: 'array', items: { type: 'string' }, description: 'Values or labels to select' },
          },
          required: ['instanceId', 'ref', 'values'],
        },
      },
      {
        name: 'page_hover',
        description: 'Hover over an element.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            instanceId: { type: 'string', description: 'Target instance' },
            ref: { type: 'string', description: 'Element ref to hover over' },
          },
          required: ['instanceId', 'ref'],
        },
      },
      {
        name: 'page_press_key',
        description: 'Press a key or key combination (e.g. "Enter", "Control+a", "Escape").',
        inputSchema: {
          type: 'object' as const,
          properties: {
            instanceId: { type: 'string', description: 'Target instance' },
            key: { type: 'string', description: 'Key or combination (e.g. "Enter", "Control+a")' },
          },
          required: ['instanceId', 'key'],
        },
      },
      {
        name: 'page_drag',
        description: 'Drag an element and drop it onto another element.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            instanceId: { type: 'string', description: 'Target instance' },
            startRef: { type: 'string', description: 'Ref of the element to drag' },
            endRef: { type: 'string', description: 'Ref of the element to drop onto' },
          },
          required: ['instanceId', 'startRef', 'endRef'],
        },
      },
      {
        name: 'page_file_upload',
        description: 'Upload one or multiple files via a file input element.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            instanceId: { type: 'string', description: 'Target instance' },
            ref: { type: 'string', description: 'Ref of the file input element' },
            paths: { type: 'array', items: { type: 'string' }, description: 'Absolute paths of files to upload' },
          },
          required: ['instanceId', 'ref', 'paths'],
        },
      },
      {
        name: 'page_fill_form',
        description: 'Fill multiple form fields at once.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            instanceId: { type: 'string', description: 'Target instance' },
            fields: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  ref: { type: 'string', description: 'Element ref' },
                  type: { type: 'string', enum: ['textbox', 'checkbox', 'radio', 'combobox', 'slider'], description: 'Type of the field' },
                  value: { type: 'string', description: 'Value to fill' },
                },
                required: ['ref', 'value'],
              },
              description: 'Fields to fill',
            },
          },
          required: ['instanceId', 'fields'],
        },
      },
      // ── Page Wait ──
      {
        name: 'page_wait',
        description: 'Wait for text to appear, disappear, or a specified time.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            instanceId: { type: 'string', description: 'Target instance' },
            text: { type: 'string', description: 'Text to wait for (appears)' },
            textGone: { type: 'string', description: 'Text to wait to disappear' },
            timeout: { type: 'number', description: 'Max wait time in ms. Default: 10000' },
            time: { type: 'number', description: 'Fixed wait time in seconds' },
          },
          required: ['instanceId'],
        },
      },
      // ── Page Evaluate ──
      {
        name: 'page_evaluate',
        description: 'Evaluate a JavaScript expression in the page context. Returns JSON-serializable result.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            instanceId: { type: 'string', description: 'Target instance' },
            expression: { type: 'string', description: 'JavaScript expression to evaluate' },
          },
          required: ['instanceId', 'expression'],
        },
      },
      // ── Page Window ──
      {
        name: 'page_maximize',
        description: 'Maximize the browser window for an instance via CDP protocol.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            instanceId: { type: 'string', description: 'Target instance' },
          },
          required: ['instanceId'],
        },
      },
      {
        name: 'page_resize',
        description: 'Resize the browser viewport for an instance.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            instanceId: { type: 'string', description: 'Target instance' },
            width: { type: 'number', description: 'Viewport width in pixels' },
            height: { type: 'number', description: 'Viewport height in pixels' },
          },
          required: ['instanceId', 'width', 'height'],
        },
      },
      // ── Dialog ──
      {
        name: 'page_handle_dialog',
        description: 'Handle a browser dialog (alert, confirm, prompt). Must be called when a dialog is open.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            instanceId: { type: 'string', description: 'Target instance' },
            accept: { type: 'boolean', description: 'Whether to accept (true) or dismiss (false) the dialog' },
            promptText: { type: 'string', description: 'Text to enter for prompt dialogs' },
          },
          required: ['instanceId', 'accept'],
        },
      },
      // ── Console & Network ──
      {
        name: 'page_console_messages',
        description: 'Return all console messages captured from the page.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            instanceId: { type: 'string', description: 'Target instance' },
            level: { type: 'string', enum: ['error', 'warning', 'info', 'debug'], description: 'Filter by level. Default: info' },
          },
          required: ['instanceId'],
        },
      },
      {
        name: 'page_network_requests',
        description: 'Return all network requests since the page was loaded.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            instanceId: { type: 'string', description: 'Target instance' },
            includeStatic: { type: 'boolean', description: 'Include static resources. Default: false' },
          },
          required: ['instanceId'],
        },
      },
      // ── Advanced ──
      {
        name: 'page_run_code',
        description: 'Run a Playwright code snippet against the instance page. For advanced use cases.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            instanceId: { type: 'string', description: 'Target instance' },
            code: { type: 'string', description: 'Async function body receiving (page) parameter. E.g. "async (page) => { return await page.title(); }"' },
          },
          required: ['instanceId', 'code'],
        },
      },
      // ── Mouse coordinate actions ──
      {
        name: 'page_mouse_click_xy',
        description: 'Click at specific coordinates on the page.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            instanceId: { type: 'string', description: 'Target instance' },
            x: { type: 'number', description: 'X coordinate' },
            y: { type: 'number', description: 'Y coordinate' },
            button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Mouse button. Default: left' },
          },
          required: ['instanceId', 'x', 'y'],
        },
      },
      {
        name: 'page_mouse_move_xy',
        description: 'Move the mouse to specific coordinates.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            instanceId: { type: 'string', description: 'Target instance' },
            x: { type: 'number', description: 'X coordinate' },
            y: { type: 'number', description: 'Y coordinate' },
          },
          required: ['instanceId', 'x', 'y'],
        },
      },
      {
        name: 'page_mouse_drag_xy',
        description: 'Drag from one point to another using coordinates.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            instanceId: { type: 'string', description: 'Target instance' },
            startX: { type: 'number', description: 'Start X coordinate' },
            startY: { type: 'number', description: 'Start Y coordinate' },
            endX: { type: 'number', description: 'End X coordinate' },
            endY: { type: 'number', description: 'End Y coordinate' },
          },
          required: ['instanceId', 'startX', 'startY', 'endX', 'endY'],
        },
      },
      // ── PDF ──
      {
        name: 'page_pdf_save',
        description: 'Save the page as a PDF file.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            instanceId: { type: 'string', description: 'Target instance' },
            filePath: { type: 'string', description: 'Absolute path to save the PDF' },
          },
          required: ['instanceId', 'filePath'],
        },
      },
      // ── Verification ──
      {
        name: 'page_verify_text_visible',
        description: 'Verify that text is visible on the page.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            instanceId: { type: 'string', description: 'Target instance' },
            text: { type: 'string', description: 'Text to verify' },
          },
          required: ['instanceId', 'text'],
        },
      },
      {
        name: 'page_verify_element_visible',
        description: 'Verify that an element with a specific role and name is visible.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            instanceId: { type: 'string', description: 'Target instance' },
            role: { type: 'string', description: 'ARIA role of the element' },
            accessibleName: { type: 'string', description: 'Accessible name of the element' },
          },
          required: ['instanceId', 'role'],
        },
      },
      {
        name: 'page_verify_value',
        description: 'Verify the value of a form element.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            instanceId: { type: 'string', description: 'Target instance' },
            ref: { type: 'string', description: 'Element ref from page_snapshot' },
            value: { type: 'string', description: 'Expected value' },
          },
          required: ['instanceId', 'ref', 'value'],
        },
      },
      // ── Locator & Tracing ──
      {
        name: 'page_generate_locator',
        description: 'Generate a Playwright locator string for the given element.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            instanceId: { type: 'string', description: 'Target instance' },
            ref: { type: 'string', description: 'Element ref from page_snapshot' },
          },
          required: ['instanceId', 'ref'],
        },
      },
      {
        name: 'page_start_tracing',
        description: 'Start a Playwright trace recording for debugging.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            instanceId: { type: 'string', description: 'Target instance' },
          },
          required: ['instanceId'],
        },
      },
      {
        name: 'page_stop_tracing',
        description: 'Stop the trace recording and save to file.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            instanceId: { type: 'string', description: 'Target instance' },
            filePath: { type: 'string', description: 'Path to save the trace file (.zip)' },
          },
          required: ['instanceId', 'filePath'],
        },
      },
    ],
  }));

  // ── Tool Handlers ─────────────────────────────────────────────────────

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      switch (name) {
        // ── Connection ──
        case 'browser_connect': {
          const cdpUrl = (args?.cdpUrl as string) || 'http://localhost:9222';
          const pageIndex = (args?.pageIndex as number) || 0;
          const authState = await manager.connectToChrome(cdpUrl, pageIndex);
          return ok(`Connected to Chrome at ${cdpUrl}.\nExtracted ${authState.cookies.length} cookies from ${authState.origins.length} origins.\nNew instances will automatically inherit auth state.`);
        }

        // ── Instance Management ──
        case 'instance_create': {
          const instanceId = args?.instanceId as string;
          const url = args?.url as string | undefined;
          const cloneAuth = args?.cloneAuth !== false;
          const instance = await manager.createInstance(instanceId, url, cloneAuth);
          return ok(`Instance "${instanceId}" created.${url ? `\nNavigated to: ${url}` : ''}\nAuth cloned: ${cloneAuth && manager.hasAuth}\nURL: ${instance.url}`);
        }

        case 'instance_list': {
          const instances = await manager.listInstances();
          if (instances.length === 0) {
            return ok('No active instances.');
          }
          const lines = instances.map(i => `• ${i.id}: ${i.title} (${i.url}) [created: ${i.createdAt}]`);
          return ok(`Active instances (${instances.length}):\n${lines.join('\n')}`);
        }

        case 'instance_close': {
          const instanceId = args?.instanceId as string;
          await manager.closeInstance(instanceId);
          return ok(`Instance "${instanceId}" closed.`);
        }

        case 'instance_close_all': {
          const count = await manager.closeAll();
          return ok(`Closed ${count} instance(s).`);
        }

        // ── Page Navigation ──
        case 'page_navigate': {
          const { instanceId, url, waitUntil } = args as any;
          const instance = manager.getInstance(instanceId);
          await instance.page.goto(url, { waitUntil: waitUntil || 'domcontentloaded' });
          const title = await instance.page.title();
          return ok(`Navigated to: ${url}\nTitle: ${title}`);
        }

        case 'page_navigate_back': {
          const { instanceId } = args as any;
          const instance = manager.getInstance(instanceId);
          await instance.page.goBack();
          return ok(`Navigated back. Current URL: ${instance.page.url()}`);
        }

        // ── Page Snapshot & Screenshot ──
        case 'page_snapshot': {
          const { instanceId } = args as any;
          const instance = manager.getInstance(instanceId);
          const snapshot = await takeSnapshot(instance.page);
          const url = instance.page.url();
          const title = await instance.page.title();
          return ok(`[Instance: ${instanceId}] Page: ${title}\nURL: ${url}\n\n${snapshot}`);
        }

        case 'page_screenshot': {
          const { instanceId, filePath, ref, fullPage } = args as any;
          const instance = manager.getInstance(instanceId);

          const dir = path.dirname(filePath);
          if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
          }

          if (ref) {
            const element = await resolveRef(instance.page, ref);
            await element.screenshot({ path: filePath });
          } else {
            await instance.page.screenshot({ path: filePath, fullPage: fullPage || false });
          }
          return ok(`Screenshot saved to: ${filePath}`);
        }

        // ── Page Interactions ──
        case 'page_click': {
          const { instanceId, ref, button, doubleClick, modifiers } = args as any;
          const instance = manager.getInstance(instanceId);
          const element = await resolveRef(instance.page, ref);
          const options: any = {};
          if (button) options.button = button;
          if (modifiers) options.modifiers = modifiers;
          if (doubleClick) {
            await element.dblclick(options);
          } else {
            await element.click(options);
          }
          return ok(`Clicked element [${ref}] in instance "${instanceId}".`);
        }

        case 'page_fill': {
          const { instanceId, ref, value } = args as any;
          const instance = manager.getInstance(instanceId);
          const element = await resolveRef(instance.page, ref);
          await element.fill(value);
          return ok(`Filled element [${ref}] with "${value}" in instance "${instanceId}".`);
        }

        case 'page_type': {
          const { instanceId, ref, text, submit, slowly } = args as any;
          const instance = manager.getInstance(instanceId);
          const element = await resolveRef(instance.page, ref);
          if (slowly) {
            await element.pressSequentially(text, { delay: 50 });
          } else {
            await element.fill(text);
          }
          if (submit) {
            await element.press('Enter');
          }
          return ok(`Typed "${text}" into element [${ref}] in instance "${instanceId}".${submit ? ' (submitted)' : ''}`);
        }

        case 'page_select_option': {
          const { instanceId, ref, values } = args as any;
          const instance = manager.getInstance(instanceId);
          const element = await resolveRef(instance.page, ref);
          await element.selectOption(values);
          return ok(`Selected option(s) [${values.join(', ')}] in element [${ref}].`);
        }

        case 'page_hover': {
          const { instanceId, ref } = args as any;
          const instance = manager.getInstance(instanceId);
          const element = await resolveRef(instance.page, ref);
          await element.hover();
          return ok(`Hovered over element [${ref}] in instance "${instanceId}".`);
        }

        case 'page_press_key': {
          const { instanceId, key } = args as any;
          const instance = manager.getInstance(instanceId);
          await instance.page.keyboard.press(key);
          return ok(`Pressed key "${key}" in instance "${instanceId}".`);
        }

        case 'page_drag': {
          const { instanceId, startRef, endRef } = args as any;
          const instance = manager.getInstance(instanceId);
          const source = await resolveRef(instance.page, startRef);
          const target = await resolveRef(instance.page, endRef);
          await source.dragTo(target);
          return ok(`Dragged element [${startRef}] to [${endRef}] in instance "${instanceId}".`);
        }

        case 'page_file_upload': {
          const { instanceId, ref, paths: filePaths } = args as any;
          const instance = manager.getInstance(instanceId);
          const element = await resolveRef(instance.page, ref);
          await element.setInputFiles(filePaths);
          return ok(`Uploaded ${filePaths.length} file(s) to element [${ref}].`);
        }

        case 'page_fill_form': {
          const { instanceId, fields } = args as any;
          const instance = manager.getInstance(instanceId);
          for (const field of fields) {
            const element = await resolveRef(instance.page, field.ref);
            const fieldType = field.type || 'textbox';
            switch (fieldType) {
              case 'checkbox':
                if (field.value === 'true') await element.check();
                else await element.uncheck();
                break;
              case 'radio':
                await element.check();
                break;
              case 'combobox':
                await element.selectOption(field.value);
                break;
              case 'slider':
                await element.fill(field.value);
                break;
              default:
                await element.fill(field.value);
            }
          }
          return ok(`Filled ${fields.length} form field(s) in instance "${instanceId}".`);
        }

        // ── Page Wait ──
        case 'page_wait': {
          const { instanceId, text, textGone, timeout, time } = args as any;
          const instance = manager.getInstance(instanceId);
          if (time) {
            await new Promise(resolve => setTimeout(resolve, time * 1000));
            return ok(`Waited ${time} seconds in instance "${instanceId}".`);
          }
          if (text) {
            await instance.page.waitForSelector(`text=${text}`, { timeout: timeout || 10000 });
            return ok(`Text "${text}" appeared in instance "${instanceId}".`);
          }
          if (textGone) {
            await instance.page.waitForSelector(`text=${textGone}`, { state: 'hidden', timeout: timeout || 10000 });
            return ok(`Text "${textGone}" disappeared in instance "${instanceId}".`);
          }
          return ok('Nothing to wait for.');
        }

        // ── Page Evaluate ──
        case 'page_evaluate': {
          const { instanceId, expression } = args as any;
          const instance = manager.getInstance(instanceId);
          const result = await instance.page.evaluate(expression);
          return ok(`Result: ${JSON.stringify(result, null, 2)}`);
        }

        // ── Page Window ──
        case 'page_maximize': {
          const { instanceId } = args as any;
          const instance = manager.getInstance(instanceId);
          // Use CDP to maximize the window
          const cdpSession = await instance.page.context().newCDPSession(instance.page);
          const { windowId } = await cdpSession.send('Browser.getWindowForTarget') as any;
          await cdpSession.send('Browser.setWindowBounds', {
            windowId,
            bounds: { windowState: 'maximized' },
          });
          return ok(`Maximized window for instance "${instanceId}".`);
        }

        case 'page_resize': {
          const { instanceId, width, height } = args as any;
          const instance = manager.getInstance(instanceId);
          await instance.page.setViewportSize({ width, height });
          return ok(`Resized viewport to ${width}x${height} for instance "${instanceId}".`);
        }

        // ── Dialog ──
        case 'page_handle_dialog': {
          const { instanceId, accept, promptText } = args as any;
          const instance = manager.getInstance(instanceId);
          // Set up dialog handler for the next dialog
          instance.page.once('dialog', async dialog => {
            if (accept) {
              await dialog.accept(promptText);
            } else {
              await dialog.dismiss();
            }
          });
          return ok(`Dialog handler set for instance "${instanceId}". Will ${accept ? 'accept' : 'dismiss'} next dialog.`);
        }

        // ── Console & Network ──
        case 'page_console_messages': {
          const { instanceId, level } = args as any;
          const instance = manager.getInstance(instanceId);
          // Note: Console messages need to be captured from the start.
          // We'll collect them going forward
          const messages: string[] = [];
          const consoleLevel = level || 'info';
          const severityOrder = ['debug', 'info', 'warning', 'error'];
          const minLevel = severityOrder.indexOf(consoleLevel);

          // Evaluate to get any current console errors from the page
          const logEntries = await instance.page.evaluate(() => {
            return (window as any).__mcpConsoleLogs || [];
          });

          if (logEntries.length === 0) {
            // Inject console capture script
            await instance.page.evaluate(() => {
              (window as any).__mcpConsoleLogs = [];
              const originalLog = console.log;
              const originalWarn = console.warn;
              const originalError = console.error;
              const originalDebug = console.debug;
              const pushLog = (level: string, ...args: any[]) => {
                (window as any).__mcpConsoleLogs.push({
                  level,
                  message: args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' '),
                  timestamp: new Date().toISOString(),
                });
              };
              console.log = (...args) => { pushLog('info', ...args); originalLog.apply(console, args); };
              console.warn = (...args) => { pushLog('warning', ...args); originalWarn.apply(console, args); };
              console.error = (...args) => { pushLog('error', ...args); originalError.apply(console, args); };
              console.debug = (...args) => { pushLog('debug', ...args); originalDebug.apply(console, args); };
            });
            return ok('Console capture started. Call again to retrieve messages.');
          }

          const filtered = logEntries.filter((entry: any) => {
            return severityOrder.indexOf(entry.level) >= minLevel;
          });

          return ok(`Console messages (${filtered.length}):\n${filtered.map((e: any) => `[${e.level}] ${e.timestamp}: ${e.message}`).join('\n')}`);
        }

        case 'page_network_requests': {
          const { instanceId, includeStatic } = args as any;
          const instance = manager.getInstance(instanceId);

          // Collect network requests using Performance API
          const requests = await instance.page.evaluate((includeStatic: boolean) => {
            const entries = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
            const staticExtensions = ['.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.woff', '.woff2', '.ttf', '.eot', '.css', '.js'];
            return entries
              .filter(e => {
                if (!includeStatic) {
                  const url = new URL(e.name);
                  return !staticExtensions.some(ext => url.pathname.endsWith(ext));
                }
                return true;
              })
              .map(e => ({
                url: e.name,
                type: e.initiatorType,
                duration: Math.round(e.duration),
                size: e.transferSize,
              }));
          }, includeStatic || false);

          return ok(`Network requests (${requests.length}):\n${requests.map((r: any) => `${r.type} ${r.url} (${r.duration}ms, ${r.size}B)`).join('\n')}`);
        }

        // ── Advanced ──
        case 'page_run_code': {
          const { instanceId, code } = args as any;
          const instance = manager.getInstance(instanceId);
          const fn = new Function('page', `return (${code})(page);`);
          const result = await fn(instance.page);
          return ok(`Code executed. Result: ${JSON.stringify(result, null, 2)}`);
        }

        // ── Mouse coordinate actions ──
        case 'page_mouse_click_xy': {
          const { instanceId, x, y, button } = args as any;
          const instance = manager.getInstance(instanceId);
          await instance.page.mouse.click(x, y, { button: button || 'left' });
          return ok(`Clicked at (${x}, ${y}) in instance "${instanceId}".`);
        }

        case 'page_mouse_move_xy': {
          const { instanceId, x, y } = args as any;
          const instance = manager.getInstance(instanceId);
          await instance.page.mouse.move(x, y);
          return ok(`Moved mouse to (${x}, ${y}) in instance "${instanceId}".`);
        }

        case 'page_mouse_drag_xy': {
          const { instanceId, startX, startY, endX, endY } = args as any;
          const instance = manager.getInstance(instanceId);
          await instance.page.mouse.move(startX, startY);
          await instance.page.mouse.down();
          await instance.page.mouse.move(endX, endY);
          await instance.page.mouse.up();
          return ok(`Dragged from (${startX}, ${startY}) to (${endX}, ${endY}) in instance "${instanceId}".`);
        }

        // ── PDF ──
        case 'page_pdf_save': {
          const { instanceId, filePath } = args as any;
          const instance = manager.getInstance(instanceId);
          const dir = path.dirname(filePath);
          if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
          }
          await instance.page.pdf({ path: filePath });
          return ok(`PDF saved to: ${filePath}`);
        }

        // ── Verification ──
        case 'page_verify_text_visible': {
          const { instanceId, text } = args as any;
          const instance = manager.getInstance(instanceId);
          const locator = instance.page.getByText(text);
          const isVisible = await locator.isVisible();
          if (isVisible) {
            return ok(`✅ Text "${text}" is visible on the page.`);
          } else {
            return err(`❌ Text "${text}" is NOT visible on the page.`);
          }
        }

        case 'page_verify_element_visible': {
          const { instanceId, role, accessibleName } = args as any;
          const instance = manager.getInstance(instanceId);
          const options: any = {};
          if (accessibleName) options.name = accessibleName;
          const locator = instance.page.getByRole(role, options);
          const isVisible = await locator.isVisible();
          if (isVisible) {
            return ok(`✅ Element [role="${role}"${accessibleName ? ` name="${accessibleName}"` : ''}] is visible.`);
          } else {
            return err(`❌ Element [role="${role}"${accessibleName ? ` name="${accessibleName}"` : ''}] is NOT visible.`);
          }
        }

        case 'page_verify_value': {
          const { instanceId, ref, value } = args as any;
          const instance = manager.getInstance(instanceId);
          const element = await resolveRef(instance.page, ref);
          const actual = await element.inputValue();
          if (actual === value) {
            return ok(`✅ Element [${ref}] value matches: "${value}".`);
          } else {
            return err(`❌ Element [${ref}] value mismatch. Expected: "${value}", Actual: "${actual}".`);
          }
        }

        // ── Locator ──
        case 'page_generate_locator': {
          const { instanceId, ref } = args as any;
          const instance = manager.getInstance(instanceId);
          const element = await resolveRef(instance.page, ref);
          // Generate a best-effort locator
          const tagName = await element.evaluate((el: Element) => el.tagName.toLowerCase());
          const id = await element.getAttribute('id');
          const name = await element.getAttribute('name');
          const text = await element.textContent();
          const role = await element.getAttribute('role');
          const ariaLabel = await element.getAttribute('aria-label');
          const placeholder = await element.getAttribute('placeholder');
          const testId = await element.getAttribute('data-testid');

          let locator = '';
          if (testId) {
            locator = `page.getByTestId('${testId}')`;
          } else if (id) {
            locator = `page.locator('#${id}')`;
          } else if (role && ariaLabel) {
            locator = `page.getByRole('${role}', { name: '${ariaLabel}' })`;
          } else if (ariaLabel) {
            locator = `page.getByLabel('${ariaLabel}')`;
          } else if (placeholder) {
            locator = `page.getByPlaceholder('${placeholder}')`;
          } else if (name) {
            locator = `page.locator('[name="${name}"]')`;
          } else if (text && text.trim().length < 50) {
            locator = `page.getByText('${text.trim()}')`;
          } else {
            locator = `page.locator('${tagName}')`;
          }
          return ok(`Locator: ${locator}`);
        }

        // ── Tracing ──
        case 'page_start_tracing': {
          const { instanceId } = args as any;
          const instance = manager.getInstance(instanceId);
          await instance.context.tracing.start({ screenshots: true, snapshots: true });
          return ok(`Tracing started for instance "${instanceId}".`);
        }

        case 'page_stop_tracing': {
          const { instanceId, filePath } = args as any;
          const instance = manager.getInstance(instanceId);
          const dir = path.dirname(filePath);
          if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
          }
          await instance.context.tracing.stop({ path: filePath });
          return ok(`Tracing saved to: ${filePath}`);
        }

        default:
          return err(`Unknown tool: ${name}`);
      }
    } catch (error) {
      return err(`Error in ${name}: ${(error as Error).message}`);
    }
  });

  // Cleanup on close
  process.on('SIGINT', async () => {
    await manager.dispose();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    await manager.dispose();
    process.exit(0);
  });

  return server;
}

// ── Helpers ──────────────────────────────────────────────────────────────

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text }], isError: true };
}

/**
 * Resolve an element ref (e.g. "e5") to a Playwright Locator.
 * Since we use the accessibility tree, we use role-based selectors as fallback.
 * The ref system works by re-taking a snapshot and matching by index.
 */
async function resolveRef(page: any, ref: string): Promise<any> {
  // Extract the numeric index from the ref
  const match = ref.match(/^e(\d+)$/);
  if (!match) {
    throw new Error(`Invalid ref format: "${ref}". Expected format like "e0", "e5", etc.`);
  }

  const targetIndex = parseInt(match[1], 10);

  // Get the accessibility tree and find the element by index
  const snapshot = await page.accessibility.snapshot({ interestingOnly: true });
  if (!snapshot) {
    throw new Error('Page has no accessible content.');
  }

  const interactiveRoles = new Set([
    'button', 'link', 'textbox', 'checkbox', 'radio', 'combobox',
    'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option',
    'slider', 'spinbutton', 'switch', 'tab', 'treeitem',
    'searchbox', 'textarea',
  ]);

  // Flatten the tree and collect interactive elements
  const interactiveElements: any[] = [];
  function collectInteractive(node: any) {
    if (interactiveRoles.has(node.role)) {
      interactiveElements.push(node);
    }
    if (node.children) {
      for (const child of node.children) {
        collectInteractive(child);
      }
    }
  }
  collectInteractive(snapshot);

  if (targetIndex >= interactiveElements.length) {
    throw new Error(`Ref "${ref}" not found. Only ${interactiveElements.length} interactive elements on page. Try page_snapshot to see current refs.`);
  }

  const target = interactiveElements[targetIndex];

  // Build a locator for this element
  const role = target.role;
  const name = target.name;

  if (name) {
    return page.getByRole(role, { name, exact: true }).first();
  } else {
    return page.getByRole(role).nth(
      interactiveElements.filter((e, i) => i <= targetIndex && e.role === role && !e.name).length - 1
    );
  }
}
