import { homedir } from 'node:os';
import { join } from 'node:path';
import { StoreError } from '../../storage/store.js';
import { updateMcpConfig } from './mcp-setup.js';

export function claudeDesktopConfigPath() {
  return join(homedir(), '.claude.json');
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function configureClaudeDesktopMcp(source: string, endpoint: string | null): string {
  const config: unknown = source ? JSON.parse(source) : {};
  if (!isObject(config) || (config.mcpServers !== undefined && !isObject(config.mcpServers)))
    throw new StoreError(
      'Claude Code Desktop configuration must contain a JSON object with an mcpServers object. Edit the file manually to fix it.',
      409,
    );
  const servers = (config.mcpServers ?? {}) as Record<string, unknown>;
  if (endpoint === null) {
    if (!Object.hasOwn(servers, 'congruence')) return source;
    delete servers.congruence;
  } else {
    const existing = servers.congruence;
    servers.congruence = {
      ...(isObject(existing) && existing.type === 'http' ? existing : {}),
      type: 'http',
      url: endpoint,
    };
    config.mcpServers = servers;
  }
  const indent = source.match(/\n([\t ]+)"/)?.[1] ?? '  ';
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  return JSON.stringify(config, null, indent).replace(/\n/g, newline) + newline;
}

export function installClaudeDesktopMcp(path: string, endpoint: string) {
  return updateMcpConfig(
    path,
    (source) => configureClaudeDesktopMcp(source, endpoint),
    'Claude Code Desktop',
    'JSON',
  );
}

export function removeClaudeDesktopMcp(path: string) {
  return updateMcpConfig(
    path,
    (source) => configureClaudeDesktopMcp(source, null),
    'Claude Code Desktop',
    'JSON',
  );
}
