/**
 * SnapshotHelper - Takes accessibility snapshots of pages
 * Produces structured text output with interactive element refs
 */

import type { Page } from 'playwright';

export interface SnapshotResult {
  text: string;
  refs: Map<string, any>;
}

export async function takeSnapshot(page: Page): Promise<string> {
  try {
    // Use Playwright's accessibility snapshot via the page
    const snapshot = await (page as any).accessibility.snapshot({ interestingOnly: true });
    if (!snapshot) {
      return '[Empty page - no accessible content]';
    }
    return formatAccessibilityTree(snapshot, '', true);
  } catch (error) {
    // Fallback: build a basic snapshot from page content
    try {
      const title = await page.title();
      const url = page.url();

      // Try to get a basic structure from the page
      const basicInfo = await page.evaluate(() => {
        const elements: string[] = [];
        // Collect interactive elements
        document.querySelectorAll('a, button, input, select, textarea, [role]').forEach((el, i) => {
          const tag = el.tagName.toLowerCase();
          const role = el.getAttribute('role') || tag;
          const name = el.getAttribute('aria-label')
            || el.getAttribute('title')
            || (el as HTMLInputElement).placeholder
            || el.textContent?.trim().slice(0, 50)
            || '';
          const type = (el as HTMLInputElement).type || '';
          const value = (el as HTMLInputElement).value || '';
          elements.push(`[ref=e${i}] ${role}${type ? `[${type}]` : ''} "${name}"${value ? ` value="${value}"` : ''}`);
        });
        return elements;
      });

      let result = `Page: ${title}\nURL: ${url}\n\nInteractive elements:\n`;
      result += basicInfo.join('\n');
      return result;
    } catch {
      return '[Unable to take snapshot]';
    }
  }
}

function formatAccessibilityTree(node: any, indent: string = '', isRoot: boolean = false): string {
  let result = '';

  const role = node.role || '';
  const name = node.name || '';
  const value = node.value || '';
  const description = node.description || '';
  const checked = node.checked;
  const pressed = node.pressed;
  const level = node.level;
  const expanded = node.expanded;

  // Build the node line
  const parts: string[] = [];

  if (role && role !== 'none' && role !== 'generic') {
    parts.push(role);
  }

  if (name) {
    parts.push(`"${name}"`);
  }

  if (value) {
    parts.push(`value="${value}"`);
  }

  if (checked !== undefined) {
    parts.push(checked ? '[checked]' : '[unchecked]');
  }

  if (pressed !== undefined) {
    parts.push(pressed ? '[pressed]' : '[not pressed]');
  }

  if (level !== undefined) {
    parts.push(`(level ${level})`);
  }

  if (expanded !== undefined) {
    parts.push(expanded ? '[expanded]' : '[collapsed]');
  }

  if (description) {
    parts.push(`- ${description}`);
  }

  // Assign a ref for interactive elements
  const interactiveRoles = new Set([
    'button', 'link', 'textbox', 'checkbox', 'radio', 'combobox',
    'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option',
    'slider', 'spinbutton', 'switch', 'tab', 'treeitem',
    'searchbox', 'textarea',
  ]);

  let ref = '';
  if (interactiveRoles.has(role)) {
    ref = `[ref=${generateRef()}]`;
  }

  if (parts.length > 0) {
    const line = `${indent}${ref ? ref + ' ' : ''}${parts.join(' ')}`;
    result += line + '\n';
  }

  // Process children
  if (node.children) {
    const childIndent = isRoot ? indent : indent + '  ';
    for (const child of node.children) {
      result += formatAccessibilityTree(child, childIndent);
    }
  }

  return result;
}

let refCounter = 0;

function generateRef(): string {
  return `e${refCounter++}`;
}

export function resetRefCounter(): void {
  refCounter = 0;
}