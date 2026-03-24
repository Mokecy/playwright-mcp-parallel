/**
 * BrowserInstanceManager - Manages multiple isolated browser instances
 * Each instance has its own BrowserContext with independent cookies, storage, etc.
 */

import { chromium, Browser, BrowserContext, Page, Cookie } from 'playwright';

export interface AuthState {
  cookies: Cookie[];
  localStorage: Record<string, Record<string, string>>;
  origins: string[];
}

export interface BrowserInstance {
  id: string;
  context: BrowserContext;
  page: Page;
  createdAt: Date;
  url: string;
  title: string;
}

export class BrowserInstanceManager {
  private instances: Map<string, BrowserInstance> = new Map();
  private connectedBrowser: Browser | null = null;
  private authState: AuthState | null = null;

  /**
   * Connect to an existing Chrome browser via CDP and extract auth state
   */
  async connectToChrome(cdpUrl: string = 'http://localhost:9222', pageIndex: number = 0): Promise<AuthState> {
    try {
      this.connectedBrowser = await chromium.connectOverCDP(cdpUrl);
      const contexts = this.connectedBrowser.contexts();

      if (contexts.length === 0) {
        throw new Error('No browser contexts found in the connected browser');
      }

      const context = contexts[0];
      const pages = context.pages();

      if (pages.length === 0) {
        throw new Error('No pages found in the connected browser');
      }

      const targetPage = pages[Math.min(pageIndex, pages.length - 1)];

      // Extract cookies
      const cookies = await context.cookies();

      // Extract localStorage from the target page
      const localStorage: Record<string, Record<string, string>> = {};
      try {
        const origin = new URL(targetPage.url()).origin;
        const storage = await targetPage.evaluate(() => {
          const items: Record<string, string> = {};
          for (let i = 0; i < window.localStorage.length; i++) {
            const key = window.localStorage.key(i);
            if (key) {
              items[key] = window.localStorage.getItem(key) || '';
            }
          }
          return items;
        });
        localStorage[origin] = storage;
      } catch (e) {
        // localStorage may not be accessible on some pages (e.g., about:blank)
      }

      // Collect all origins from cookies
      const origins = [...new Set(cookies.map(c => {
        const domain = c.domain.startsWith('.') ? c.domain.slice(1) : c.domain;
        return `https://${domain}`;
      }))];

      this.authState = { cookies, localStorage, origins };
      return this.authState;
    } catch (error) {
      throw new Error(`Failed to connect to Chrome at ${cdpUrl}: ${(error as Error).message}`);
    }
  }

  /**
   * Create a new isolated browser instance
   */
  async createInstance(instanceId: string, url?: string, cloneAuth: boolean = true): Promise<BrowserInstance> {
    if (this.instances.has(instanceId)) {
      throw new Error(`Instance "${instanceId}" already exists. Close it first or use a different ID.`);
    }

    // Launch a new browser for this instance
    const browser = await chromium.launch({
      headless: false,
      args: ['--no-first-run', '--no-default-browser-check'],
    });

    const contextOptions: any = {};

    // Clone auth state if requested and available
    if (cloneAuth && this.authState) {
      const storageState: any = {
        cookies: this.authState.cookies.map(c => ({
          name: c.name,
          value: c.value,
          domain: c.domain,
          path: c.path,
          expires: c.expires,
          httpOnly: c.httpOnly,
          secure: c.secure,
          sameSite: c.sameSite as 'Strict' | 'Lax' | 'None',
        })),
        origins: Object.entries(this.authState.localStorage).map(([origin, items]) => ({
          origin,
          localStorage: Object.entries(items).map(([name, value]) => ({ name, value })),
        })),
      };
      contextOptions.storageState = storageState;
    }

    const context = await browser.newContext(contextOptions);
    const page = await context.newPage();

    if (url) {
      await page.goto(url, { waitUntil: 'domcontentloaded' });
    }

    const instance: BrowserInstance = {
      id: instanceId,
      context,
      page,
      createdAt: new Date(),
      url: page.url(),
      title: await page.title(),
    };

    this.instances.set(instanceId, instance);
    return instance;
  }

  /**
   * Get an existing instance
   */
  getInstance(instanceId: string): BrowserInstance {
    const instance = this.instances.get(instanceId);
    if (!instance) {
      throw new Error(`Instance "${instanceId}" not found. Create it first with instance_create.`);
    }
    return instance;
  }

  /**
   * List all active instances
   */
  async listInstances(): Promise<Array<{ id: string; url: string; title: string; createdAt: string }>> {
    const list = [];
    for (const [id, instance] of this.instances) {
      try {
        instance.url = instance.page.url();
        instance.title = await instance.page.title();
      } catch {
        // page might be closed
      }
      list.push({
        id,
        url: instance.url,
        title: instance.title,
        createdAt: instance.createdAt.toISOString(),
      });
    }
    return list;
  }

  /**
   * Close a specific instance
   */
  async closeInstance(instanceId: string): Promise<void> {
    const instance = this.instances.get(instanceId);
    if (!instance) {
      throw new Error(`Instance "${instanceId}" not found.`);
    }

    try {
      const browser = instance.context.browser();
      await instance.context.close();
      if (browser) {
        await browser.close();
      }
    } catch {
      // ignore errors during close
    }

    this.instances.delete(instanceId);
  }

  /**
   * Close all instances
   */
  async closeAll(): Promise<number> {
    const count = this.instances.size;
    const ids = [...this.instances.keys()];
    for (const id of ids) {
      await this.closeInstance(id);
    }
    return count;
  }

  /**
   * Cleanup all resources
   */
  async dispose(): Promise<void> {
    await this.closeAll();
    if (this.connectedBrowser) {
      try {
        this.connectedBrowser.close();
      } catch {
        // ignore
      }
      this.connectedBrowser = null;
    }
  }

  get hasAuth(): boolean {
    return this.authState !== null;
  }

  get instanceCount(): number {
    return this.instances.size;
  }
}
