import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import {
  claudeDesktopModInstalled,
  claudeSettingsPath,
  configureClaudeDesktopMod,
  installClaudeDesktopMod,
  removeClaudeDesktopMod,
} from './claude-desktop-mod.js';

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function temporary() {
  const directory = await mkdtemp(join(tmpdir(), 'congruence-claude-mod-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
const pluginDir = 'D:\\dev\\congruence\\apps\\claude-mod';
const url = 'http://127.0.0.1:4310';

describe('Claude Code Desktop mod settings', () => {
  it('uses settings.json in the Claude configuration directory', () => {
    expect(claudeSettingsPath()).toBe(
      resolve(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'settings.json'),
    );
    expect(claudeSettingsPath('D:/claude-config')).toBe(resolve('D:/claude-config/settings.json'));
  });

  it('adds only its folder and URL, keeping other plugin folders, variables, and settings', () => {
    const original = {
      effortLevel: 'xhigh',
      env: { DEBUG: '1', CLAUDE_CODE_PLUGIN_DIRS: 'D:\\mods\\other' },
    };
    const source = JSON.stringify(original, null, 4).replace(/\n/g, '\r\n');
    const installed = configureClaudeDesktopMod(source, pluginDir, url, ';');
    expect(JSON.parse(installed)).toEqual({
      effortLevel: 'xhigh',
      env: {
        DEBUG: '1',
        CLAUDE_CODE_PLUGIN_DIRS: `D:\\mods\\other;${pluginDir}`,
        CONGRUENCE_URL: url,
      },
    });
    expect(installed).toContain('\r\n    "effortLevel"');
    expect(configureClaudeDesktopMod(installed, pluginDir, url, ';')).toBe(installed);
    // Windows paths match without regard to case or a trailing separator.
    expect(configureClaudeDesktopMod(installed, pluginDir.toLowerCase() + '\\', url, ';')).toBe(
      installed,
    );
    expect(JSON.parse(configureClaudeDesktopMod(installed, pluginDir, null, ';'))).toEqual(
      original,
    );
  });

  it('removes the env block it created and leaves unrelated files unchanged', () => {
    const installed = configureClaudeDesktopMod('{"theme":"dark"}', pluginDir, url, ';');
    expect(JSON.parse(installed)).toEqual({
      theme: 'dark',
      env: { CLAUDE_CODE_PLUGIN_DIRS: pluginDir, CONGRUENCE_URL: url },
    });
    expect(JSON.parse(configureClaudeDesktopMod(installed, pluginDir, null, ';'))).toEqual({
      theme: 'dark',
    });
    const unrelated = '{\n  "env": { "DEBUG": "1" }\n}\n';
    expect(configureClaudeDesktopMod(unrelated, pluginDir, null, ';')).toBe(unrelated);
  });

  it('creates a missing file, reports the installation, and removes it again', async () => {
    const directory = await temporary();
    const path = join(directory, 'settings.json');
    await removeClaudeDesktopMod(path, pluginDir);
    expect(await readdir(directory)).toEqual([]);
    expect(await claudeDesktopModInstalled(path, pluginDir, url)).toBe(false);
    await installClaudeDesktopMod(path, pluginDir, url);
    expect(await claudeDesktopModInstalled(path, pluginDir, url)).toBe(true);
    // A server on another port needs the mod installed again with its own URL.
    expect(await claudeDesktopModInstalled(path, pluginDir, 'http://127.0.0.1:4999')).toBe(false);
    await removeClaudeDesktopMod(path, pluginDir);
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({});
  });

  it.each(['{bad', '[]', 'null', '{"env":[]}', '{"env":{"CLAUDE_CODE_PLUGIN_DIRS":1}}'])(
    'refuses malformed settings without changing the file: %s',
    async (source) => {
      const directory = await temporary();
      const path = join(directory, 'settings.json');
      await writeFile(path, source);
      await expect(installClaudeDesktopMod(path, pluginDir, url)).rejects.toThrow();
      await expect(removeClaudeDesktopMod(path, pluginDir)).rejects.toThrow();
      expect(await readFile(path, 'utf8')).toBe(source);
      expect(await claudeDesktopModInstalled(path, pluginDir, url)).toBe(false);
    },
  );

  it('installs from the same-origin UI only, with the mod folder of this checkout', async () => {
    const directory = await temporary();
    const path = join(directory, 'settings.json');
    const app = await buildApp({
      dataDir: join(directory, 'data'),
      claudeSettingsPath: path,
      serveWeb: false,
      mcp: false,
      desktopAdapter: false,
    });
    cleanups.push(() => app.close());
    const route = '/api/agent-settings/claude-desktop-mod';
    const headers = { host: 'localhost:4310', origin: 'http://localhost:4310' };
    const initial = (await app.inject({ url: route, headers })).json();
    expect(initial).toEqual({
      settingsPath: path,
      pluginDir: fileURLToPath(new URL('../../../../claude-mod', import.meta.url)),
      url: 'http://localhost:4310',
      installed: false,
      connectedSessions: 0,
    });
    for (const method of ['POST', 'DELETE'] as const) {
      for (const origin of [undefined, 'http://localhost:4321', 'https://remote.example']) {
        const response = await app.inject({
          method,
          url: route,
          headers: { host: headers.host, ...(origin ? { origin } : {}) },
        });
        expect(response.statusCode).toBe(403);
      }
      const response = await app.inject({ method, url: route, headers });
      expect(response.statusCode).toBe(200);
      expect(response.json().installed).toBe(method === 'POST');
    }
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({});
  });
});
