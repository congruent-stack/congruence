import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createStore } from '../../storage/store.js';
import { createDashboardRuntime, type DashboardRuntime } from './runtime.js';

const directories: string[] = [];
const runtimes: DashboardRuntime[] = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'congruence-dashboards-'));
  directories.push(directory);
  const store = await createStore(directory);
  const workspace = await store.createWorkspace({
    name: 'Maps',
    description: '',
    repositories: [],
  });
  const other = await store.createWorkspace({ name: 'Other', description: '', repositories: [] });
  const runtime = await createDashboardRuntime(directory, store);
  runtimes.push(runtime);
  const location = await runtime.create(workspace.shortId, {
    name: 'Map dashboard',
    description: 'Live map data',
  });
  return { directory, store, workspace, other, runtime, location, id: location.dashboard.id };
}

async function backend(directory: string, source: string) {
  await writeFile(join(directory, 'src', 'backend.ts'), source);
  await writeFile(
    join(directory, 'manifest.json'),
    JSON.stringify({
      schemaVersion: 1,
      name: 'Map dashboard',
      description: 'Live map data',
      commands: [
        { id: 'run', label: 'Run a job', type: 'backend' },
        { id: 'ask-agent', label: 'Ask an agent', type: 'agent' },
      ],
    }),
  );
}

