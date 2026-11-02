import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import {
  claudeDesktopConfigPath,
  configureClaudeDesktopMcp,
  installClaudeDesktopMcp,
  removeClaudeDesktopMcp,
} from './claude-desktop-mcp.js';

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function temporary() {
  const directory = await mkdtemp(join(tmpdir(), 'congruence-claude-mcp-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
const endpoint = 'http://127.0.0.1:4310/mcp';

describe('Claude Code Desktop MCP config', () => {
  it('uses .claude.json in the user home directory', () => {
    expect(claudeDesktopConfigPath()).toBe(join(homedir(), '.claude.json'));
  });

  it('updates only the Congruence entry, retaining other servers and project settings', () => {
    const original = {
      theme: 'dark',
      projects: { 'D:/test': { trusted: true } },
      mcpServers: {
        other: { command: 'other', args: ['start'] },
        congruence: { type: 'stdio', command: 'old' },
      },
    };
    const source = JSON.stringify(original, null, 4).replace(/\n/g, '\r\n');
    const updated = configureClaudeDesktopMcp(source, endpoint);
    expect(JSON.parse(updated)).toEqual({
      ...original,
      mcpServers: { other: original.mcpServers.other, congruence: { type: 'http', url: endpoint } },
    });
    expect(updated).toContain('\r\n    "theme"');
    expect(configureClaudeDesktopMcp(updated, endpoint)).toBe(updated);
    expect(JSON.parse(configureClaudeDesktopMcp(updated, null))).toEqual({
      ...original,
      mcpServers: { other: original.mcpServers.other },
    });
  });

  it('creates a missing file and supports repeated removal without creating files', async () => {
    const directory = await temporary();
    const path = join(directory, '.claude.json');
    await removeClaudeDesktopMcp(path);
    expect(await readdir(directory)).toEqual([]);
    await Promise.all([
      installClaudeDesktopMcp(path, endpoint),
      installClaudeDesktopMcp(path, endpoint),
    ]);
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({
      mcpServers: { congruence: { type: 'http', url: endpoint } },
    });
    await removeClaudeDesktopMcp(path);
    const removed = await readFile(path, 'utf8');
    await removeClaudeDesktopMcp(path);
    expect(await readFile(path, 'utf8')).toBe(removed);
    expect(await readdir(directory)).toEqual(['.claude.json']);
  });

  it('preserves existing HTTP connection options when updating the URL', () => {
    const source = JSON.stringify({
      mcpServers: {
        congruence: {
          type: 'http',
          url: 'http://localhost:9999/mcp',
          headers: { 'X-Workspace': 'example' },
        },
      },
    });
    expect(JSON.parse(configureClaudeDesktopMcp(source, endpoint))).toEqual({
      mcpServers: {
        congruence: { type: 'http', url: endpoint, headers: { 'X-Workspace': 'example' } },
      },
    });
  });

  it.each(['{bad', '[]', 'null', '{"mcpServers":null}', '{"mcpServers":[]}'])(
    'refuses malformed configuration without changing the file: %s',
    async (source) => {
      const directory = await temporary();
      const path = join(directory, '.claude.json');
      await writeFile(path, source);
      await expect(installClaudeDesktopMcp(path, endpoint)).rejects.toThrow();
      await expect(removeClaudeDesktopMcp(path)).rejects.toThrow();
      expect(await readFile(path, 'utf8')).toBe(source);
    },
  );

  it('serves the file path and restricts apply and remove to the same-origin UI', async () => {
    const directory = await temporary();
    const path = join(directory, '.claude.json');
    const app = await buildApp({
      dataDir: join(directory, 'data'),
      claudeConfigPath: path,
      serveWeb: false,
      mcp: false,
      desktopAdapter: false,
    });
    cleanups.push(() => app.close());
    const url = '/api/agent-settings/claude-desktop-mcp';
    const headers = { host: 'localhost:4310', origin: 'http://localhost:4310' };
    expect((await app.inject({ url, headers })).json()).toEqual({
      configPath: path,
      endpoint: 'http://localhost:4310/mcp',
    });
    for (const method of ['POST', 'DELETE'] as const) {
      for (const origin of [undefined, 'http://localhost:4321', 'https://remote.example']) {
        expect(
          (
            await app.inject({
              method,
              url,
              headers: { host: headers.host, ...(origin ? { origin } : {}) },
            })
          ).statusCode,
        ).toBe(403);
      }
      expect((await app.inject({ method, url, headers })).statusCode).toBe(200);
      expect(Boolean(JSON.parse(await readFile(path, 'utf8')).mcpServers.congruence)).toBe(
        method === 'POST',
      );
    }
  });
});
