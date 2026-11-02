import { expect, test as base, type Page } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { buildApp } from '../../apps/server/src/app.js';
import { FakeCodex } from '../helpers/fake-codex.js';
import type {
  DashboardPreview,
  DashboardPreviewInput,
  DashboardRun,
  DashboardSummary,
  Workspace,
} from '../../packages/contracts/src/index.js';

const test = base.extend({
  baseURL: async ({}, use) => {
    const dataDir = await mkdtemp(join(tmpdir(), 'congruence-dashboard-ui-'));
    const app = await buildApp({
      dataDir,
      mcp: false,
      codexAdapter: new FakeCodex(),
      desktopAdapter: false,
      claudeSettingsPath: join(dataDir, 'claude-settings.json'),
    });
    try {
      await use(await app.listen({ host: '127.0.0.1', port: 0 }));
    } finally {
      await app.close();
      if (!resolve(dataDir).startsWith(`${resolve(tmpdir())}${sep}congruence-dashboard-ui-`))
        throw new Error('Unexpected test data path.');
      await rm(dataDir, { recursive: true, force: true });
    }
  },
});

const previewId = 'f75e2bda-e9f8-4f6f-a0a1-468310958f35';
const commands = [
  { id: 'report', label: 'Prepare report', type: 'agent' as const },
  { id: 'collect', label: 'Collect snapshot', type: 'backend' as const },
];

