import { randomUUID } from 'node:crypto';
import { cp, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { Worker } from 'node:worker_threads';
import { build } from 'esbuild';
import Schema from 'typebox/schema';
import {
  DashboardCreateSchema,
  DashboardManifestSchema,
  type DashboardCreate,
  type DashboardLocation,
  type DashboardManifest,
  type DashboardSummary,
} from '@congruence/contracts';
import { StoreError, type Store } from '../../storage/store.js';
import { dashboardWorkerSource } from './worker.js';
import {
  dashboardApiTypes,
  dashboardFrontend,
  dashboardHtml,
  dashboardInstructions,
  frontendEntry,
} from './templates.js';

const manifestValidator = Schema.Compile(DashboardManifestSchema);
const createValidator = Schema.Compile(DashboardCreateSchema);
const require = createRequire(import.meta.url);
const dependencyDirectory = resolve(dirname(require.resolve('react/package.json')), '..');
const reactDomDirectory = resolve(dirname(require.resolve('react-dom/package.json')), '..');

interface DashboardRecord {
  id: string;
  workspaceId: string;
  manifest: DashboardManifest;
  version?: string;
  backend: boolean;
  releases: string[];
}
type PreparedCommand = { input: Record<string, unknown>; prompt?: string; summary?: string };

function failure(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
function isMissing(error: unknown) {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}
async function exists(path: string) {
  try {
    return (await stat(path)).isFile();
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}
function segment(value: string) {
  if (!/^[a-z0-9][a-z0-9_-]{0,199}$/i.test(value)) {
    throw new StoreError('Invalid dashboard location.', 400);
  }
  return value;
}
function jsonSnapshot<T>(value: T): T {
  const seen = new Set<object>();
  function check(item: unknown): void {
    if (item === null || ['string', 'boolean'].includes(typeof item)) return;
    if (typeof item === 'number' && Number.isFinite(item)) return;
    if (typeof item !== 'object' || item === undefined) {
      throw new StoreError('Dashboard values must be JSON serializable.', 400);
    }
    if (seen.has(item)) throw new StoreError('Dashboard values cannot contain cycles.', 400);
    if (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype) {
      throw new StoreError('Dashboard values must contain plain JSON objects.', 400);
    }
    seen.add(item);
    for (const child of Object.values(item)) check(child);
    seen.delete(item);
  }
  check(value);
  return JSON.parse(JSON.stringify(value)) as T;
}
function inputSnapshot(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new StoreError('Dashboard input must be an object.', 400);
  }
  return jsonSnapshot(input as Record<string, unknown>);
}

class BackendWorker {
  private readonly worker: Worker;
  private readonly pending = new Map<
    number,
    { resolve(value: unknown): void; reject(error: Error): void }
  >();
  private sequence = 0;
  private stopped = false;
  private error?: Error;
  private retirement?: Promise<void>;
  readonly version: string;
  readonly ready: Promise<void>;

  constructor(
    backendPath: string,
    record: DashboardRecord,
    dataDir: string,
    onError: (message: string) => void,
  ) {
    this.version = record.version!;
    this.worker = new Worker(dashboardWorkerSource, {
      eval: true,
      workerData: { backendPath, workspaceId: record.workspaceId, dashboardId: record.id, dataDir },
    });
    this.ready = new Promise<void>((resolveReady, rejectReady) => {
      const timeout = setTimeout(() => {
        const error = new Error('Dashboard backend did not start within 30 seconds.');
        rejectReady(error);
        void this.worker.terminate();
      }, 30_000);
      this.worker.on('message', (message) => {
        if ('ready' in message) {
          clearTimeout(timeout);
          if (message.ready) resolveReady();
          else rejectReady(new Error(message.error));
          return;
        }
        const request = this.pending.get(message.id);
        if (!request) return;
        this.pending.delete(message.id);
        if (message.error) request.reject(new Error(message.error));
        else request.resolve(message.result);
      });
      const fail = (error: Error) => {
        clearTimeout(timeout);
        this.error = error;
        rejectReady(error);
        for (const request of this.pending.values()) request.reject(error);
        this.pending.clear();
        if (!this.stopped) onError(error.message);
      };
      this.worker.on('error', fail);
      this.worker.on('exit', (code) => {
        if (!this.stopped || this.pending.size)
          fail(new Error(`Dashboard backend stopped (exit ${code}).`));
      });
    });
  }

  call(method: string, args: unknown[]): Promise<unknown> {
    if (this.error) return Promise.reject(new StoreError(this.error.message, 503));
    const id = ++this.sequence;
    return new Promise((resolveResult, reject) => {
      this.pending.set(id, { resolve: resolveResult, reject });
      try {
        this.worker.postMessage({ id, method, args });
      } catch (error) {
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  async retire(forceAfterMs?: number) {
    const force =
      forceAfterMs === undefined
        ? undefined
        : setTimeout(() => void this.worker.terminate(), forceAfterMs);
    this.retirement ??= this.drain();
    try {
      await this.retirement;
    } finally {
      clearTimeout(force);
    }
  }

  private async drain() {
    this.stopped = true;
    if (!this.error) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        // Stop collection promptly without disposing resources used by approved commands.
        await this.call('retire', []);
        while (this.pending.size) await new Promise((resolveDone) => setTimeout(resolveDone, 10));
        await Promise.race([
          this.call('stop', []),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error('Dashboard background cleanup timed out.')),
              10_000,
            );
          }),
        ]);
      } catch {
        // A failed cleanup cannot leave an obsolete background worker alive.
      } finally {
        clearTimeout(timer);
      }
    }
    await this.worker.terminate();
  }
}

