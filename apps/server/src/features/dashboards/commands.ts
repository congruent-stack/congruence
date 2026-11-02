import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { isAbsolute, join, win32 } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import Type from 'typebox';
import Schema from 'typebox/schema';
import {
  AgentTargetSchema,
  DashboardClaimSchema,
  DashboardExecuteSchema,
  DashboardPreviewInputSchema,
  DashboardPreviewSchema,
  DashboardRunSchema,
  DesktopSessionSchema,
  type Activity,
  type AgentMessage,
  type AgentTarget,
  type DashboardClaim,
  type DashboardDestination,
  type DashboardExecute,
  type DashboardPreview,
  type DashboardPreviewInput,
  type DashboardRun,
  type DesktopSession,
} from '@congruence/contracts';
import { StoreError, type Store } from '../../storage/store.js';
import type { AgentService } from '../agents/service.js';
import type { DashboardRuntime } from './runtime.js';

const SavedPreviewSchema = Type.Object({
  preview: DashboardPreviewSchema,
  target: Type.Optional(AgentTargetSchema),
});
const SavedRunSchema = Type.Object({
  run: DashboardRunSchema,
  target: Type.Optional(AgentTargetSchema),
  claim: Type.Optional(DashboardClaimSchema),
});
const StateSchema = Type.Object(
  {
    version: Type.Literal(1),
    previews: Type.Array(SavedPreviewSchema),
    runs: Type.Array(SavedRunSchema),
  },
  { additionalProperties: false },
);
type State = Type.Static<typeof StateSchema>;
type SavedRun = State['runs'][number];
const stateValidator = Schema.Compile(StateSchema);
const previewValidator = Schema.Compile(DashboardPreviewInputSchema);
const executeValidator = Schema.Compile(DashboardExecuteSchema);
const claimValidator = Schema.Compile(DashboardClaimSchema);
const desktopValidator = Schema.Compile(DesktopSessionSchema);

function copyJson<T>(value: T): T {
  try {
    const copy = JSON.parse(JSON.stringify(value));
    if (!isDeepStrictEqual(copy, value)) throw new Error('Not JSON');
    return copy;
  } catch {
    throw new StoreError('Command data must contain only JSON values.', 400);
  }
}
function commandInput(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new StoreError('Command input must be a JSON object.', 400);
  return copyJson(value as Record<string, unknown>);
}
function activityTarget(item: Activity): AgentTarget {
  if (item.agentTarget) return structuredClone(item.agentTarget);
  if (item.desktopSession)
    return {
      provider: item.desktopSession.provider === 'claude' ? 'claude-desktop' : 'codex-desktop',
      sessionId: item.desktopSession.sessionId,
    };
  throw new StoreError('The selected activity has no linked agent chat.', 409);
}
function desktopSession(input: DashboardClaim): DesktopSession {
  const session = {
    provider:
      input.provider === 'claude-desktop' ? ('claude' as const) : ('codex-desktop' as const),
    sessionId: input.sessionId,
  };
  if (!desktopValidator.Check(session))
    throw new StoreError('Use the actual native Desktop session ID.', 400);
  return session;
}
function destinationValue(value?: DashboardDestination): DashboardDestination | undefined {
  if (!value) return undefined;
  if (value.kind === 'activity') return structuredClone(value);
  const folder = value.folder.trim();
  if (
    /[\x00-\x1f\x7f]/.test(folder) ||
    (folder && !isAbsolute(folder) && !win32.isAbsolute(folder)) ||
    /^[A-Za-z]:[^\\/]/.test(folder)
  )
    throw new StoreError('The Desktop folder must be an absolute path or blank.', 400);
  const title = value.title.trim();
  if (!title || title.length > 120)
    throw new StoreError('Use an activity title between 1 and 120 characters.', 400);
  return { ...value, folder, title };
}
function claimInstruction(
  id: string,
  workspaceId: string,
  destination: Extract<DashboardDestination, { kind: 'desktop' }>,
) {
  const variable =
    destination.provider === 'codex-desktop' ? 'CODEX_THREAD_ID' : 'CLAUDE_CODE_HOST_SESSION_ID';
  return [
    '',
    `[Congruence dashboard run ${id}]`,
    `This new chat was prepared for the activity "${destination.title}".`,
    `After the human submits this prompt, read your actual native session ID from ${variable} in your tool environment.`,
    'Use the Congruence MCP tool link_dashboard_session with these values and that actual sessionId:',
    JSON.stringify({ workspaceId, runId: id, provider: destination.provider }),
    'Do not invent a session ID. If it is unavailable, explain that the activity could not be linked.',
    'This links the requested activity only. It does not enable ongoing activity reporting; report updates only if the human explicitly requests it.',
  ].join('\n');
}
function launchUrl(
  destination: Extract<DashboardDestination, { kind: 'desktop' }>,
  prompt: string,
) {
  const codex = destination.provider === 'codex-desktop';
  const url = new URL(codex ? 'codex://threads/new' : 'claude://code/new');
  if (destination.folder) url.searchParams.set(codex ? 'path' : 'folder', destination.folder);
  url.searchParams.set(codex ? 'prompt' : 'q', prompt);
  return url.href;
}
function messageUpdate(message: AgentMessage): Pick<DashboardRun, 'status' | 'detail' | 'result'> {
  const status = {
    sending: 'queued',
    queued: 'queued',
    accepted: 'running',
    replied: 'succeeded',
    failed: 'failed',
    unknown: 'interrupted',
  } as const;
  return {
    status: status[message.status],
    detail: message.detail,
    result: {
      messageId: message.shortId,
      deliveryStatus: message.status,
      ...(message.reply !== undefined ? { reply: message.reply } : {}),
    },
  };
}

