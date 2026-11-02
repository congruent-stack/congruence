import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import * as fs from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../../app.js';
import {
  codexConfigPath,
  configureCodexMcp,
  installCodexMcp,
  removeCodexMcp,
  removeCodexMcpConfig,
  updateMcpConfig,
} from './mcp-setup.js';

vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs/promises')>()),
}));

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const endpoint = 'http://127.0.0.1:4310/mcp';
async function temporary() {
  const directory = await mkdtemp(join(tmpdir(), 'congruence-mcp-setup-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

describe('Codex MCP configuration', () => {
  it('resolves CODEX_HOME when configured', () => {
    vi.stubEnv('CODEX_HOME', 'custom-codex-home');
    expect(codexConfigPath()).toBe(resolve('custom-codex-home', 'config.toml'));
  });

  it('preserves comments, quoted keys, other servers, nested settings and CRLF', () => {
    const original = [
      '# My settings',
      'model = "example"',
      '',
      '[mcp_servers."congruence"] # keep this',
      'url = "http://localhost:9999/mcp" # endpoint',
      'enabled = false # toggle',
      'tool_timeout_sec = 60',
      '[mcp_servers.congruence.http_headers]',
      '"X-Test" = "yes"',
      '[mcp_servers.other]',
      'command = "other"',
      '',
    ].join('\r\n');
    const updated = configureCodexMcp(original, endpoint);
    expect(updated).toBe(
      original
        .replace('http://localhost:9999/mcp', endpoint)
        .replace('enabled = false', 'enabled = true'),
    );
    expect(configureCodexMcp(updated, endpoint)).toBe(updated);
  });

  it.each([
    '[mcp_servers.congruence]',
    '[mcp_servers.congruence] # header\n',
    '[mcp_servers.congruence]\nurl = "old" # keep',
  ])('inserts missing keys into a table, including at EOF: %s', (original) => {
    const updated = configureCodexMcp(original, endpoint);
    expect(updated).toContain(`url = "${endpoint}"`);
    expect(updated).toContain('enabled = true');
    expect(configureCodexMcp(updated, endpoint)).toBe(updated);
  });

  it('does not mistake multiline string content for a server table', () => {
    const original = 'instructions = """\n[mcp_servers.congruence]\nurl = fake\n"""\n';
    expect(configureCodexMcp(original, endpoint)).toContain(original);
    expect(configureCodexMcp(original, endpoint)).toContain(`url = "${endpoint}"`);
  });

  it('creates missing directories and serializes repeated installs without duplicates', async () => {
    const directory = await temporary();
    const path = join(directory, '.codex', 'config.toml');
    await Promise.all([installCodexMcp(path, endpoint), installCodexMcp(path, endpoint)]);
    const result = await readFile(path, 'utf8');
    expect(result.match(/\[mcp_servers.congruence\]/g)).toHaveLength(1);
    expect(await readdir(join(directory, '.codex'))).toEqual(['config.toml']);
  });

  it('updates a resolved config target without replacing the link path', async () => {
    const directory = await temporary();
    const path = join(directory, 'config.toml');
    const target = join(directory, 'managed-config.toml');
    const original = '# Managed config\nmodel = "example"\n';
    await writeFile(path, original);
    await writeFile(target, original);
    const { realpath } =
      await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    // Model a file symlink without requiring Windows symlink privileges.
    vi.spyOn(fs, 'realpath').mockImplementation(async (candidate, options) =>
      String(candidate) === path ? target : realpath(candidate, options),
    );
    await installCodexMcp(path, endpoint);
    expect(await readFile(path, 'utf8')).toBe(original);
    expect(await readFile(target, 'utf8')).toContain(`url = "${endpoint}"`);
    await removeCodexMcp(path);
    expect(await readFile(path, 'utf8')).toBe(original);
    expect(await readFile(target, 'utf8')).not.toContain('[mcp_servers.congruence]');
  });

  it('preserves an external edit made while preparing the update', async () => {
    const directory = await temporary();
    const path = join(directory, 'config.toml');
    await writeFile(path, 'model = "before"\n');
    const external = 'model = "external change"\n';
    await expect(
      updateMcpConfig(
        path,
        (source) => {
          writeFileSync(path, external);
          return configureCodexMcp(source, endpoint);
        },
        'Codex',
        'TOML',
      ),
    ).rejects.toThrow('configuration changed while saving');
    expect(await readFile(path, 'utf8')).toBe(external);
    expect(await readdir(directory)).toEqual(['config.toml']);
  });

  it('leaves a broken config link untouched', async () => {
    const directory = await temporary();
    const path = join(directory, 'config.toml');
    const original = 'model = "example"\n';
    await writeFile(path, original);
    const info = await fs.lstat(path);
    info.isSymbolicLink = () => true;
    vi.spyOn(fs, 'lstat').mockResolvedValue(info);
    vi.spyOn(fs, 'realpath').mockRejectedValue(
      Object.assign(new Error('Missing target'), { code: 'ENOENT' }),
    );
    await expect(installCodexMcp(path, endpoint)).rejects.toThrow('points to a missing file');
    expect(await readFile(path, 'utf8')).toBe(original);
    expect(await readdir(directory)).toEqual(['config.toml']);
  });

  it('does not overwrite either target if a config link changes while saving', async () => {
    const directory = await temporary();
    const path = join(directory, 'config.toml');
    const first = join(directory, 'first.toml');
    const second = join(directory, 'second.toml');
    const original = 'model = "example"\n';
    await writeFile(first, original);
    await writeFile(second, original);
    vi.spyOn(fs, 'realpath').mockResolvedValueOnce(first).mockResolvedValue(second);
    await expect(installCodexMcp(path, endpoint)).rejects.toThrow(
      'configuration changed while saving',
    );
    expect(await readFile(first, 'utf8')).toBe(original);
    expect(await readFile(second, 'utf8')).toBe(original);
    expect((await readdir(directory)).sort()).toEqual(['first.toml', 'second.toml']);
  });

  it.each([
    'broken = [',
    '[mcp_servers.congruence]\ncommand = "existing"\n',
    'mcp_servers = { congruence = { url = "old" } }',
  ])('leaves invalid or unsupported configurations untouched: %s', async (original) => {
    const directory = await temporary();
    const path = join(directory, 'config.toml');
    await writeFile(path, original);
    await expect(installCodexMcp(path, endpoint)).rejects.toThrow(/manual/);
    expect(await readFile(path, 'utf8')).toBe(original);
    expect(await readdir(directory)).toEqual(['config.toml']);
  });

  it('exposes the path and server endpoint and requires same-origin UI writes', async () => {
    const directory = await temporary();
    const app = await buildApp({
      dataDir: join(directory, 'data'),
      codexHome: join(directory, 'codex'),
      serveWeb: false,
      mcp: false,
      desktopAdapter: false,
    });
    cleanups.push(() => app.close());
    const url = '/api/agent-settings/codex-mcp';
    expect((await app.inject({ url, headers: { host: 'localhost:4310' } })).json()).toEqual({
      configPath: join(directory, 'codex', 'config.toml'),
      endpoint: 'http://localhost:4310/mcp',
    });
    for (const origin of [undefined, 'http://localhost:4321', 'https://malicious.example']) {
      expect(
        (await app.inject({ method: 'POST', url, headers: origin ? { origin } : {} })).statusCode,
      ).toBe(403);
    }
    const response = await app.inject({
      method: 'POST',
      url,
      headers: { host: 'localhost:4310', origin: 'http://localhost:4310' },
    });
    expect(response.statusCode).toBe(200);
    const saved = await readFile(join(directory, 'codex', 'config.toml'), 'utf8');
    expect(saved).toContain('url = "http://localhost:4310/mcp"');
    for (const origin of [undefined, 'http://localhost:4321', 'https://malicious.example']) {
      expect(
        (await app.inject({ method: 'DELETE', url, headers: origin ? { origin } : {} })).statusCode,
      ).toBe(403);
    }
    expect(await readFile(join(directory, 'codex', 'config.toml'), 'utf8')).toBe(saved);
    expect(
      (
        await app.inject({
          method: 'DELETE',
          url,
          headers: { host: 'localhost:4310', origin: 'http://localhost:4310' },
        })
      ).statusCode,
    ).toBe(200);
    expect(await readFile(join(directory, 'codex', 'config.toml'), 'utf8')).not.toContain(
      'mcp_servers.congruence',
    );
  });

  it('removes the server and all its nested tables while preserving other settings and comments', () => {
    const original = [
      '# My settings',
      'model = "example"',
      '[mcp_servers."congruence"] # remove',
      'url = "old"',
      '[mcp_servers.other]',
      'url = "keep" # keep',
      '[mcp_servers.congruence.http_headers]',
      '"X-Test" = "yes"',
      '[mcp_servers.congruence.tools.read]',
      'approval_mode = "prompt"',
      '[mcp_servers.congruence_extra]',
      'command = "keep"',
      '[projects."D:/test"]',
      'trust_level = "trusted"',
      '',
    ].join('\r\n');
    const updated = removeCodexMcpConfig(original);
    expect(updated).toBe(
      [
        '# My settings',
        'model = "example"',
        '[mcp_servers.other]',
        'url = "keep" # keep',
        '[mcp_servers.congruence_extra]',
        'command = "keep"',
        '[projects."D:/test"]',
        'trust_level = "trusted"',
        '',
      ].join('\r\n'),
    );
    expect(removeCodexMcpConfig(updated)).toBe(updated);
  });

  it('handles removal of an empty table at EOF and an implicitly declared parent', () => {
    expect(removeCodexMcpConfig('[mcp_servers.congruence]')).toBe('');
    expect(removeCodexMcpConfig('[mcp_servers.congruence.http_headers]\nkey = "value"')).toBe('');
  });

  it('does not create a missing config file when removing', async () => {
    const directory = await temporary();
    await removeCodexMcp(join(directory, 'missing', 'config.toml'));
    expect(await readdir(directory)).toEqual([]);
  });

  it.each(['broken = [', 'mcp_servers = { congruence = { url = "old" } }'])(
    'leaves invalid or unsupported config untouched when removing: %s',
    async (source) => {
      const directory = await temporary();
      const path = join(directory, 'config.toml');
      await writeFile(path, source);
      await expect(removeCodexMcp(path)).rejects.toThrow(/manual/);
      expect(await readFile(path, 'utf8')).toBe(source);
    },
  );
});
