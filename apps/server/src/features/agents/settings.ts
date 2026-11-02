import { access, readFile, readdir, writeFile, rename, stat } from 'node:fs/promises';
import { join } from 'node:path';
import Schema from 'typebox/schema';
import Type from 'typebox';
import {
  AgentSettingsSchema,
  AgentSettingsRequestSchema,
  ProposeAgentSettingsSchema,
  ReapplyAgentSettingsSchema,
  type AgentSettings,
  type AgentSettingsRequest,
  type ProposeAgentSettings,
  type ReapplyAgentSettings,
} from '@congruence/contracts';
import { StoreError } from '../../storage/store.js';

const validator = Schema.Compile(AgentSettingsSchema);
const proposalValidator = Schema.Compile(ProposeAgentSettingsSchema);
const reapplyValidator = Schema.Compile(ReapplyAgentSettingsSchema);
const diskValidator = Schema.Compile(
  Type.Object(
    {
      ...AgentSettingsSchema.properties,
      requests: Type.Optional(Type.Array(AgentSettingsRequestSchema)),
    },
    { additionalProperties: false },
  ),
);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

// Files written before the Claude Code CLI setup was removed still hold its setting and requests.
function withoutClaudeSettings(saved: unknown): unknown {
  if (!isRecord(saved)) return saved;
  const { claudeCommand: _command, ...rest } = saved;
  if (!Array.isArray(rest.requests)) return rest;
  return {
    ...rest,
    requests: rest.requests.flatMap((request: unknown) => {
      if (!isRecord(request) || !isRecord(request.changes) || !isRecord(request.baseSettings))
        return [request];
      const { claudeCommand: _change, ...changes } = request.changes;
      const { claudeCommand: _base, ...baseSettings } = request.baseSettings;
      return String(request.host).startsWith('claude') || !Object.keys(changes).length
        ? []
        : [{ ...request, changes, baseSettings }];
    }),
  };
}