export async function createDashboardCommands(
  dataDir: string,
  store: Store,
  agents: AgentService,
  runtime: DashboardRuntime,
) {
  await mkdir(dataDir, { recursive: true });
  const file = join(dataDir, 'dashboard-commands.json');
  let state: State = { version: 1, previews: [], runs: [] };
  try {
    const saved: unknown = JSON.parse(await readFile(file, 'utf8'));
    if (!stateValidator.Check(saved)) throw new Error('Invalid command history');
    if (
      new Set(saved.previews.map(({ preview }) => preview.id)).size !== saved.previews.length ||
      new Set(saved.runs.map(({ run }) => run.id)).size !== saved.runs.length
    )
      throw new Error('Duplicate command identifiers');
    state = saved;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      throw new Error('Invalid dashboard command history. Original file has been preserved.', {
        cause: error,
      });
  }
  let pending: Promise<unknown> = Promise.resolve();
  let closing = false;
  let closed = false;
  const jobs = new Map<string, Promise<void>>();
  function assertOpen() {
    if (closing) throw new StoreError('Dashboard commands are shutting down.', 503);
  }
  function mutate<T>(change: (draft: State) => T | Promise<T>): Promise<T> {
    const operation = pending.then(async () => {
      const draft = structuredClone(state);
      const result = await change(draft);
      if (!isDeepStrictEqual(state, draft)) {
        const temporary = join(dataDir, `.dashboard-commands-${randomUUID()}.tmp`);
        try {
          await writeFile(temporary, JSON.stringify(draft, null, 2), 'utf8');
          await rename(temporary, file);
          state = draft;
        } finally {
          await unlink(temporary).catch(() => {});
        }
      }
      return structuredClone(result);
    });
    pending = operation.catch(() => {});
    return operation;
  }
  await mutate((draft) => {
    for (const { run } of draft.runs)
      if (run.status === 'running') {
        run.status = 'interrupted';
        run.detail =
          'The server stopped before completion was confirmed. This command was not replayed.';
        run.updatedAt = new Date().toISOString();
      }
  });
  async function current(workspaceId: string, id: string, version?: string) {
    const workspace = await store.getWorkspace(workspaceId);
    const dashboard = await runtime.get(workspace.id, id);
    if (version !== undefined && (dashboard.version !== version || dashboard.status === 'draft'))
      throw new StoreError(
        'The dashboard changed. Review the command again before running it.',
        409,
      );
    return { workspace, dashboard };
  }
  async function update(id: string, values: Partial<DashboardRun>) {
    if (closed) return;
    await mutate((draft) => {
      const saved = draft.runs.find(({ run }) => run.id === id);
      if (saved) Object.assign(saved.run, values, { updatedAt: new Date().toISOString() });
    });
  }
  function start(saved: SavedRun) {
    const { run, target } = structuredClone(saved);
    const job = (async () => {
      let outcome: Partial<DashboardRun>;
      try {
        if (run.command.type === 'backend') {
          const result = await runtime.execute(
            run.workspaceId,
            run.dashboardId,
            run.version,
            run.command.id,
            structuredClone(run.input),
          );
          outcome = {
            status: 'succeeded',
            detail: 'Command completed.',
            ...(result === undefined ? {} : { result: copyJson(result) }),
          };
        } else if (run.destination?.kind === 'activity' && target) {
          const message = await agents.send(run.workspaceId, run.destination.activityId, {
            id: run.id,
            text: run.prompt!,
            target,
          });
          outcome = messageUpdate(message);
        } else return;
      } catch (error) {
        outcome = {
          status: 'failed',
          detail: error instanceof Error ? error.message : 'Command failed.',
        };
      }
      try {
        await update(run.id, outcome);
      } catch {
        // An action can already have taken effect when saving its receipt fails.
        // Never turn that storage error into an apparent execution failure or replay it.
        await update(run.id, {
          status: 'interrupted',
          detail:
            outcome.status === 'succeeded'
              ? 'The command completed, but its result could not be saved. Check its effects before starting another command. This command was not replayed.'
              : 'The command outcome could not be saved. Check its effects before starting another command. This command was not replayed.',
        });
      }
    })();
    jobs.set(run.id, job);
    void job.finally(() => jobs.delete(run.id)).catch(() => {});
  }

  return {
    async preview(
      workspaceId: string,
      id: string,
      input: DashboardPreviewInput,
    ): Promise<DashboardPreview> {
      assertOpen();
      if (!previewValidator.Check(input)) throw new StoreError('Invalid command preview.', 400);
      const { workspace, dashboard } = await current(workspaceId, id, input.version);
      const command = dashboard.commands.find((command) => command.id === input.commandId);
      if (!command) throw new StoreError('Dashboard command not found.', 404);
      const destination = destinationValue(input.destination);
      if (command.type === 'backend' && destination)
        throw new StoreError('Backend commands do not have an agent destination.', 400);
      const target =
        destination?.kind === 'activity'
          ? activityTarget(await store.getActivity(workspace.id, destination.activityId))
          : undefined;
      const prepared = await runtime.prepare(
        workspace.id,
        id,
        input.version,
        command.id,
        commandInput(input.input),
        input.prompt,
      );
      const frozen = commandInput(prepared.input);
      const previewId = randomUUID();
      let prompt = prepared.prompt ?? input.prompt;
      if (prompt !== undefined && typeof prompt !== 'string')
        throw new StoreError('The prepared command prompt must be text.', 400);
      if (command.type === 'agent') {
        prompt = prompt?.trim();
        if (!prompt) throw new StoreError('An agent command must prepare a prompt.', 400);
        if (Object.keys(frozen).length)
          prompt += `\n\nCommand inputs:\n${JSON.stringify(frozen, null, 2)}`;
        if (destination?.kind === 'desktop')
          prompt += '\n' + claimInstruction(previewId, workspace.shortId, destination);
        const limit =
          destination?.kind === 'desktop' && destination.provider === 'claude-desktop'
            ? 14336
            : 10000;
        if (prompt.length > limit)
          throw new StoreError(`The complete reviewed prompt exceeds ${limit} characters.`, 400);
      }
      if (prepared.summary !== undefined && typeof prepared.summary !== 'string')
        throw new StoreError('The command preview summary must be text.', 400);
      const preview: DashboardPreview = {
        id: previewId,
        workspaceId: workspace.id,
        dashboardId: id,
        version: input.version,
        command: structuredClone(command),
        input: frozen,
        ...(prompt !== undefined ? { prompt } : {}),
        ...(destination ? { destination } : {}),
        summary: prepared.summary ?? command.label,
        createdAt: new Date().toISOString(),
      };
      // Preparation can involve remote reads; a concurrent publish invalidates this preview.
      await current(workspace.id, id, input.version);
      assertOpen();
      await mutate((draft) => draft.previews.push({ preview, ...(target ? { target } : {}) }));
      return structuredClone(preview);
    },
    async execute(workspaceId: string, id: string, input: DashboardExecute): Promise<DashboardRun> {
      assertOpen();
      if (!executeValidator.Check(input)) throw new StoreError('Invalid command execution.', 400);
      const { workspace } = await current(workspaceId, id);
      let created: SavedRun | undefined;
      const result = await mutate(async (draft) => {
        assertOpen();
        const saved = draft.previews.find(({ preview }) => preview.id === input.previewId);
        if (
          !saved ||
          saved.preview.workspaceId !== workspace.id ||
          saved.preview.dashboardId !== id
        )
          throw new StoreError('Command preview not found in this dashboard.', 404);
        const { preview, target } = saved;
        if (
          input.destination !== undefined &&
          !isDeepStrictEqual(destinationValue(input.destination), preview.destination)
        )
          throw new StoreError('The destination changed. Review the command again.', 409);
        const existing = draft.runs.find(({ run }) => run.id === preview.id);
        if (existing) return existing.run;
        await current(workspace.id, id, preview.version);
        if (preview.command.type === 'agent' && !preview.destination)
          throw new StoreError(
            'Choose a destination and review the command before running it.',
            409,
          );
        if (preview.destination?.kind === 'activity') {
          const item = await store.getActivity(workspace.id, preview.destination.activityId);
          if (!isDeepStrictEqual(activityTarget(item), target))
            throw new StoreError('The activity agent changed. Review the command again.', 409);
        }
        const now = new Date().toISOString();
        const desktop = preview.destination?.kind === 'desktop' ? preview.destination : undefined;
        const run: DashboardRun = {
          id: preview.id,
          workspaceId: workspace.id,
          dashboardId: id,
          version: preview.version,
          command: structuredClone(preview.command),
          input: structuredClone(preview.input),
          ...(preview.prompt !== undefined ? { prompt: preview.prompt } : {}),
          ...(preview.destination ? { destination: structuredClone(preview.destination) } : {}),
          ...(desktop ? { launchUrl: launchUrl(desktop, preview.prompt!) } : {}),
          ...(preview.destination?.kind === 'activity'
            ? { activityId: preview.destination.activityId }
            : {}),
          status: desktop ? 'prepared' : 'running',
          detail: desktop
            ? 'Ready to open in Desktop. Choose the model, effort and environment there, then submit the prompt. No chat has been created or linked yet.'
            : preview.command.type === 'backend'
              ? 'Command is running.'
              : 'Sending to the selected activity agent.',
          createdAt: now,
          updatedAt: now,
        };
        created = { run, ...(target ? { target: structuredClone(target) } : {}) };
        draft.runs.push(created);
        return run;
      });
      if (created && created.run.status === 'running') start(created);
      return result;
    },
    async list(workspaceId: string, id: string): Promise<DashboardRun[]> {
      const { workspace } = await current(workspaceId, id);
      await pending;
      const saved = state.runs.filter(
        ({ run }) => run.workspaceId === workspace.id && run.dashboardId === id,
      );
      const activityIds = new Set(
        saved.flatMap(({ run }) =>
          run.destination?.kind === 'activity' &&
          ['queued', 'running', 'interrupted'].includes(run.status)
            ? [run.destination.activityId]
            : [],
        ),
      );
      for (const activityId of activityIds) {
        const conversation = await agents.conversation(workspace.id, activityId);
        for (const message of conversation.messages) {
          const run = saved.find(({ run }) => run.id === message.id)?.run;
          if (!run || ['succeeded', 'failed', 'linked'].includes(run.status)) continue;
          const values = messageUpdate(message);
          if (
            run.status !== values.status ||
            run.detail !== values.detail ||
            !isDeepStrictEqual(run.result, values.result)
          )
            await update(run.id, values);
        }
      }
      await pending;
      return structuredClone(
        state.runs
          .filter(({ run }) => run.workspaceId === workspace.id && run.dashboardId === id)
          .map(({ run }) => run)
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id)),
      );
    },
    async claim(input: DashboardClaim): Promise<DashboardRun> {
      assertOpen();
      if (!claimValidator.Check(input)) throw new StoreError('Invalid dashboard run claim.', 400);
      const nativeSession = desktopSession(input);
      const workspace = await store.getWorkspace(input.workspaceId);
      const normalized = { ...input, workspaceId: workspace.id };
      const saved = await mutate((draft) => {
        const saved = draft.runs.find(
          ({ run }) => run.id === input.runId && run.workspaceId === workspace.id,
        );
        if (!saved) throw new StoreError('Dashboard run not found in this workspace.', 404);
        if (
          saved.run.destination?.kind !== 'desktop' ||
          saved.run.destination.provider !== input.provider
        )
          throw new StoreError('The session provider does not match the prepared command.', 409);
        if (saved.claim && !isDeepStrictEqual(saved.claim, normalized))
          throw new StoreError(
            'This dashboard run has already been claimed by another session.',
            409,
          );
        if (!['prepared', 'linked'].includes(saved.run.status))
          throw new StoreError('This dashboard run cannot be linked.', 409);
        saved.claim = normalized;
        return saved;
      });
      if (saved.run.status === 'linked') return saved.run;
      const destination = saved.run.destination! as Extract<
        DashboardDestination,
        { kind: 'desktop' }
      >;
      const activity = await store.publishActivity({
        workspaceId: workspace.id,
        requestId: saved.run.id,
        title: destination.title,
        subtitle: saved.run.command.label,
        summary:
          '- Dashboard command\n  - The requested Desktop chat has linked this activity.\n  - Ongoing activity reporting has not been enabled by this link.',
        status: 'in_progress',
        source: input.provider === 'codex-desktop' ? 'Codex' : 'Claude',
        desktopSession: nativeSession,
        agentTarget: { provider: input.provider, sessionId: input.sessionId },
      });
      if (!isDeepStrictEqual(activity.desktopSession, nativeSession))
        throw new StoreError('The activity is linked to a different native session.', 409);
      if (input.provider === 'claude-desktop')
        agents.noteClaudeDesktopReport(input.sessionId, workspace.id, activity.title);
      return mutate((draft) => {
        const saved = draft.runs.find(({ run }) => run.id === input.runId)!;
        saved.run.status = 'linked';
        saved.run.activityId = activity.id;
        saved.run.detail =
          'Linked to the actual Desktop chat. Ongoing activity reporting remains opt-in.';
        saved.run.updatedAt = new Date().toISOString();
        return saved.run;
      });
    },
    async close() {
      if (closed) return;
      closing = true;
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        Promise.allSettled([...jobs.values()]),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, 1000);
        }),
      ]);
      clearTimeout(timer);
      closed = true;
      await mutate((draft) => {
        for (const { run } of draft.runs)
          if (run.status === 'running') {
            run.status = 'interrupted';
            run.detail =
              'The server stopped before completion was confirmed. This command was not replayed.';
            run.updatedAt = new Date().toISOString();
          }
      });
      await pending;
    },
  };
}

export type DashboardCommands = Awaited<ReturnType<typeof createDashboardCommands>>;
