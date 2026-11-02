import { test, expect } from '@playwright/test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildApp } from '../../apps/server/src/app.js';
import { FakeCodex } from '../helpers/fake-codex.js';
import { FakeDesktop } from '../helpers/fake-desktop.js';

test('disables messaging until settings are saved in Agents and updates when cleared', async ({
  page,
}) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'congruence-settings-ui-'));
  const desktop = new FakeDesktop();
  const app = await buildApp({
    dataDir,
    claudeSettingsPath: join(dataDir, 'claude-settings.json'),
    codexAdapter: new FakeCodex(),
    desktopAdapter: desktop,
    mcp: false,
  });
  try {
    const url = await app.listen({ host: '127.0.0.1', port: 0 });
    const workspace = await app.store.createWorkspace({
      name: 'Settings test',
      description: '',
      repositories: [],
    });
    await app.store.publishActivity({
      workspaceId: workspace.id,
      source: 'codex',
      title: 'Linked chat recovery',
      summary: '',
      status: 'done',
      agentTarget: { provider: 'codex-desktop', sessionId: 'desktop-chat' },
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
    await page.goto(url);
    await page.getByRole('button', { name: /Linked chat recovery/ }).click();
    const messageButton = page.getByRole('button', { name: 'Message agent', exact: true });
    await expect(messageButton).toBeDisabled();
    const warning = page.getByLabel('Agent settings are empty.', { exact: false });
    await warning.hover();
    await expect(page.getByRole('tooltip')).toContainText('Open Agents → Agent settings');
    await warning.focus();
    await expect(page.getByRole('tooltip')).toBeVisible();
    await messageButton.dispatchEvent('click');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await mkdir(resolve('.local/screenshots'), { recursive: true });
    await page.screenshot({ path: resolve('.local/screenshots/message-agent-disabled.png') });
    await page.getByRole('button', { name: 'Agents', exact: true }).click();
    await page.getByRole('button', { name: 'Agent settings', exact: true }).click();
    await page.getByLabel('Codex executable', { exact: true }).fill('C:/Codex/codex.exe');
    await page.getByRole('button', { name: 'Save and test', exact: true }).click();
    await page.getByRole('button', { name: 'Close dialog' }).click();
    await expect(messageButton).toBeEnabled();
    await expect(warning).toHaveCount(0);
    await messageButton.click();
    await expect(page.getByRole('group', { name: 'Linked agent session' })).toContainText(
      'Codex Desktop · Existing Desktop chat',
    );
    await expect(page.getByLabel('Codex executable', { exact: true })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Agent settings', exact: true })).toHaveCount(0);
    desktop.sessions[0].name = 'Refreshed Desktop chat';
    await page.getByRole('button', { name: 'Change', exact: true }).click();
    await expect(page.getByRole('option', { name: /Refreshed Desktop chat/ })).toHaveCount(1);
    await page.getByRole('button', { name: 'Close dialog' }).click();
    await page.getByRole('button', { name: 'Agents', exact: true }).click();
    const dialog = page.getByRole('dialog');
    const navigation = dialog.getByRole('navigation', { name: 'Agent sections' });
    const desktopTab = dialog.getByRole('tab', { name: 'Codex Desktop', exact: true });
    const cliTab = dialog.getByRole('tab', { name: 'Codex CLI', exact: true });
    const claudeTab = dialog.getByRole('tab', { name: 'Claude Code Desktop', exact: true });
    await expect(navigation.getByRole('button')).toHaveCount(2);
    await expect(navigation.getByRole('button', { name: 'MCP setup' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await expect(
      dialog.getByRole('tablist', { name: 'Agent provider' }).getByRole('tab'),
    ).toHaveCount(2);
    await expect(dialog.getByRole('tabpanel', { name: 'Codex Desktop' })).toBeVisible();
    await expect(dialog.getByText('Messaging setup', { exact: true })).toHaveCount(0);
    await mkdir(resolve('.local/screenshots'), { recursive: true });
    await dialog.getByRole('tab', { name: 'Manual setup', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Copy MCP endpoint' })).toBeVisible();
    await dialog.getByRole('tab', { name: 'Config file', exact: true }).click();
    await expect(page.getByLabel('Codex executable', { exact: true })).toBeHidden();
    await page
      .getByRole('dialog')
      .screenshot({ path: resolve('.local/screenshots/agents-setup-desktop.png') });
    await expect(cliTab).toHaveCount(0);
    // Provider tabs support the expected arrow, Home and End keys, including wrapping.
    await desktopTab.focus();
    await desktopTab.press('ArrowRight');
    await expect(claudeTab).toBeFocused();
    await expect(claudeTab).toHaveAttribute('aria-selected', 'true');
    await claudeTab.press('ArrowRight');
    await expect(desktopTab).toBeFocused();
    await desktopTab.press('ArrowLeft');
    await expect(claudeTab).toBeFocused();
    await claudeTab.press('Home');
    await expect(desktopTab).toBeFocused();
    await expect(desktopTab).toHaveAttribute('aria-selected', 'true');
    await navigation.getByRole('button', { name: 'Agent settings', exact: true }).click();
    await claudeTab.click();
    await expect(
      dialog.getByRole('tabpanel', { name: 'Claude Code Desktop', exact: true }),
    ).toContainText('Not installed · 0 connected sessions');
    await expect(dialog.getByRole('tab', { name: 'Claude Code', exact: true })).toHaveCount(0);
    await desktopTab.click();
    await expect(page.getByLabel('Codex executable', { exact: true })).toHaveValue(
      'C:/Codex/codex.exe',
    );
    await page
      .getByRole('dialog')
      .screenshot({ path: resolve('.local/screenshots/agents-settings-desktop.png') });
    await page.getByRole('button', { name: 'Save and test', exact: true }).click();
    await expect(dialog.getByRole('tabpanel').getByRole('status')).toContainText(
      'Connection working. Found 1 Desktop chat',
    );
    await expect(cliTab).toHaveCount(0);
    await expect(page.getByLabel('Shared App Server URL', { exact: true })).toHaveCount(0);
    await navigation.getByRole('button', { name: 'MCP setup' }).click();
    await expect(cliTab).toHaveCount(0);
    await expect(desktopTab).toHaveAttribute('aria-selected', 'true');
    await navigation.getByRole('button', { name: 'Agent settings' }).click();
    const history = dialog.locator('details.settings-history');
    await expect(history).toHaveJSProperty('open', false);
    await expect(dialog.getByText('No past requests', { exact: true })).toBeHidden();
    await history.locator(':scope > summary').click();
    await expect(desktopTab).toHaveAttribute('aria-selected', 'true');
    await expect(dialog.getByText('No past requests', { exact: true })).toBeVisible();
    await history.locator(':scope > summary').click();
    await page.getByRole('button', { name: 'Clear Codex settings', exact: true }).click();
    await expect(dialog.getByRole('tabpanel').getByRole('status')).toContainText(
      'Codex settings cleared.',
    );
    await expect(page.getByLabel('Codex executable', { exact: true })).toHaveValue('');
    expect((await app.inject('/api/agent-settings')).json()).toMatchObject({
      codexCommand: '',
      codexSocket: '',
      codexUrl: 'ws://127.0.0.1:4500',
    });
    await expect(messageButton).toBeDisabled();
    await navigation.getByRole('button', { name: 'MCP setup' }).click();
    await desktopTab.click();
    await page.setViewportSize({ width: 390, height: 844 });
    await dialog.screenshot({ path: resolve('.local/screenshots/agents-setup-mobile.png') });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.setViewportSize({ width: 320, height: 640 });
    expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
      true,
    );
  } finally {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
