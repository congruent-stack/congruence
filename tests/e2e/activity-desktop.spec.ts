import { test, expect } from '@playwright/test';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { PublishActivity } from '../../packages/contracts/src/index.js';
import { buildApp } from '../../apps/server/src/app.js';
import { FakeCodex } from '../helpers/fake-codex.js';
import { FakeDesktop } from '../helpers/fake-desktop.js';

test('opens each reported desktop session before the message action without requiring messaging settings', async ({
  page,
}) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'congruence-desktop-links-'));
  const desktop = new FakeDesktop();
  const codex = new FakeCodex();
  const app = await buildApp({ dataDir, codexAdapter: codex, desktopAdapter: desktop, mcp: false });
  try {
    const url = await app.listen({ host: '127.0.0.1', port: 0 });
    const workspace = await app.store.createWorkspace({
      name: 'Desktop links',
      description: '',
      repositories: [],
    });
    await app.inject({
      method: 'PUT',
      url: '/api/agent-settings',
      payload: {
        codexCommand: '',
        codexUrl: 'ws://127.0.0.1:4500',
        codexSocket: '',
      },
    });
    const fixtures: Array<
      Pick<PublishActivity, 'source' | 'agentTarget' | 'desktopSession'> & { title: string }
    > = [
      {
        title: 'Codex activity',
        source: 'codex',
        agentTarget: { provider: 'codex-desktop', sessionId: 'desktop-chat' },
      },
      {
        title: 'Claude desktop activity',
        source: 'claude',
        agentTarget: { provider: 'claude-desktop', sessionId: 'local_actual-desktop-chat' },
      },
      {
        title: 'Claude desktop report',
        source: 'claude',
        desktopSession: { provider: 'claude', sessionId: 'local_reported-chat' },
      },
      { title: 'Claude CLI activity', source: 'claude' },
      {
        title: 'Shared server activity',
        source: 'codex',
        agentTarget: { provider: 'codex', sessionId: 'remote-chat' },
      },
      { title: 'Unlinked activity', source: 'codex' },
    ];
    for (const fixture of fixtures)
      await app.store.publishActivity({
        ...fixture,
        workspaceId: workspace.id,
        summary: 'Ready to open the original session.',
        status: 'done',
      });
    await page.goto(url);
    const reader = page.locator('article.activity-reader');
    await page.getByRole('button', { name: 'Codex activity', exact: true }).click();
    const codexLink = reader.getByRole('link', { name: 'Open in Codex' });
    await expect(codexLink).toHaveAttribute('href', 'codex://threads/desktop-chat');
    await expect(reader.getByRole('button', { name: 'Message agent', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: 'Claude desktop activity', exact: true }).click();
    await expect(reader.getByRole('link', { name: 'Open in Claude' })).toHaveAttribute(
      'href',
      'claude://code/continue?session=local_actual-desktop-chat',
    );
    await page.getByRole('button', { name: 'Claude desktop report', exact: true }).click();
    await expect(reader.getByRole('link', { name: 'Open in Claude' })).toHaveAttribute(
      'href',
      'claude://code/continue?session=local_reported-chat',
    );
    for (const title of ['Claude CLI activity', 'Shared server activity', 'Unlinked activity']) {
      await page.getByRole('button', { name: title, exact: true }).click();
      await expect(
        reader.getByRole('button', { name: 'Open in desktop', exact: true }),
      ).toBeDisabled();
      await expect(reader.getByRole('link')).toHaveCount(0);
    }
    // Inspect and activate the link without handing the test off to a real desktop app.
    await page.getByRole('button', { name: 'Codex activity', exact: true }).click();
    await codexLink.evaluate((link) =>
      link.addEventListener('click', (event) => event.preventDefault()),
    );
    await codexLink.click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(desktop.sent).toHaveLength(0);
    expect(codex.sent).toHaveLength(0);
    expect(
      await reader
        .locator('.message-agent-actions')
        .evaluate((actions) => actions.firstElementChild?.textContent),
    ).toBe('Open in Codex');
    await mkdir(resolve('.local/screenshots'), { recursive: true });
    await page.screenshot({
      path: resolve('.local/screenshots/activity-desktop-links.png'),
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({
      path: resolve('.local/screenshots/activity-desktop-links-mobile.png'),
      fullPage: true,
    });
  } finally {
    await page.close();
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
