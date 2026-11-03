import { expect, test } from '@playwright/test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildApp } from '../../apps/server/src/app.js';

test.use({ deviceScaleFactor: 2 });

test('workspaces receive real MCP updates, preserve isolation, and work on mobile', async ({
  page,
  request,
}) => {
  const browserErrors: string[] = [];
  const switcher = page.getByRole('button', { name: /^Switch workspace and view/ });
  const popup = page.getByRole('dialog', { name: 'Workspace and view' });
  // Fictional projects and work reports used only for UI testing and screenshots.
  page.on('pageerror', (error) => browserErrors.push(error.message));
  await page.goto('/');
  await page.getByRole('button', { name: 'Create your first workspace' }).click();
  await page.getByLabel('Workspace name').fill('Veyra');
  await page.getByLabel(/^Description/).fill('A stargazing planner for weekend trips.');
  await page.getByRole('button', { name: 'Create workspace', exact: true }).click();
  await expect(switcher).toHaveAccessibleName('Switch workspace and view, Veyra, Activity');
  await expect(page.getByText('No activity yet')).toBeVisible();
  await switcher.click();
  await popup.getByRole('button', { name: 'Edit workspace' }).click();
  await page
    .getByRole('textbox', { name: /^Repositories/ })
    .fill('D:\\projects\\veyra-web\nhttps://example.com/veyra/star-catalog');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);

  await switcher.click();
  await popup.getByRole('button', { name: 'New workspace', exact: true }).click();
  await page.getByLabel('Workspace name').fill('Mosslight');
  await page.getByLabel(/^Description/).fill('A field journal for urban wildlife.');
  await page.getByRole('button', { name: 'Create workspace', exact: true }).click();
  await expect(switcher).toContainText('Mosslight');
  const workspaces = await (await request.get('/api/workspaces')).json();
  const veyra = workspaces.find((workspace: { name: string }) => workspace.name === 'Veyra');
  const mosslight = workspaces.find(
    (workspace: { name: string }) => workspace.name === 'Mosslight',
  );
  expect(mosslight.repositories).toEqual([]);
  expect(veyra.repositories).toHaveLength(2);

  const client = new Client({ name: 'congruence-browser-test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:4321/mcp')));
  try {
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toContain('publish_activity');
    const report = {
      workspaceId: veyra.id,
      title: 'Add offline star charts',
      subtitle: 'Preparing maps for the next trip',
      summary: 'Preparing sky maps for trips without mobile coverage.',
      source: 'Codex',
      status: 'in_progress',
    };
    const result = await client.callTool({ name: 'publish_activity', arguments: report });
    expect(result.isError).not.toBe(true);
    const { activity: item } = result.structuredContent as { activity: { workKey: string } };
    await expect(page.getByText(report.title)).toHaveCount(0);
    await switcher.click();
    await popup.getByLabel('Current workspace').selectOption(veyra.id);
    await page.keyboard.press('Escape');
    const list = page.locator('.activity-list');
    const row = list.getByRole('button', { name: report.title, exact: true });
    const reader = page.locator('article.activity-reader');
    await expect(row).toHaveAttribute('aria-pressed', 'true');
    await expect(row).toHaveAccessibleDescription('In progress Preparing maps for the next trip');
    await expect(row).toContainText(report.subtitle);
    await expect(list).not.toContainText(report.summary);
    await expect(reader.getByRole('heading', { name: report.title, exact: true })).toBeVisible();
    await expect(reader).toContainText(report.summary);
    await expect(reader.getByText('In progress', { exact: true })).toBeVisible();

    await client.callTool({
      name: 'publish_activity',
      arguments: {
        ...report,
        workKey: item.workKey,
        status: 'done',
        summary: 'Saved sky maps are now available without a connection.',
        sourceUrl: 'https://example.com/veyra/reviews/12',
      },
    });
    await expect(reader.getByText('Done', { exact: true })).toBeVisible();
    await expect(page.locator('article.activity-item')).toHaveCount(1);
    // Selecting the current activity keeps its detail open.
    await row.click();
    await expect(row).toHaveAttribute('aria-pressed', 'true');
    await expect(reader.getByRole('link', { name: 'Open source' })).toHaveAttribute(
      'href',
      'https://example.com/veyra/reviews/12',
    );
    const weatherResult = await client.callTool({
      name: 'publish_activity',
      arguments: {
        ...report,
        title: 'Choose a weather provider',
        subtitle: 'Comparing forecast coverage',
        summary: 'Waiting for a decision on cloud-cover forecast coverage.',
        status: 'blocked',
      },
    });
    const { activity: weather } = weatherResult.structuredContent as {
      activity: { workKey: string };
    };
    await client.callTool({
      name: 'publish_activity',
      arguments: {
        ...report,
        title: 'Build shared trip itineraries',
        subtitle: 'Planning together',
        summary: 'Adding saved locations and observing plans for small groups.',
        source: 'Claude',
        status: 'in_progress',
      },
    });
    await expect(page.locator('article.activity-item')).toHaveCount(3);
    // Newly reported activities do not replace the activity being read.
    await expect(row).toHaveAttribute('aria-pressed', 'true');
    await expect(reader.getByRole('heading', { name: report.title, exact: true })).toBeVisible();
    const weatherRow = list.getByRole('button', {
      name: 'Choose a weather provider',
      exact: true,
    });
    await weatherRow.click();
    await expect(weatherRow).toHaveAttribute('aria-pressed', 'true');
    await expect(row).toHaveAttribute('aria-pressed', 'false');
    await expect(reader).toContainText('Waiting for a decision on cloud-cover forecast coverage.');
    await expect(reader.getByRole('link', { name: 'Open source' })).toHaveCount(0);
    await expect(reader).not.toContainText(
      'Saved sky maps are now available without a connection.',
    );
    await client.callTool({
      name: 'publish_activity',
      arguments: {
        ...report,
        workKey: item.workKey,
        status: 'done',
        summary: 'The offline maps include the latest star catalog.',
      },
    });
    await expect(list.locator('.activity-main').first()).toHaveAccessibleName(report.title);
    await expect(weatherRow).toHaveAttribute('aria-pressed', 'true');
    await expect(reader.getByRole('heading', { name: 'Choose a weather provider' })).toBeVisible();
    await client.callTool({
      name: 'publish_activity',
      arguments: {
        workspaceId: veyra.id,
        workKey: weather.workKey,
        subtitle: 'Waiting for the coverage decision',
        summary: 'Two forecast providers cover the planned observing sites.',
        source: 'Codex',
        status: 'blocked',
      },
    });
    await expect(reader).toContainText('Two forecast providers cover the planned observing sites.');
    await expect(weatherRow).toHaveAttribute('aria-pressed', 'true');
    await page
      .getByRole('group', { name: 'Filter activity' })
      .getByRole('button', { name: /^Done\s/ })
      .click();
    await expect(page.locator('article.activity-item')).toHaveCount(1);
    await expect(row).toHaveAttribute('aria-pressed', 'true');
    await expect(reader).toContainText('The offline maps include the latest star catalog.');
    await expect(reader).not.toContainText(
      'Two forecast providers cover the planned observing sites.',
    );
    await page.getByRole('button', { name: /^All activity\s/ }).click();
    await page.getByLabel('Search activity').fill('weather');
    await expect(page.locator('article.activity-item')).toHaveCount(1);
    await expect(weatherRow).toHaveAttribute('aria-pressed', 'true');
    await expect(reader.getByRole('heading', { name: 'Choose a weather provider' })).toBeVisible();
    await page.getByLabel('Search activity').fill('No matching activity');
    await expect(page.locator('article.activity-item')).toHaveCount(0);
    await expect(reader).toHaveCount(0);
    await expect(
      page.getByText('Two forecast providers cover the planned observing sites.'),
    ).toHaveCount(0);
    await page.getByLabel('Search activity').fill('');
    await page.reload();
    await expect(switcher).toContainText('Veyra');
    await expect(page.locator('article.activity-item')).toHaveCount(3);
    const [sidebarBounds, readerBounds, repositoryBounds] = await Promise.all([
      page.locator('.activity-sidebar').boundingBox(),
      reader.boundingBox(),
      page.locator('.workspace-panels').boundingBox(),
    ]);
    if (!sidebarBounds || !readerBounds || !repositoryBounds)
      throw new Error('The activity list, selected activity, and repositories must be visible.');
    expect(sidebarBounds.x + sidebarBounds.width).toBeLessThan(readerBounds.x);
    expect(readerBounds.x + readerBounds.width).toBeLessThan(repositoryBounds.x);
    expect(readerBounds.width).toBeGreaterThan(sidebarBounds.width);

    await mkdir(resolve('.local/screenshots'), { recursive: true });
    await page.screenshot({
      path: resolve('.local/screenshots/dashboard-desktop.png'),
      fullPage: true,
      scale: 'css',
      animations: 'disabled',
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(switcher).toContainText('Veyra');
    await row.click();
    await expect(row).toHaveAttribute('aria-pressed', 'true');
    await expect(reader.getByRole('heading', { name: report.title, exact: true })).toBeVisible();
    await expect(reader).toContainText('The offline maps include the latest star catalog.');
    const [mobileSidebar, mobileReader] = await Promise.all([
      page.locator('.activity-sidebar').boundingBox(),
      reader.boundingBox(),
    ]);
    if (!mobileSidebar || !mobileReader) throw new Error('Mobile activity panels must be visible.');
    expect(mobileSidebar.y + mobileSidebar.height).toBeLessThan(mobileReader.y);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({
      path: resolve('.local/screenshots/dashboard-mobile.png'),
      animations: 'disabled',
    });
    const status = page.getByRole('banner').getByRole('status');
    const agents = page.getByRole('banner').getByRole('button', { name: 'Agents', exact: true });
    const statusBounds = (await status.boundingBox())!;
    expect(statusBounds.x + statusBounds.width).toBeLessThan((await agents.boundingBox())!.x);
    await switcher.click();
    await expect(popup).toBeVisible();
    const triggerBounds = (await switcher.boundingBox())!;
    const popupBounds = (await popup.boundingBox())!;
    const gap = popupBounds.y - (triggerBounds.y + triggerBounds.height);
    expect(gap).toBeGreaterThanOrEqual(0);
    expect(gap).toBeLessThan(16);
    expect(popupBounds.x).toBeGreaterThanOrEqual(0);
    expect(popupBounds.x + popupBounds.width).toBeLessThanOrEqual(390);
    expect((await page.locator('.activity-sidebar').boundingBox())!.y).toBe(mobileSidebar.y);
    await page.screenshot({
      path: resolve('.local/screenshots/dashboard-mobile-switcher.png'),
      animations: 'disabled',
    });
    await popup.getByRole('button', { name: 'Edit workspace' }).click();
    await expect(page.getByRole('dialog', { name: 'Edit workspace' })).toBeVisible();
    await expect(page.getByLabel('Workspace name')).toHaveValue('Veyra');
    await page.screenshot({
      path: resolve('.local/screenshots/dashboard-mobile-workspace-editor.png'),
      animations: 'disabled',
    });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await switcher.click();
    await popup.getByLabel('Current workspace').selectOption(mosslight.id);
    await expect(switcher).toContainText('Mosslight');
    await expect(page.getByText('No activity yet')).toBeVisible();
    await expect(reader).toHaveCount(0);
    await expect(page.getByText(report.title)).toHaveCount(0);
    await page.getByRole('button', { name: 'Agents' }).click();
    await expect(page.getByRole('dialog')).toContainText('http://127.0.0.1:4321/mcp');
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page
      .getByRole('dialog')
      .getByRole('button', { name: 'Close dialog', exact: true })
      .click();
    await switcher.click();
    await popup.getByLabel('Current workspace').selectOption(veyra.id);
    await page.keyboard.press('Escape');
    await expect(switcher).toBeFocused();
    await expect(page.locator('article.activity-item')).toHaveCount(3);
    await expect(reader.getByRole('heading', { name: 'Choose a weather provider' })).toBeVisible();
    await page.route('**/api/workspaces', (route) => route.abort());
    // Without polling, a saved change is what triggers a new snapshot request.
    await request.put(`/api/workspaces/${veyra.id}`, {
      data: { name: veyra.name, description: veyra.description, repositories: veyra.repositories },
    });
    await expect(page.getByRole('alert')).toContainText('We can’t reach the local server.');
    await expect(page.locator('article.activity-item')).toHaveCount(3);
    await page.unroute('**/api/workspaces');
    await page.getByRole('button', { name: 'Retry', exact: true }).click();
    await expect(page.getByRole('alert')).toHaveCount(0);
    expect(browserErrors).toEqual([]);
  } finally {
    await client.close();
  }
});