export class DashboardRuntime {
  private records: DashboardRecord[] = [];
  private readonly workers = new Map<string, BackendWorker>();
  private readonly errors = new Map<string, string>();
  private readonly publishing = new Map<string, Promise<DashboardSummary>>();
  private readonly retiring = new Set<Promise<void>>();
  private readonly drainingWorkers = new Set<BackendWorker>();
  private persistence: Promise<unknown> = Promise.resolve();
  private closed = false;
  private readonly root: string;

  constructor(
    dataDir: string,
    private readonly store: Store,
  ) {
    this.root = join(resolve(dataDir), 'dashboards');
  }

  async initialize() {
    await mkdir(this.root, { recursive: true });
    try {
      const saved = JSON.parse(await readFile(join(this.root, 'registry.json'), 'utf8'));
      if (saved.schemaVersion !== 1 || !Array.isArray(saved.dashboards))
        throw new Error('Invalid dashboard registry.');
      for (const record of saved.dashboards) {
        segment(record.id);
        segment(record.workspaceId);
        if (
          !manifestValidator.Check(record.manifest) ||
          !Array.isArray(record.releases) ||
          typeof record.backend !== 'boolean'
        ) {
          throw new Error('Invalid dashboard registry.');
        }
        record.releases.forEach(segment);
        if (record.version && !record.releases.includes(record.version))
          throw new Error('Invalid dashboard release.');
      }
      this.records = saved.dashboards;
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    await Promise.all(
      this.records
        .filter((record) => record.version && record.backend)
        .map(async (record) => {
          try {
            await this.store.getWorkspace(record.workspaceId);
            const worker = await this.startWorker(record, this.release(record, record.version!));
            this.workers.set(record.id, worker);
          } catch (error) {
            this.errors.set(record.id, failure(error));
          }
        }),
    );
  }

  private directory(record: Pick<DashboardRecord, 'workspaceId' | 'id'>) {
    return join(this.root, segment(record.workspaceId), segment(record.id));
  }
  private release(record: DashboardRecord, version: string) {
    return join(this.directory(record), 'releases', segment(version));
  }
  private summary(record: DashboardRecord): DashboardSummary {
    const error = this.errors.get(record.id);
    return structuredClone({
      id: record.id,
      workspaceId: record.workspaceId,
      name: record.manifest.name,
      description: record.manifest.description ?? '',
      backend: record.backend,
      status: error ? 'error' : record.version ? 'ready' : 'draft',
      ...(error ? { error } : {}),
      ...(record.version
        ? {
            version: record.version,
            frameUrl: `/api/workspaces/${encodeURIComponent(record.workspaceId)}/dashboards/${record.id}/versions/${record.version}/assets/index.html`,
          }
        : {}),
      commands: record.manifest.commands,
    });
  }
  private async record(workspaceId: string, dashboardId: string) {
    if (this.closed) throw new StoreError('Dashboard runtime is closed.', 503);
    const workspace = await this.store.getWorkspace(workspaceId);
    const record = this.records.find(
      (item) => item.workspaceId === workspace.id && item.id === dashboardId,
    );
    if (!record) throw new StoreError('Dashboard not found in this workspace.', 404);
    return record;
  }
  private async save(record: DashboardRecord) {
    const operation = this.persistence.then(async () => {
      const records = this.records.filter((item) => item.id !== record.id).concat(record);
      const temporary = join(this.root, `registry-${randomUUID()}.tmp`);
      try {
        await writeFile(
          temporary,
          JSON.stringify({ schemaVersion: 1, dashboards: records }, null, 2),
        );
        await rename(temporary, join(this.root, 'registry.json'));
        this.records = records;
      } catch (error) {
        await rm(temporary, { force: true });
        throw error;
      }
    });
    this.persistence = operation.catch(() => undefined);
    await operation;
  }

  async list(workspaceId: string): Promise<DashboardSummary[]> {
    const workspace = await this.store.getWorkspace(workspaceId);
    return this.records
      .filter((record) => record.workspaceId === workspace.id)
      .map((record) => this.summary(record));
  }
  async get(workspaceId: string, dashboardId: string): Promise<DashboardSummary> {
    return this.summary(await this.record(workspaceId, dashboardId));
  }
  async location(workspaceId: string, dashboardId: string): Promise<DashboardLocation> {
    const record = await this.record(workspaceId, dashboardId);
    const directory = join(this.directory(record), 'source');
    return {
      dashboard: this.summary(record),
      directory,
      instructionsPath: join(directory, 'DASHBOARD.md'),
    };
  }
  async create(workspaceId: string, input: DashboardCreate): Promise<DashboardLocation> {
    if (this.closed) throw new StoreError('Dashboard runtime is closed.', 503);
    const workspace = await this.store.getWorkspace(workspaceId);
    if (!createValidator.Check(input) || !input.name.trim())
      throw new StoreError('Invalid dashboard details.', 400);
    const record: DashboardRecord = {
      id: randomUUID(),
      workspaceId: workspace.id,
      manifest: {
        schemaVersion: 1,
        name: input.name.trim(),
        description: input.description ?? '',
        commands: [],
      },
      backend: false,
      releases: [],
    };
    const directory = join(this.directory(record), 'source');
    await mkdir(join(directory, 'src'), { recursive: true });
    await Promise.all([
      writeFile(join(directory, 'manifest.json'), JSON.stringify(record.manifest, null, 2)),
      writeFile(
        join(directory, 'package.json'),
        JSON.stringify({ name: `dashboard-${record.id}`, private: true, type: 'module' }, null, 2),
      ),
      writeFile(join(directory, 'src', 'frontend.tsx'), dashboardFrontend),
      writeFile(join(directory, 'src', 'congruence.ts'), dashboardApiTypes),
      writeFile(join(directory, 'DASHBOARD.md'), dashboardInstructions(workspace.id, record.id)),
    ]);
    await this.save(record);
    return this.location(workspace.id, record.id);
  }

  async publish(workspaceId: string, dashboardId: string): Promise<DashboardSummary> {
    const record = await this.record(workspaceId, dashboardId);
    if (this.publishing.has(record.id))
      throw new StoreError('Dashboard publication is already in progress.', 409);
    const work = this.buildRelease(record);
    this.publishing.set(record.id, work);
    try {
      return await work;
    } finally {
      this.publishing.delete(record.id);
    }
  }

  private async buildRelease(previous: DashboardRecord): Promise<DashboardSummary> {
    const version = randomUUID();
    const directory = this.directory(previous);
    const source = join(directory, 'source');
    const staging = join(directory, `staging-${version}`);
    const release = this.release(previous, version);
    let candidate: BackendWorker | undefined;
    try {
      // Build a stable source snapshot. Installed dependencies remain at their source location.
      await cp(source, join(staging, 'source'), {
        recursive: true,
        filter: (path) => !relative(source, path).split(sep).includes('node_modules'),
      });
      const manifest: DashboardManifest = JSON.parse(
        await readFile(join(staging, 'source', 'manifest.json'), 'utf8'),
      );
      if (
        !manifestValidator.Check(manifest) ||
        !manifest.name.trim() ||
        new Set(manifest.commands.map((command) => command.id)).size !== manifest.commands.length
      ) {
        throw new StoreError('Invalid dashboard manifest or duplicate command IDs.', 400);
      }
      const backend = await exists(join(staging, 'source', 'src', 'backend.ts'));
      if (!backend && manifest.commands.some((command) => command.type === 'backend')) {
        throw new StoreError('Backend commands require src/backend.ts.', 400);
      }
      const nodePaths = [join(source, 'node_modules'), dependencyDirectory, reactDomDirectory];
      await mkdir(join(staging, 'public'), { recursive: true });
      await build({
        stdin: {
          contents: frontendEntry(join(staging, 'source', 'src', 'frontend.tsx'), version),
          resolveDir: source,
          loader: 'tsx',
        },
        outfile: join(staging, 'public', 'dashboard.js'),
        bundle: true,
        platform: 'browser',
        format: 'iife',
        jsx: 'automatic',
        target: 'es2022',
        nodePaths,
        logLevel: 'silent',
        define: { 'process.env.NODE_ENV': '"production"' },
        loader: {
          '.png': 'file',
          '.jpg': 'file',
          '.jpeg': 'file',
          '.gif': 'file',
          '.svg': 'file',
          '.woff': 'file',
          '.woff2': 'file',
        },
        assetNames: 'assets/[name]-[hash]',
      });
      if (backend) {
        await build({
          entryPoints: [join(staging, 'source', 'src', 'backend.ts')],
          outfile: join(staging, 'backend.cjs'),
          bundle: true,
          platform: 'node',
          format: 'cjs',
          target: 'node24',
          nodePaths,
          logLevel: 'silent',
        });
      }
      await writeFile(
        join(staging, 'public', 'index.html'),
        dashboardHtml(await exists(join(staging, 'public', 'dashboard.css'))),
      );
      await mkdir(dirname(release), { recursive: true });
      await rename(staging, release);
      const next: DashboardRecord = {
        ...previous,
        manifest,
        version,
        backend,
        releases: [...previous.releases, version],
      };
      if (backend) candidate = await this.startWorker(next, release);
      await this.save(next);
      const old = this.workers.get(previous.id);
      if (candidate) this.workers.set(previous.id, candidate);
      else this.workers.delete(previous.id);
      this.errors.delete(previous.id);
      if (old) this.trackRetirement(old);
      return this.summary(next);
    } catch (error) {
      this.errors.set(previous.id, `Publication failed: ${failure(error)}`);
      if (candidate) await candidate.retire();
      await Promise.all([
        rm(staging, { recursive: true, force: true }),
        rm(release, { recursive: true, force: true }),
      ]);
      throw new StoreError(
        `Dashboard publication failed: ${failure(error)}`,
        error instanceof StoreError ? error.statusCode : 400,
      );
    }
  }

  private async startWorker(record: DashboardRecord, release: string) {
    const dataDir = join(this.directory(record), 'data');
    await mkdir(dataDir, { recursive: true });
    const worker = new BackendWorker(join(release, 'backend.cjs'), record, dataDir, (message) => {
      if (this.workers.get(record.id) === worker) this.errors.set(record.id, message);
    });
    try {
      await worker.ready;
      return worker;
    } catch (error) {
      await worker.retire();
      throw error;
    }
  }
  private trackRetirement(worker: BackendWorker) {
    const work = worker.retire();
    this.drainingWorkers.add(worker);
    this.retiring.add(work);
    void work.finally(() => {
      this.retiring.delete(work);
      this.drainingWorkers.delete(worker);
    });
  }
  private async current(workspaceId: string, dashboardId: string, version: string) {
    const record = await this.record(workspaceId, dashboardId);
    if (!record.version || record.version !== version)
      throw new StoreError('Dashboard version changed. Refresh and review the command again.', 409);
    return record;
  }
  private worker(record: DashboardRecord) {
    this.assertCurrentVersion(record);
    const worker = this.workers.get(record.id);
    if (!worker)
      throw new StoreError(this.errors.get(record.id) ?? 'Dashboard has no running backend.', 503);
    if (worker.version !== record.version)
      throw new StoreError('Dashboard version changed. Refresh and review the command again.', 409);
    return worker;
  }
  private assertCurrentVersion(record: DashboardRecord) {
    if (this.records.find((current) => current.id === record.id)?.version !== record.version) {
      throw new StoreError('Dashboard version changed. Refresh and review the command again.', 409);
    }
  }
  async read(
    workspaceId: string,
    dashboardId: string,
    version: string,
    query: string,
    input: Record<string, unknown>,
  ): Promise<unknown> {
    const record = await this.current(workspaceId, dashboardId, version);
    return jsonSnapshot(await this.worker(record).call('read', [query, inputSnapshot(input)]));
  }
  async prepare(
    workspaceId: string,
    dashboardId: string,
    version: string,
    commandId: string,
    input: Record<string, unknown>,
    prompt?: string,
  ): Promise<PreparedCommand> {
    const record = await this.current(workspaceId, dashboardId, version);
    this.assertCurrentVersion(record);
    if (!record.manifest.commands.some((command) => command.id === commandId))
      throw new StoreError('Dashboard command not found.', 404);
    const snapshot = inputSnapshot(input);
    const result = record.backend
      ? await this.worker(record).call('prepare', [commandId, snapshot])
      : { input: snapshot };
    this.assertCurrentVersion(record);
    if (!result || typeof result !== 'object' || Array.isArray(result))
      throw new StoreError('Dashboard prepare must return { input, prompt?, summary? }.', 400);
    const prepared = result as PreparedCommand;
    if (
      (prepared.prompt !== undefined && typeof prepared.prompt !== 'string') ||
      (prepared.summary !== undefined && typeof prepared.summary !== 'string')
    ) {
      throw new StoreError('Dashboard prompt and summary must be text.', 400);
    }
    return {
      input: inputSnapshot(prepared.input),
      ...(prepared.prompt !== undefined || prompt !== undefined
        ? { prompt: prepared.prompt ?? prompt }
        : {}),
      ...(prepared.summary !== undefined ? { summary: prepared.summary } : {}),
    };
  }
  async execute(
    workspaceId: string,
    dashboardId: string,
    version: string,
    commandId: string,
    input: Record<string, unknown>,
  ): Promise<unknown> {
    const record = await this.current(workspaceId, dashboardId, version);
    if (record.manifest.commands.find((command) => command.id === commandId)?.type !== 'backend')
      throw new StoreError('Command is not a backend command.', 400);
    const result = await this.worker(record).call('execute', [commandId, inputSnapshot(input)]);
    return result === undefined ? null : jsonSnapshot(result);
  }
  async asset(
    workspaceId: string,
    dashboardId: string,
    version: string,
    path: string,
  ): Promise<{ body: Buffer; contentType: string }> {
    const record = await this.record(workspaceId, dashboardId);
    if (!record.releases.includes(version))
      throw new StoreError('Dashboard version not found.', 404);
    const publicDirectory = join(this.release(record, version), 'public');
    const file = resolve(publicDirectory, path);
    const within = relative(publicDirectory, file);
    if (
      !path ||
      isAbsolute(path) ||
      within.startsWith('..') ||
      isAbsolute(within) ||
      path.includes('\\')
    )
      throw new StoreError('Dashboard asset not found.', 404);
    const types: Record<string, string> = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.svg': 'image/svg+xml',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.woff': 'font/woff',
      '.woff2': 'font/woff2',
    };
    try {
      return {
        body: await readFile(file),
        contentType: types[extname(file)] ?? 'application/octet-stream',
      };
    } catch (error) {
      if (isMissing(error) || (error as NodeJS.ErrnoException).code === 'EISDIR')
        throw new StoreError('Dashboard asset not found.', 404);
      throw error;
    }
  }
  async close(): Promise<void> {
    this.closed = true;
    await Promise.allSettled(this.publishing.values());
    await Promise.all(
      [...new Set([...this.workers.values(), ...this.drainingWorkers])].map((worker) =>
        worker.retire(2_000),
      ),
    );
    await Promise.all(this.retiring);
    await this.persistence;
    this.workers.clear();
  }
}

export async function createDashboardRuntime(
  dataDir: string,
  store: Store,
): Promise<DashboardRuntime> {
  const runtime = new DashboardRuntime(dataDir, store);
  await runtime.initialize();
  return runtime;
}