async function dashboardFixture(page: Page, workspace: Workspace) {
  const root = `/api/workspaces/${workspace.id}/dashboards`;
  const asset = `${root}/weather/versions/v1/assets/index.html`;
  const summary: DashboardSummary = {
    id: 'weather',
    workspaceId: workspace.id,
    name: 'Weather console',
    description: 'Local forecasts and agent reports',
    version: 'v1',
    backend: true,
    status: 'ready',
    frameUrl: asset,
    commands,
  };
  let preview: DashboardPreview | undefined;
  const runs: DashboardRun[] = [];
  const executions: unknown[] = [];
  await page.route('**/api/workspaces/*/dashboards', async (route) => {
    await route.fulfill({
      json: new URL(route.request().url()).pathname === root ? [summary] : [],
    });
  });
  await page.route(`**${asset}`, async (route) => {
    await route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><html><body>
      <h1>Forecast controls</h1>
      <button onclick="send('collect', 'reviewCommand')">Review snapshot</button>
      <button onclick="send('report', 'reviewCommand')">Prepare report</button>
      <button onclick="send('collect', 'execute')">Try direct execution</button>
      <output></output>
      <script>
        let requestId = 0;
        function send(commandId, method) {
          parent.postMessage({source:'congruence-dashboard',requestId:String(++requestId),method,version:'v1',commandId,input:{city:'Bucharest'},prompt:'Summarize the forecast.'}, '*');
        }
        addEventListener('message', e => {
          if (e.data.source === 'congruence-host') document.querySelector('output').textContent = e.data.error || e.data.result.status;
        });
      </script></body></html>`,
    });
  });
  await page.route(`**${root}/weather/previews`, async (route) => {
    const input = route.request().postDataJSON() as DashboardPreviewInput;
    const command = commands.find((item) => item.id === input.commandId)!;
    preview = {
      id: previewId,
      workspaceId: workspace.id,
      dashboardId: 'weather',
      version: 'v1',
      command,
      input: { ...input.input, fetchedTemperature: 18 },
      ...(command.type === 'agent'
        ? { prompt: `${input.prompt}\nLink the real session with request ${previewId}.` }
        : {}),
      summary: 'Use the current forecast snapshot.',
      createdAt: new Date().toISOString(),
      destination: input.destination,
    };
    await route.fulfill({ json: preview });
  });
  await page.route(`**${root}/weather/runs`, async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({ json: runs });
      return;
    }
    const input = route.request().postDataJSON();
    executions.push(input);
    const destination = preview?.destination;
    const launchUrl =
      destination?.kind === 'desktop'
        ? `${destination.provider === 'codex-desktop' ? 'codex://threads/new?' : 'claude://code/new?'}${new URLSearchParams(destination.provider === 'codex-desktop' ? { path: destination.folder, prompt: preview!.prompt! } : { folder: destination.folder, q: preview!.prompt! })}`
        : undefined;
    const run: DashboardRun = {
      id: previewId,
      workspaceId: workspace.id,
      dashboardId: 'weather',
      version: 'v1',
      command: preview!.command,
      input: preview!.input,
      prompt: preview!.prompt,
      status: destination?.kind === 'desktop' ? 'prepared' : 'running',
      detail:
        destination?.kind === 'desktop'
          ? 'Prompt prepared. Send it from Desktop when ready.'
          : 'Collecting the reviewed snapshot.',
      destination,
      launchUrl,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    runs.push(run);
    await route.fulfill({ json: run });
  });
  await page.goto('/');
  await page.getByLabel('Current workspace').selectOption(workspace.id);
  await page.getByLabel('Dashboard', { exact: true }).selectOption('weather');
  await expect(
    page.frameLocator('iframe').getByRole('heading', { name: 'Forecast controls' }),
  ).toBeVisible();
  return { executions, runs };
}

test('custom dashboard commands require host review and retain the exact resolved snapshot', async ({
  page,
  request,
}) => {
  const workspace = (await (
    await request.post('/api/workspaces', {
      data: { name: 'Dashboard command test', description: '', repositories: [] },
    })
  ).json()) as Workspace;
  const fixture = await dashboardFixture(page, workspace);
  const frame = page.frameLocator('iframe');
  await expect(page.locator('iframe')).toHaveAttribute('sandbox', 'allow-scripts');
  await frame.getByRole('button', { name: 'Try direct execution' }).click();
  await expect(frame.locator('output')).toHaveText('This dashboard operation is not supported.');
  expect(fixture.executions).toHaveLength(0);
  await frame.getByRole('button', { name: 'Review snapshot' }).click();
  const dialog = page.getByRole('dialog', { name: 'Review command' });
  await expect(dialog.getByRole('heading', { name: 'Resolved inputs' })).toBeVisible();
  await expect(dialog).toContainText('"fetchedTemperature": 18');
  expect(fixture.executions).toHaveLength(0);
  await dialog.getByRole('button', { name: 'Run command', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('Collecting the reviewed snapshot.');
  expect(fixture.executions).toEqual([{ previewId }]);
  await expect(frame.locator('output')).toHaveText('running');
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await page.getByText('Command history', { exact: false }).click();
  await expect(page.locator('.dashboard-run')).toContainText('Collect snapshot');
  await page.getByLabel('Dashboard', { exact: true }).selectOption('activity');
  await expect(page.locator('iframe')).toHaveCount(0);
});

test('new Desktop commands show the full final prompt and only prepare a composer link', async ({
  page,
  request,
}) => {
  const workspace = (await (
    await request.post('/api/workspaces', {
      data: {
        name: 'Desktop preparation test',
        description: '',
        repositories: ['D:\\projects\\forecast'],
      },
    })
  ).json()) as Workspace;
  const fixture = await dashboardFixture(page, workspace);
  await page.frameLocator('iframe').getByRole('button', { name: 'Prepare report' }).click();
  const dialog = page.getByRole('dialog', { name: 'Review command' });
  await dialog.getByLabel('Desktop app').selectOption('claude-desktop');
  await dialog.getByLabel('New activity title').fill('Forecast analysis');
  await dialog.getByRole('button', { name: 'Review command', exact: true }).click();
  await expect(dialog.getByRole('heading', { name: 'Assembled prompt' })).toBeVisible();
  await expect(dialog).toContainText(`Link the real session with request ${previewId}.`);
  await expect(dialog).toContainText('Forecast analysis');
  expect(fixture.executions).toHaveLength(0);
  await dialog.getByRole('button', { name: 'Prepare session' }).click();
  const result = page.getByRole('dialog', { name: 'Open your prepared session' });
  const link = result.getByRole('link', { name: 'Open in Claude' });
  await expect(link).toBeVisible();
  const url = new URL((await link.getAttribute('href'))!);
  expect(url.protocol).toBe('claude:');
  expect(url.searchParams.get('folder')).toBe('D:\\projects\\forecast');
  expect(url.searchParams.get('q')).toBe(fixture.runs[0]?.prompt);
  expect(await (await request.get(`/api/workspaces/${workspace.id}/activity`)).json()).toEqual([]);
  await expect(result).toContainText('then press Send there');
  expect(fixture.executions).toHaveLength(1);
  fixture.runs[0]!.status = 'linked';
  fixture.runs[0]!.detail = 'The real Desktop session is linked.';
  await expect(page.getByRole('dialog')).toContainText('The real Desktop session is linked.');
  await expect(page.getByRole('dialog').getByRole('link', { name: 'Open in Claude' })).toHaveCount(
    0,
  );
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await page.getByText('Command history', { exact: false }).click();
  const history = page.locator('.dashboard-run');
  await history.locator('summary').first().click();
  await expect(history).toContainText('Session linked');
  await expect(history.getByRole('link', { name: 'Open in Claude' })).toHaveCount(0);
});

test('dashboard choice persists separately for each workspace and Activity stays first', async ({
  page,
  request,
}) => {
  const first = (await (
    await request.post('/api/workspaces', {
      data: { name: 'Dashboard selection A', description: '', repositories: [] },
    })
  ).json()) as Workspace;
  const second = (await (
    await request.post('/api/workspaces', {
      data: { name: 'Dashboard selection B', description: '', repositories: [] },
    })
  ).json()) as Workspace;
  await dashboardFixture(page, first);
  await expect(page.getByLabel('Dashboard', { exact: true }).locator('option').first()).toHaveText(
    'Activity',
  );
  await page.reload();
  await expect(page.getByLabel('Dashboard', { exact: true })).toHaveValue('weather');
  await page.getByLabel('Current workspace').selectOption(second.id);
  await expect(page.getByLabel('Dashboard', { exact: true })).toHaveValue('activity');
  await expect(page.getByLabel('Dashboard', { exact: true }).locator('option')).toHaveCount(1);
  await page.getByLabel('Current workspace').selectOption(first.id);
  await expect(page.getByLabel('Dashboard', { exact: true })).toHaveValue('weather');
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
