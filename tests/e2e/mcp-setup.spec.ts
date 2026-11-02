import { test, expect } from '@playwright/test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildApp } from '../../apps/server/src/app.js';
import { FakeCodex } from '../helpers/fake-codex.js';

test('offers automatic and manual MCP setup, writes the displayed file and recovers from errors', async ({
  page,
}) => {
  const directory = await mkdtemp(join(tmpdir(), 'congruence-mcp-ui-'));
  const configPath = join(directory, 'config.toml');
  const app = await buildApp({
    dataDir: join(directory, 'data'),
    codexHome: directory,
    codexAdapter: new FakeCodex(),
    desktopAdapter: false,
    mcp: false,
  });
  try {
    const url = await app.listen({ host: '127.0.0.1', port: 0 });
    await app.store.createWorkspace({ name: 'MCP setup', description: '', repositories: [] });
    await page.goto(url);
    await page.getByRole('button', { name: 'Agents', exact: true }).click();
    const automatic = page.getByRole('region', { name: 'Automatic configuration' });
    const manual = page.getByRole('region', { name: 'Manual configuration' });
    await expect(automatic).toContainText(configPath);
    await expect(page.getByRole('heading', { name: 'Add Congruence', exact: true })).toHaveCount(0);
    const methodTabs = page.getByRole('tablist', { name: 'Setup method' });
    const configTab = methodTabs.getByRole('tab', { name: 'Config file', exact: true });
    const manualTab = methodTabs.getByRole('tab', { name: 'Manual setup', exact: true });
    await configTab.focus();
    await configTab.press('ArrowRight');
    await expect(manualTab).toBeFocused();
    await expect(automatic).toBeHidden();
    await expect(manual).toContainText('Settings → Plugins → MCPs');
    await expect(manual).toContainText(`${url}/mcp`);
    await page
      .getByRole('dialog')
      .screenshot({ path: resolve('.local/screenshots/agents-mcp-manual-tab.png') });
    await manualTab.press('Home');
    await expect(configTab).toBeFocused();
    await expect(manual).toBeHidden();
    const add = automatic.getByRole('button', {
      name: 'Apply',
      exact: true,
    });
    const preview = automatic
      .locator('.copy-block code')
      .filter({ hasText: '[mcp_servers.congruence]' });
    await expect(preview).toHaveText(
      `[mcp_servers.congruence]\nenabled = true\nurl = "${url}/mcp"`,
    );
    await expect(
      automatic.getByRole('button', { name: 'Copy MCP configuration', exact: true }),
    ).toBeVisible();
    await add.click();
    await expect(automatic.getByRole('status')).toContainText('Configuration saved');
    const saved = await readFile(configPath, 'utf8');
    expect(saved.trim()).toBe(await preview.textContent());
    expect(saved).toContain(`url = "${url}/mcp"`);
    await add.click();
    await expect(automatic.getByRole('status')).toContainText('Configuration saved');
    expect(await readFile(configPath, 'utf8')).toBe(saved);
    await writeFile(configPath, 'broken = [');
    await add.click();
    await expect(automatic.getByRole('alert')).toContainText('Check the TOML file');
    expect(await readFile(configPath, 'utf8')).toBe('broken = [');
    await writeFile(configPath, '# Keep my settings\nmodel = "example"\n');
    await add.click();
    await expect(automatic.getByRole('status')).toContainText('Restart Codex Desktop');
    expect(await readFile(configPath, 'utf8')).toContain('# Keep my settings\nmodel = "example"\n');
    const remove = automatic.getByRole('button', { name: 'Remove from config file', exact: true });
    await remove.click();
    await expect(automatic.getByRole('status')).toContainText('Congruence configuration removed');
    const removed = await readFile(configPath, 'utf8');
    expect(removed).not.toContain('mcp_servers.congruence');
    expect(removed).toContain('# Keep my settings\nmodel = "example"\n');
    await remove.click();
    await expect(automatic.getByRole('status')).toContainText('Congruence configuration removed');
    expect(await readFile(configPath, 'utf8')).toBe(removed);
    await add.click();
    await expect(automatic.getByRole('status')).toContainText('Configuration saved');
    await page
      .getByRole('dialog')
      .screenshot({ path: resolve('.local/screenshots/agents-mcp-setup-options.png') });
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('configures Claude Code Desktop, preserves existing settings, and shows its mod settings', async ({
  page,
}) => {
  const directory = await mkdtemp(join(tmpdir(), 'congruence-claude-mcp-ui-'));
  const configPath = join(directory, '.claude.json');
  const codexPath = join(directory, 'config.toml');
  const original = {
    theme: 'dark',
    projects: { 'D:/test': { trusted: true } },
    mcpServers: { other: { command: 'other', args: ['start'] } },
  };
  await writeFile(configPath, JSON.stringify(original, null, 2));
  await writeFile(codexPath, '# Codex settings\nmodel = "example"\n');
  const app = await buildApp({
    dataDir: join(directory, 'data'),
    claudeConfigPath: configPath,
    claudeSettingsPath: join(directory, 'settings.json'),
    codexHome: directory,
    codexAdapter: new FakeCodex(),
    desktopAdapter: false,
    mcp: false,
  });
  try {
    const url = await app.listen({ host: '127.0.0.1', port: 0 });
    await app.store.createWorkspace({
      name: 'Claude MCP setup',
      description: '',
      repositories: [],
    });
    await page.goto(url);
    await page.getByRole('button', { name: 'Agents', exact: true }).click();
    const dialog = page.getByRole('dialog');
    const claudeTab = dialog.getByRole('tab', { name: 'Claude Code Desktop', exact: true });
    await claudeTab.click();
    await expect(dialog.getByRole('tab', { name: 'Claude Code', exact: true })).toHaveCount(0);
    await expect(dialog.getByRole('tab', { name: 'Manual setup', exact: true })).toHaveCount(0);
    await expect(dialog.getByRole('tab', { name: 'Config file', exact: true })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    const automatic = dialog.getByRole('region', { name: 'Automatic configuration' });
    await expect(automatic).toContainText(configPath);
    const preview = automatic.locator('.copy-block code').filter({ hasText: 'mcpServers' });
    const snippet = { mcpServers: { congruence: { type: 'http', url: `${url}/mcp` } } };
    await expect(preview).toHaveText(JSON.stringify(snippet, null, 2));
    const apply = automatic.getByRole('button', { name: 'Apply', exact: true });
    await apply.click();
    await expect(automatic.getByRole('status')).toContainText('Configuration saved');
    expect(JSON.parse(await readFile(configPath, 'utf8'))).toEqual({
      ...original,
      mcpServers: { ...original.mcpServers, ...snippet.mcpServers },
    });
    const saved = await readFile(configPath, 'utf8');
    await apply.click();
    await expect(automatic.getByRole('status')).toContainText('Configuration saved');
    expect(await readFile(configPath, 'utf8')).toBe(saved);
    await dialog.screenshot({
      path: resolve('.local/screenshots/agents-claude-desktop-setup.png'),
    });
    await automatic.getByRole('button', { name: 'Remove from config file', exact: true }).click();
    await expect(automatic.getByRole('status')).toContainText('Congruence configuration removed');
    expect(JSON.parse(await readFile(configPath, 'utf8'))).toEqual(original);
    await writeFile(configPath, '{broken');
    await apply.click();
    await expect(automatic.getByRole('alert')).toContainText('Check the JSON file');
    expect(await readFile(configPath, 'utf8')).toBe('{broken');
    expect(await readFile(codexPath, 'utf8')).toBe('# Codex settings\nmodel = "example"\n');
    await dialog.getByRole('button', { name: 'Agent settings', exact: true }).click();
    await expect(claudeTab).toHaveAttribute('aria-selected', 'true');
    await expect(
      dialog.getByRole('tabpanel', { name: 'Claude Code Desktop', exact: true }),
    ).toContainText('Not installed · 0 connected sessions');
    await dialog.getByRole('tab', { name: 'Codex Desktop', exact: true }).click();
    await expect(dialog.getByLabel('Codex executable', { exact: true })).toBeVisible();
    await dialog.getByRole('button', { name: 'MCP setup', exact: true }).click();
    await expect(dialog.getByRole('tab', { name: 'Manual setup', exact: true })).toBeVisible();
    await claudeTab.click();
    await expect(automatic).toContainText(configPath);
    await expect(dialog.getByRole('tab', { name: 'Manual setup', exact: true })).toHaveCount(0);
    await page.setViewportSize({ width: 320, height: 640 });
    expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
      true,
    );
    await dialog.screenshot({
      path: resolve('.local/screenshots/agents-claude-desktop-mobile.png'),
    });
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