function normalizeSettings(input: AgentSettings): AgentSettings {
  if (!validator.Check(input)) throw new StoreError('Invalid agent settings.', 400);
  const settings = Object.fromEntries(
    Object.entries(input).map(([key, value]) => [key, value.trim()]),
  ) as AgentSettings;
  try {
    const url = new URL(settings.codexUrl);
    if (
      url.protocol !== 'ws:' ||
      !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
      url.username ||
      url.password
    )
      throw new Error('Invalid URL');
  } catch {
    throw new StoreError('Shared server URL must be a local ws:// address.', 400);
  }
  return settings;
}
async function defaultCodexCommand() {
  if (process.env.CONGRUENCE_CODEX_COMMAND) return process.env.CONGRUENCE_CODEX_COMMAND;
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    const root = join(process.env.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin');
    try {
      const entries = await readdir(root, { withFileTypes: true });
      const candidates = await Promise.all(
        entries
          .filter((entry) => entry.isDirectory())
          .map(async (entry) => {
            const command = join(root, entry.name, 'codex.exe');
            try {
              await access(command);
              return { command, modified: (await stat(command)).mtimeMs };
            } catch {
              return undefined;
            }
          }),
      );
      const latest = candidates
        .filter((candidate) => candidate !== undefined)
        .sort((a, b) => b.modified - a.modified)[0];
      if (latest) return latest.command;
    } catch {
      /* Fall back to PATH when Desktop is not installed here. */
    }
  }
  return 'codex';
}
export async function createAgentSettings(dataDir: string) {
  const file = join(dataDir, 'agent-settings.json');
  let state: { settings: AgentSettings; requests: AgentSettingsRequest[] } = {
    settings: {
      codexCommand: await defaultCodexCommand(),
      codexUrl: process.env.CONGRUENCE_CODEX_URL ?? 'ws://127.0.0.1:4500',
      codexSocket: process.env.CONGRUENCE_CODEX_SOCKET ?? '',
    },
    requests: [],
  };
  try {
    const migrated = withoutClaudeSettings(JSON.parse(await readFile(file, 'utf8')));
    if (!diskValidator.Check(migrated)) throw new Error('Invalid agent settings.');
    const { requests = [], ...settings } = migrated;
    if (new Set(requests.map((request) => request.id)).size !== requests.length)
      throw new Error('Duplicate settings request IDs.');
    state = { settings: normalizeSettings(settings), requests };
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  }
  let pending: Promise<unknown> = Promise.resolve();
  const listeners = new Set<(settingsChanged: boolean) => void>();
  function mutate<T>(
    operation: (draft: typeof state) => { result: T; write: boolean },
  ): Promise<T> {
    const work = pending.then(async () => {
      const draft = structuredClone(state);
      const { result, write } = operation(draft);
      if (!write) return structuredClone(result);
      // Settings and the decision receipt commit together, so a restart cannot partially approve.
      await writeFile(
        `${file}.tmp`,
        JSON.stringify({ ...draft.settings, requests: draft.requests }, null, 2) + '\n',
        'utf8',
      );
      await rename(`${file}.tmp`, file);
      const changed = JSON.stringify(state.settings) !== JSON.stringify(draft.settings);
      state = draft;
      for (const listener of listeners) listener(changed);
      return structuredClone(result);
    });
    pending = work.catch(() => undefined);
    return work;
  }
  return {
    get: () => ({ ...state.settings }),
    review: () => structuredClone(state),
    subscribe(listener: (settingsChanged: boolean) => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async flush() {
      await pending;
    },
    async save(input: AgentSettings) {
      const settings = normalizeSettings(input);
      return mutate((draft) => {
        draft.settings = settings;
        return { result: settings, write: true };
      });
    },
    async propose(input: ProposeAgentSettings) {
      if (!proposalValidator.Check(input)) throw new StoreError('Invalid settings proposal.', 400);
      const keys = Object.keys(input.changes).sort() as Array<keyof AgentSettings>;
      const proposal = {
        id: input.id,
        workspaceId: input.workspaceId,
        host: input.host,
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        reason: input.reason.trim(),
        evidence: input.evidence.trim(),
        changes: Object.fromEntries(keys.map((key) => [key, input.changes[key]!.trim()])),
      };
      return mutate((draft) => {
        const existing = draft.requests.find((request) => request.id === input.id);
        if (existing) {
          const {
            baseSettings: _base,
            status: _status,
            createdAt: _created,
            decidedAt: _decided,
            ...original
          } = existing;
          if (JSON.stringify(original) !== JSON.stringify(proposal))
            throw new StoreError('This request ID was already used for another proposal.', 409);
          return { result: existing, write: false };
        }
        normalizeSettings({ ...draft.settings, ...proposal.changes });
        if (keys.every((key) => draft.settings[key] === proposal.changes[key]))
          throw new StoreError(
            'These settings are already configured. No approval is needed.',
            409,
          );
        if (draft.requests.filter((request) => request.status === 'pending').length >= 100)
          throw new StoreError('Review the pending settings requests before proposing more.', 409);
        const request: AgentSettingsRequest = {
          ...proposal,
          baseSettings: { ...draft.settings },
          status: 'pending',
          createdAt: new Date().toISOString(),
        };
        draft.requests.push(request);
        return { result: request, write: true };
      });
    },
    async decide(id: string, decision: 'approve' | 'reject') {
      return mutate((draft) => {
        const request = draft.requests.find((entry) => entry.id === id);
        if (!request) throw new StoreError('Settings request not found.', 404);
        const status = decision === 'approve' ? 'approved' : 'rejected';
        if (request.status === status) return { result: request, write: false };
        if (request.status !== 'pending')
          throw new StoreError('This request has already been reviewed.', 409);
        if (decision === 'approve') {
          const keys = Object.keys(request.changes) as Array<keyof AgentSettings>;
          if (keys.some((key) => draft.settings[key] !== request.baseSettings[key]))
            throw new StoreError(
              'Settings changed since this request was proposed. Reject it and ask the agent for a new proposal.',
              409,
            );
          draft.settings = normalizeSettings({ ...draft.settings, ...request.changes });
        }
        request.status = status;
        request.decidedAt = new Date().toISOString();
        return { result: request, write: true };
      });
    },
    async reapply(id: string, input: ReapplyAgentSettings) {
      if (!reapplyValidator.Check(input)) throw new StoreError('Invalid reapply request.', 400);
      const expected = normalizeSettings(input.expectedSettings);
      return mutate((draft) => {
        const existing = draft.requests.find((request) => request.id === input.id);
        if (existing) {
          if (
            existing.reappliedFrom !== id ||
            (Object.keys(existing.changes) as Array<keyof AgentSettings>).some(
              (key) => existing.baseSettings[key] !== expected[key],
            )
          )
            throw new StoreError('This request ID was already used for another action.', 409);
          return { result: existing, write: false };
        }
        const original = draft.requests.find((request) => request.id === id);
        if (!original) throw new StoreError('Settings request not found.', 404);
        if (original.status === 'pending')
          throw new StoreError('Review this pending request before reapplying it.', 409);
        const keys = Object.keys(original.changes) as Array<keyof AgentSettings>;
        if (keys.some((key) => draft.settings[key] !== expected[key]))
          throw new StoreError('Settings changed. Review the current values and try again.', 409);
        if (keys.every((key) => draft.settings[key] === original.changes[key]))
          throw new StoreError('These settings are already in use.', 409);
        const settings = normalizeSettings({ ...draft.settings, ...original.changes });
        const now = new Date().toISOString();
        const request: AgentSettingsRequest = {
          ...original,
          id: input.id,
          reappliedFrom: id,
          baseSettings: { ...draft.settings },
          status: 'approved',
          createdAt: now,
          decidedAt: now,
        };
        draft.settings = settings;
        draft.requests.push(request);
        return { result: request, write: true };
      });
    },
    async removeRequest(id: string) {
      return mutate((draft) => {
        const request = draft.requests.find((entry) => entry.id === id);
        if (!request) return { result: { ok: true }, write: false };
        if (request.status === 'pending')
          throw new StoreError('Reject this pending request before deleting it.', 409);
        draft.requests = draft.requests.filter((entry) => entry.id !== id);
        return { result: { ok: true }, write: true };
      });
    },
  };
}
export type AgentSettingsStore = Awaited<ReturnType<typeof createAgentSettings>>;
