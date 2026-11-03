import { expect, test } from '@playwright/test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildApp } from '../../apps/server/src/app.js';
import type { DashboardLocation, DashboardSummary } from '../../packages/contracts/src/index.js';

test('published React dashboards read backend data, review frozen commands, survive navigation, and refresh to new builds', async ({
  page,
}) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'congruence-dashboard-browser-'));
  const app = await buildApp({ dataDir, mcp: false, desktopAdapter: false });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    const url = await app.listen({ host: '127.0.0.1', port: 0 });
    const workspace = await app.store.createWorkspace({
      name: 'Field operations',
      description: 'Live readings and reviewed actions',
      repositories: [],
    });
    const base = `/api/workspaces/${workspace.id}/dashboards`;
    const location = (
      await app.inject({
        method: 'POST',
        url: base,
        payload: { name: 'Station overview', description: 'Readings from the workspace backend' },
      })
    ).json<DashboardLocation>();
    const route = `${base}/${location.dashboard.id}`;
    await writeFile(
      join(location.directory, 'manifest.json'),
      JSON.stringify({
        schemaVersion: 1,
        name: 'Station overview',
        description: 'Readings from the workspace backend',
        commands: [
          { id: 'record', label: 'Record observation', type: 'backend' },
          { id: 'analyse', label: 'Analyse readings', type: 'agent' },
        ],
      }),
    );
    const external = join(dataDir, 'external.json');
    await writeFile(external, JSON.stringify({ temperature: 18, station: 'North station' }));
    await writeFile(
      join(location.directory, 'src', 'backend.ts'),
      `
      import { readFile, writeFile } from 'node:fs/promises';
      import { join } from 'node:path';
      let ticks = 0;
      export function start(context) { const timer = setInterval(() => { ticks++; }, 20); return () => clearInterval(timer); }
      export async function read() { return { ...JSON.parse(await readFile(${JSON.stringify(external)}, 'utf8')), ticks }; }
      export async function prepare(id, input) { return { input: { ...input, reading: await read() }, summary: 'Record this station reading', ...(id === 'analyse' ? { prompt: 'Analyse the station reading.' } : {}) }; }
      export async function execute(id, input, context) { await new Promise(resolve => setTimeout(resolve, 200)); await writeFile(join(context.dataDir, 'observation.json'), JSON.stringify(input)); return input; }
    `,
    );
    const frontend = (heading: string) => `
      import { useEffect, useState } from 'react';
      export default function Dashboard({api}) {
        const [reading, setReading] = useState(null);
        const [note, setNote] = useState('Morning check');
        useEffect(() => { api.read('station').then(setReading); }, []);
        return <main style={{padding:32,maxWidth:720}}><p style={{color:'#9daac0'}}>STATION DATA</p><h1>${heading}</h1>
          <p>{reading ? reading.station + ' · ' + reading.temperature + ' °C' : 'Loading reading…'}</p>
          <label>Observation note <input value={note} onChange={e=>setNote(e.target.value)} /></label>
          <p><button onClick={()=>api.reviewCommand('record',{input:{note}})}>Record observation</button>{' '}
          <button onClick={()=>api.reviewCommand('analyse',{input:{note}})}>Analyse readings</button></p>
        </main>;
      }
    `;
    await writeFile(join(location.directory, 'src', 'frontend.tsx'), frontend('Station readings'));
    const published = await app.inject({ method: 'POST', url: `${route}/publish` });
    expect(published.statusCode, published.body).toBe(200);
    const first = published.json<DashboardSummary>();
    await page.goto(url);
    const switcher = page.getByRole('button', { name: /^Switch workspace and view/ });
    await switcher.click();
    await page.getByLabel('View', { exact: true }).selectOption(location.dashboard.id);
    const frame = page.frameLocator('iframe');
    await expect(frame.getByRole('heading', { name: 'Station readings' })).toBeVisible();
    await expect(frame.getByText('North station · 18 °C')).toBeVisible();
    expect(
      await page
        .locator('iframe')
        .evaluate((element: HTMLIFrameElement) => element.contentDocument === null),
    ).toBe(true);
    await frame.getByLabel('Observation note').fill('Reviewed at 08:00');
    await frame.getByRole('button', { name: 'Record observation', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Review command' });
    await expect(dialog).toContainText('"temperature": 18');
    await expect(dialog).toContainText('Reviewed at 08:00');
    await mkdir(resolve('.local/screenshots'), { recursive: true });
    await page.screenshot({
      path: resolve('.local/screenshots/dashboard-command-review.png'),
      fullPage: true,
    });
    await writeFile(external, JSON.stringify({ temperature: 99, station: 'Changed after review' }));
    await dialog.getByRole('button', { name: 'Run command', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Command submitted' })).toBeVisible();
    await page.goto('about:blank');
    await expect
      .poll(async () => (await app.inject(`${route}/runs`)).json()[0]?.status)
      .toBe('succeeded');
    const run = (await app.inject(`${route}/runs`)).json()[0];
    expect(run.result.reading.temperature).toBe(18);
    const saved = JSON.parse(
      await readFile(join(location.directory, '..', 'data', 'observation.json'), 'utf8'),
    );
    expect(saved).toEqual(run.input);
    await page.goto(url);
    await expect(switcher).toContainText('Station overview');
    await expect(frame.getByText('Changed after review · 99 °C')).toBeVisible();
    await frame.getByRole('button', { name: 'Analyse readings' }).click();
    await dialog.getByRole('button', { name: 'Review command', exact: true }).click();
    await expect(dialog).toContainText('link_dashboard_session');
    await dialog.getByRole('button', { name: 'Prepare session' }).click();
    const preparedDialog = page.getByRole('dialog', { name: 'Open your prepared session' });
    const link = await preparedDialog
      .getByRole('link', { name: 'Open in Codex' })
      .getAttribute('href');
    expect(link).toMatch(/^codex:\/\/threads\/new\?/);
    expect(await app.store.listActivity(workspace.id)).toEqual([]);
    await preparedDialog.getByRole('button', { name: 'Done', exact: true }).click();
    await writeFile(
      join(location.directory, 'src', 'frontend.tsx'),
      frontend('Updated station readings'),
    );
    const second = (
      await app.inject({ method: 'POST', url: `${route}/publish` })
    ).json<DashboardSummary>();
    expect(second.version).not.toBe(first.version);
    await expect(
      frame.getByRole('heading', { name: 'Station readings', exact: true }),
    ).toBeVisible();
    await switcher.click();
    await page.getByRole('button', { name: 'Refresh dashboards' }).click();
    const updatedHeading = frame.getByRole('heading', {
      name: 'Updated station readings',
      exact: true,
    });
    await expect(updatedHeading).toBeVisible();
    await updatedHeading.click({ position: { x: 4, y: 4 } });
    await expect(page.getByRole('dialog', { name: 'Workspace and view' })).toBeHidden();
    await page.reload();
    await expect(updatedHeading).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    expect(errors).toEqual([]);
  } finally {
    await page.goto('about:blank');
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