describe('workspace dashboard runtime', () => {
  it('scaffolds in internal directories, publishes React/CSS and isolates workspace assets and APIs', async () => {
    const { directory, workspace, other, runtime, location, id } = await setup();
    expect(location.directory.startsWith(directory)).toBe(true);
    expect(location.dashboard).toMatchObject({
      workspaceId: workspace.id,
      status: 'draft',
      commands: [],
    });
    expect(await readFile(location.instructionsPath, 'utf8')).toContain('immutable releases');
    await writeFile(join(location.directory, 'src', 'style.css'), 'h1 { color: red }');
    await writeFile(
      join(location.directory, 'src', 'frontend.tsx'),
      `import './style.css'; export default function Dashboard() { return <h1>Published content</h1>; }`,
    );
    const published = await runtime.publish(workspace.shortId, id);
    expect(published).toMatchObject({ status: 'ready', backend: false, workspaceId: workspace.id });
    expect(published.frameUrl).toBe(
      `/api/workspaces/${workspace.id}/dashboards/${id}/versions/${published.version}/assets/index.html`,
    );
    const html = await runtime.asset(workspace.id, id, published.version!, 'index.html');
    expect(html.contentType).toContain('text/html');
    expect(html.body.toString()).toContain('./dashboard.css');
    expect(html.body.toString()).not.toContain('type="module"');
    const js = await runtime.asset(workspace.id, id, published.version!, 'dashboard.js');
    expect(js.body.toString()).toContain('Published content');
    expect(js.body.toString()).toContain('congruence-dashboard');
    expect(await runtime.list(other.id)).toEqual([]);
    expect(await runtime.list(workspace.shortId)).toEqual([published]);
    await expect(runtime.get(other.id, id)).rejects.toMatchObject({ statusCode: 404 });
    await expect(runtime.location(other.id, id)).rejects.toMatchObject({ statusCode: 404 });
    await expect(runtime.publish(other.id, id)).rejects.toMatchObject({ statusCode: 404 });
    await expect(
      runtime.asset(other.id, id, published.version!, 'dashboard.js'),
    ).rejects.toMatchObject({ statusCode: 404 });
    await expect(
      runtime.asset(workspace.id, id, published.version!, '../backend.cjs'),
    ).rejects.toMatchObject({ statusCode: 404 });
    await expect(
      runtime.asset(workspace.id, id, published.version!, '..\\backend.cjs'),
    ).rejects.toMatchObject({ statusCode: 404 });
    await expect(runtime.asset(workspace.id, id, 'unknown', 'index.html')).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it('keeps the published version on compile, manifest, or backend startup failure', async () => {
    const { workspace, runtime, location, id } = await setup();
    await backend(location.directory, `export function read() { return { healthy: true }; }`);
    const published = await runtime.publish(workspace.id, id);
    const frontend = await readFile(join(location.directory, 'src', 'frontend.tsx'), 'utf8');
    await writeFile(
      join(location.directory, 'src', 'frontend.tsx'),
      'export default function broken(',
    );
    await expect(runtime.publish(workspace.id, id)).rejects.toThrow('publication failed');
    expect((await runtime.get(workspace.id, id)).version).toBe(published.version);
    expect(await runtime.read(workspace.id, id, published.version!, 'health', {})).toEqual({
      healthy: true,
    });
    await writeFile(join(location.directory, 'src', 'frontend.tsx'), frontend);
    await backend(
      location.directory,
      `export function start() { throw new Error('Database unavailable'); }`,
    );
    await expect(runtime.publish(workspace.id, id)).rejects.toThrow('Database unavailable');
    expect(await runtime.get(workspace.id, id)).toMatchObject({
      version: published.version,
      status: 'error',
      error: expect.stringContaining('Database unavailable'),
    });
    expect(await runtime.read(workspace.id, id, published.version!, 'health', {})).toEqual({
      healthy: true,
    });
    await writeFile(
      join(location.directory, 'manifest.json'),
      JSON.stringify({
        schemaVersion: 1,
        name: 'Bad',
        commands: [
          { id: 'a', label: 'A', type: 'agent' },
          { id: 'a', label: 'A', type: 'agent' },
        ],
      }),
    );
    await expect(runtime.publish(workspace.id, id)).rejects.toThrow('duplicate command');
    expect((await runtime.get(workspace.id, id)).version).toBe(published.version);
  });

  it('resolves dynamic inputs for review, freezes execution input and rejects stale or foreign calls', async () => {
    const { workspace, other, runtime, location, id } = await setup();
    await backend(
      location.directory,
      `
      export function read(query, input, context) { return { query, input, workspaceId: context.workspaceId }; }
      export function prepare(commandId, input) { return { input: { ...input, amount: 7 }, prompt: 'Run with amount 7', summary: 'Seven items' }; }
      export function execute(commandId, input) { return { commandId, input, frozen: Object.isFrozen(input) && Object.isFrozen(input.nested) }; }
    `,
    );
    const first = await runtime.publish(workspace.id, id);
    const input = { nested: { selected: 'A' } };
    const prepared = await runtime.prepare(
      workspace.shortId,
      id,
      first.version!,
      'run',
      input,
      'Original',
    );
    expect(prepared).toEqual({
      input: { nested: { selected: 'A' }, amount: 7 },
      prompt: 'Run with amount 7',
      summary: 'Seven items',
    });
    input.nested.selected = 'B';
    expect(await runtime.execute(workspace.id, id, first.version!, 'run', prepared.input)).toEqual({
      commandId: 'run',
      input: { nested: { selected: 'A' }, amount: 7 },
      frozen: true,
    });
    await expect(runtime.prepare(other.id, id, first.version!, 'run', {})).rejects.toMatchObject({
      statusCode: 404,
    });
    await expect(runtime.read(other.id, id, first.version!, 'q', {})).rejects.toMatchObject({
      statusCode: 404,
    });
    await expect(runtime.execute(other.id, id, first.version!, 'run', {})).rejects.toMatchObject({
      statusCode: 404,
    });
    await expect(
      runtime.execute(workspace.id, id, first.version!, 'ask-agent', {}),
    ).rejects.toMatchObject({ statusCode: 400 });
    const second = await runtime.publish(workspace.id, id);
    expect(second.version).not.toBe(first.version);
    await expect(runtime.read(workspace.id, id, first.version!, 'q', {})).rejects.toMatchObject({
      statusCode: 409,
    });
    await expect(
      runtime.prepare(workspace.id, id, first.version!, 'run', {}),
    ).rejects.toMatchObject({ statusCode: 409 });
    await expect(
      runtime.execute(workspace.id, id, first.version!, 'run', {}),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(
      (await runtime.asset(workspace.id, id, first.version!, 'index.html')).body.length,
    ).toBeGreaterThan(0);
  });

  it('runs background work without a browser, restores releases on restart and keeps persistent data', async () => {
    const { directory, store, workspace, runtime, location, id } = await setup();
    await backend(
      location.directory,
      `
      import { existsSync, readFileSync, writeFileSync } from 'node:fs';
      import { join } from 'node:path';
      let ticks = 0;
      export function start(context) {
        const file = join(context.dataDir, 'starts.txt');
        writeFileSync(file, String((existsSync(file) ? Number(readFileSync(file, 'utf8')) : 0) + 1));
        const timer = setInterval(() => { ticks++; writeFileSync(join(context.dataDir, 'ticks.txt'), String(ticks)); }, 15);
        return () => { clearInterval(timer); writeFileSync(join(context.dataDir, 'cleaned.txt'), 'yes'); };
      }
      export function read(query, input, context) { return { ticks, starts: Number(readFileSync(join(context.dataDir, 'starts.txt'), 'utf8')) }; }
    `,
    );
    const published = await runtime.publish(workspace.id, id);
    const data = join(location.directory, '..', 'data');
    // No browser, read request or command is needed to keep the worker alive.
    await expect
      .poll(async () => Number(await readFile(join(data, 'ticks.txt'), 'utf8').catch(() => '0')))
      .toBeGreaterThan(1);
    await runtime.close();
    expect(await readFile(join(data, 'cleaned.txt'), 'utf8')).toBe('yes');
    const restarted = await createDashboardRuntime(directory, store);
    runtimes.push(restarted);
    expect(await restarted.get(workspace.shortId, id)).toEqual(published);
    expect(await restarted.read(workspace.id, id, published.version!, 'state', {})).toMatchObject({
      starts: 2,
    });
  });

  it('stops old polling but keeps resources open until approved executions drain', async () => {
    const { workspace, runtime, location, id } = await setup();
    await backend(
      location.directory,
      `
      import { existsSync, writeFileSync } from 'node:fs';
      import { join } from 'node:path';
      let resourceClosed = false;
      export function start(context) {
        const timer = setInterval(() => {}, 100);
        context.signal.addEventListener('abort', () => {
          clearInterval(timer);
          writeFileSync(join(context.dataDir, 'old-polling-stopped'), 'done');
        }, { once: true });
        return () => {
          resourceClosed = true;
          clearInterval(timer);
          writeFileSync(join(context.dataDir, 'old-cleanup'), 'done');
        };
      }
      export async function execute(commandId, input, context) {
        writeFileSync(join(context.dataDir, 'execution-started'), 'yes');
        while (!existsSync(join(context.dataDir, 'release-execution'))) await new Promise(resolve => setTimeout(resolve, 10));
        if (resourceClosed) throw new Error('Database connection was closed before the command finished.');
        return { version: 'old', input };
      }
    `,
    );
    const first = await runtime.publish(workspace.id, id);
    const running = runtime.execute(workspace.id, id, first.version!, 'run', { approved: true });
    const data = join(location.directory, '..', 'data');
    await expect
      .poll(() => readFile(join(data, 'execution-started'), 'utf8').catch(() => ''))
      .toBe('yes');
    await backend(
      location.directory,
      `export function execute(commandId, input) { return { version: 'new', input }; }`,
    );
    const second = await runtime.publish(workspace.id, id);
    await expect
      .poll(() => readFile(join(data, 'old-polling-stopped'), 'utf8').catch(() => ''))
      .toBe('done');
    await expect(readFile(join(data, 'old-cleanup'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(
      await runtime.execute(workspace.id, id, second.version!, 'run', { approved: 'new' }),
    ).toEqual({ version: 'new', input: { approved: 'new' } });
    await writeFile(join(data, 'release-execution'), 'go');
    expect(await running).toEqual({ version: 'old', input: { approved: true } });
    await expect
      .poll(() => readFile(join(data, 'old-cleanup'), 'utf8').catch(() => ''))
      .toBe('done');
  });

  it('prepares frontend-only agent commands without executing or inventing sessions', async () => {
    const { workspace, runtime, location, id } = await setup();
    await writeFile(
      join(location.directory, 'manifest.json'),
      JSON.stringify({
        schemaVersion: 1,
        name: 'Agent tasks',
        commands: [{ id: 'ask', label: 'Ask', type: 'agent' }],
      }),
    );
    const published = await runtime.publish(workspace.id, id);
    expect(
      await runtime.prepare(
        workspace.id,
        id,
        published.version!,
        'ask',
        { project: 'map' },
        'Inspect this map',
      ),
    ).toEqual({ input: { project: 'map' }, prompt: 'Inspect this map' });
    await expect(
      runtime.prepare(workspace.id, id, published.version!, 'missing', {}, 'Hello'),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it('bounds server shutdown and rejects an unfinished execution', async () => {
    const { workspace, runtime, location, id } = await setup();
    await backend(
      location.directory,
      `export async function execute() { await new Promise(() => {}); }`,
    );
    const published = await runtime.publish(workspace.id, id);
    const running = runtime.execute(workspace.id, id, published.version!, 'run', {}).then(
      () => 'succeeded',
      (error) => error.message,
    );
    // Ensure the execute request has passed the async workspace lookup before closing.
    await new Promise((resolve) => setTimeout(resolve, 30));
    const started = Date.now();
    await runtime.close();
    expect(Date.now() - started).toBeLessThan(4_000);
    expect(await running).toContain('backend stopped');
  });
});