test('SSE keeps idle dashboards quiet and resynchronizes after a server restart', async ({
  page,
  context,
}) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'congruence-reconnect-'));
  let app = await buildApp({ dataDir, mcp: false });
  try {
    const baseUrl = await app.listen({ host: '127.0.0.1', port: 0 });
    const port = Number(new URL(baseUrl).port);
    const workspace = await app.store.createWorkspace({
      name: 'Live connection',
      description: '',
      repositories: [],
    });
    await page.goto(baseUrl);
    await expect(page.getByRole('heading', { name: workspace.name, exact: true })).toBeVisible();
    await expect(page.getByText('No activity yet')).toBeVisible();

    const reads: string[] = [];
    page.on('request', (request) => {
      if (request.method() === 'GET' && request.url().includes('/api/workspaces'))
        reads.push(request.url());
    });
    // A negative assertion over longer than the old polling interval detects recurring reads.
    await page.waitForTimeout(3500);
    expect(reads).toEqual([]);

    const report = {
      workspaceId: workspace.id,
      title: 'Arrived while disconnected',
      summary: 'The reconnect snapshot includes this update.',
      status: 'done' as const,
      source: 'Codex',
    };
    await app.close();
    await expect(page.getByRole('alert')).toBeVisible();
    await expect(page.getByRole('heading', { name: workspace.name, exact: true })).toBeVisible();
    app = await buildApp({ dataDir, mcp: false });
    // Persist a change before reopening the listener: the browser cannot receive this event.
    const item = await app.store.publishActivity(report);
    await app.listen({ host: '127.0.0.1', port });
    await expect(page.getByRole('button', { name: report.title, exact: true })).toBeVisible();
    await expect(page.getByRole('alert')).toHaveCount(0);

    const second = await context.newPage();
    await second.goto(baseUrl);
    await expect(second.getByRole('button', { name: report.title, exact: true })).toBeVisible();
    await app.store.publishActivity({
      ...report,
      workKey: item.workKey,
      subtitle: 'Delivered to both tabs',
      status: 'in_progress',
    });
    await expect(
      page.locator('.activity-reader').getByText('Delivered to both tabs', { exact: true }),
    ).toBeVisible();
    await expect(
      second.locator('.activity-reader').getByText('Delivered to both tabs', { exact: true }),
    ).toBeVisible();
    await second.close();
  } finally {
    await page.close();
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
