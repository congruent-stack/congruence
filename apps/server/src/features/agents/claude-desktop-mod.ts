import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { StoreError } from '../../storage/store.js';
import { pathKey } from './desktop.js';
import { updateMcpConfig } from './mcp-setup.js';

// Claude Code reads CLAUDE_CODE_PLUGIN_DIRS from the env block of the user settings file. Claude
// Desktop has no --plugin-dir flag, so this is how its local sessions load the Congruence mod.
export function claudeSettingsPath(
  configDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'),
) {
  return resolve(configDir, 'settings.json');
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseSettings(source: string) {
  const config: unknown = source.trim() ? JSON.parse(source) : {};
  if (
    !isObject(config) ||
    (config.env !== undefined && !isObject(config.env)) ||
    (isObject(config.env) &&
      config.env.CLAUDE_CODE_PLUGIN_DIRS !== undefined &&
      typeof config.env.CLAUDE_CODE_PLUGIN_DIRS !== 'string')
  )
    throw new StoreError(
      'Claude Code settings must contain a JSON object with an env object. Edit the file manually to fix it.',
      409,
    );
  return config as Record<string, unknown> & { env?: Record<string, unknown> };
}

function pluginDirs(env: Record<string, unknown> | undefined, separator: string) {
  const value = env?.CLAUDE_CODE_PLUGIN_DIRS;
  return typeof value === 'string' ? value.split(separator).filter((dir) => dir.trim()) : [];
}

export function configureClaudeDesktopMod(
  source: string,
  pluginDir: string,
  url: string | null,
  separator = delimiter,
): string {
  const config = parseSettings(source);
  const env = { ...config.env };
  const dirs = pluginDirs(env, separator);
  const listed = dirs.some((dir) => pathKey(dir) === pathKey(pluginDir));
  if (url === null) {
    const others = dirs.filter((dir) => pathKey(dir) !== pathKey(pluginDir));
    if (others.length) env.CLAUDE_CODE_PLUGIN_DIRS = others.join(separator);
    else delete env.CLAUDE_CODE_PLUGIN_DIRS;
    delete env.CONGRUENCE_URL;
  } else {
    env.CLAUDE_CODE_PLUGIN_DIRS = (listed ? dirs : [...dirs, pluginDir]).join(separator);
    env.CONGRUENCE_URL = url;
  }
  if (Object.keys(env).length) config.env = env;
  else delete config.env;
  if (JSON.stringify(config) === JSON.stringify(parseSettings(source))) return source;
  const indent = source.match(/\n([\t ]+)"/)?.[1] ?? '  ';
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  return JSON.stringify(config, null, indent).replace(/\n/g, newline) + newline;
}

export async function claudeDesktopModInstalled(
  path: string,
  pluginDir: string,
  url: string,
  separator = delimiter,
) {
  try {
    const { env } = parseSettings(await readFile(path, 'utf8'));
    return (
      env?.CONGRUENCE_URL === url &&
      pluginDirs(env, separator).some((dir) => pathKey(dir) === pathKey(pluginDir))
    );
  } catch {
    return false;
  }
}

export function installClaudeDesktopMod(path: string, pluginDir: string, url: string) {
  return updateMcpConfig(
    path,
    (source) => configureClaudeDesktopMod(source, pluginDir, url),
    'Claude Code',
    'JSON',
  );
}

export function removeClaudeDesktopMod(path: string, pluginDir: string) {
  return updateMcpConfig(
    path,
    (source) => configureClaudeDesktopMod(source, pluginDir, null),
    'Claude Code',
    'JSON',
  );
}
