import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { getStaticTOMLValue, parseTOML, type AST } from 'toml-eslint-parser';
import { StoreError } from '../../storage/store.js';

export function codexConfigPath(home = process.env.CODEX_HOME || join(homedir(), '.codex')) {
  return resolve(home, 'config.toml');
}

export function configureCodexMcp(source: string, endpoint: string): string {
  const ast = parseTOML(source, { tomlVersion: '1.0' });
  const config = getStaticTOMLValue(ast);
  const servers = config.mcp_servers;
  const existing =
    servers && typeof servers === 'object' && !Array.isArray(servers) && !(servers instanceof Date)
      ? servers.congruence
      : undefined;
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const table = ast.body[0].body.find(
    (node) =>
      node.type === 'TOMLTable' &&
      node.kind === 'standard' &&
      JSON.stringify(node.resolvedKey) === JSON.stringify(['mcp_servers', 'congruence']),
  );
  if (!table || table.type !== 'TOMLTable') {
    if (existing !== undefined)
      throw new StoreError(
        'The Congruence entry uses an unsupported TOML layout. Use manual setup to update it.',
        409,
      );
    const next =
      source +
      (source && !source.endsWith('\n') ? newline : '') +
      `${newline}[mcp_servers.congruence]${newline}enabled = true${newline}url = ${JSON.stringify(endpoint)}${newline}`;
    parseTOML(next, { tomlVersion: '1.0' });
    return next;
  }
  if (table.body.some((entry) => getStaticTOMLValue(entry.key)[0] === 'command'))
    throw new StoreError(
      'Congruence is configured as a command server. Use manual setup to replace it with an HTTP server.',
      409,
    );
  return updateTable(source, table, { url: JSON.stringify(endpoint), enabled: 'true' });
}

function updateTable(source: string, table: AST.TOMLTable, fields: Record<string, string>) {
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const edits: { start: number; end: number; text: string }[] = [];
  const missing: string[] = [];
  for (const [key, value] of Object.entries(fields)) {
    const entry = table.body.find((entry) => {
      const keys = getStaticTOMLValue(entry.key);
      return keys.length === 1 && keys[0] === key;
    });
    if (entry) edits.push({ start: entry.value.range[0], end: entry.value.range[1], text: value });
    else missing.push(`${key} = ${value}`);
  }
  if (missing.length) {
    const last = table.body.at(-1) ?? table.key;
    const endOfLine = source.indexOf('\n', last.range[1]);
    const position = endOfLine === -1 ? source.length : endOfLine + 1;
    edits.push({
      start: position,
      end: position,
      text: (endOfLine === -1 ? newline : '') + missing.join(newline) + newline,
    });
  }
  let next = source;
  for (const edit of edits.sort((a, b) => b.start - a.start))
    next = next.slice(0, edit.start) + edit.text + next.slice(edit.end);
  parseTOML(next, { tomlVersion: '1.0' });
  return next;
}

async function readConfig(path: string) {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export function removeCodexMcpConfig(source: string): string {
  const ast = parseTOML(source, { tomlVersion: '1.0' });
  let next = source;
  const tables = ast.body[0].body.filter(
    (node) =>
      node.type === 'TOMLTable' &&
      node.resolvedKey[0] === 'mcp_servers' &&
      node.resolvedKey[1] === 'congruence',
  );
  for (const table of tables.reverse()) {
    const start = source.lastIndexOf('\n', table.range[0] - 1) + 1;
    const lineEnd = source.indexOf('\n', table.range[1]);
    const end = lineEnd === -1 ? source.length : lineEnd + 1;
    next = next.slice(0, start) + next.slice(end);
  }
  const remaining = getStaticTOMLValue(parseTOML(next, { tomlVersion: '1.0' })).mcp_servers;
  if (remaining && typeof remaining === 'object' && 'congruence' in remaining)
    throw new StoreError(
      'The Congruence entry uses an unsupported TOML layout. Edit the config file manually to remove it.',
      409,
    );
  return next;
}

export function installCodexMcp(path: string, endpoint: string) {
  return updateMcpConfig(path, (source) => configureCodexMcp(source, endpoint), 'Codex', 'TOML');
}

export function removeCodexMcp(path: string) {
  return updateMcpConfig(path, removeCodexMcpConfig, 'Codex', 'TOML');
}

async function resolveConfigFile(path: string, client: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    try {
      if ((await lstat(path)).isSymbolicLink())
        throw new StoreError(
          `${client} configuration points to a missing file. Repair the symbolic link before saving.`,
          409,
        );
    } catch (linkError) {
      if ((linkError as NodeJS.ErrnoException).code !== 'ENOENT') throw linkError;
    }
    return resolve(path);
  }
}

// Serialize dashboard writes and replace the file only after parsing the complete result.
let writes: Promise<unknown> = Promise.resolve();
export function updateMcpConfig(
  path: string,
  transform: (source: string) => string,
  client: string,
  format: string,
) {
  const operation = writes.then(async () => {
    let temporary: string | undefined;
    try {
      // Resolve links so replacing the file preserves a user's linked config location.
      const destination = await resolveConfigFile(path, client);
      const original = await readConfig(destination);
      let updated: string;
      try {
        updated = transform(original ?? '');
      } catch (error) {
        if (error instanceof StoreError) throw error;
        throw new StoreError(
          `${client} configuration could not be updated. Check the ${format} file or edit it manually.`,
          409,
        );
      }
      if (updated === (original ?? '')) return;
      await mkdir(dirname(destination), { recursive: true });
      temporary = `${destination}.${randomUUID()}.tmp`;
      const mode = original === null ? 0o600 : (await stat(destination)).mode;
      await writeFile(temporary, updated, { flag: 'wx', mode });
      if (
        (await resolveConfigFile(path, client)) !== destination ||
        (await readConfig(destination)) !== original
      )
        throw new StoreError(`${client} configuration changed while saving. Try again.`, 409);
      await rename(temporary, destination);
    } catch (error) {
      if (error instanceof StoreError) throw error;
      throw new StoreError(
        `Cannot write the ${client} configuration file. Check file permissions or edit it manually.`,
        409,
      );
    } finally {
      if (temporary) await rm(temporary, { force: true });
    }
  });
  writes = operation.catch(() => {});
  return operation;
}
