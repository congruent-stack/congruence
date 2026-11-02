import { randomInt, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import Type from 'typebox';
import Schema from 'typebox/schema';
import {
  ActivitySchema,
  AgentMessageSchema,
  AgentTargetSchema,
  SendAgentMessageSchema,
  PublishActivitySchema,
  WorkspaceInputSchema,
  WorkspaceSchema,
  type Activity,
  type AgentMessage,
  type AgentTarget,
  type SendAgentMessage,
  type DashboardChange,
  type PublishActivity,
  type Workspace,
  type WorkspaceInput,
} from '@congruence/contracts';

const StateSchema = Type.Object(
  {
    version: Type.Literal(3),
    workspaces: Type.Array(WorkspaceSchema),
    activity: Type.Array(ActivitySchema),
    activityVersions: Type.Array(ActivitySchema),
    activityRequests: Type.Array(
      Type.Object(
        {
          id: Type.String({ format: 'uuid' }),
          activityId: Type.String(),
          input: PublishActivitySchema,
        },
        { additionalProperties: false },
      ),
    ),
    legacyWorkIds: Type.Array(
      Type.Object(
        {
          workspaceId: Type.String(),
          source: Type.String(),
          workId: Type.String(),
          activityId: Type.String(),
        },
        { additionalProperties: false },
      ),
    ),
    agentMessages: Type.Optional(Type.Array(AgentMessageSchema)),
  },
  { additionalProperties: false },
);
type State = Type.Static<typeof StateSchema>;
const stateValidator = Schema.Compile(StateSchema);
const LegacyWorkspaceSchema = Type.Omit(WorkspaceSchema, ['shortId']);
const LegacyAgentMessageSchema = Type.Omit(AgentMessageSchema, ['shortId']);
const version2Validator = Schema.Compile(
  Type.Object(
    {
      ...StateSchema.properties,
      version: Type.Literal(2),
      workspaces: Type.Array(LegacyWorkspaceSchema),
      agentMessages: Type.Optional(Type.Array(LegacyAgentMessageSchema)),
    },
    { additionalProperties: false },
  ),
);
const LegacyActivitySchema = Type.Object(
  {
    ...Type.Omit(ActivitySchema, ['workKey', 'subtitle', 'revision']).properties,
    workId: Type.String({ minLength: 1, maxLength: 200, pattern: '\\S' }),
  },
  { additionalProperties: false },
);
const legacyStateValidator = Schema.Compile(
  Type.Object(
    {
      version: Type.Literal(1),
      workspaces: Type.Array(LegacyWorkspaceSchema),
      activity: Type.Array(LegacyActivitySchema),
      agentMessages: Type.Optional(Type.Array(LegacyAgentMessageSchema)),
    },
    { additionalProperties: false },
  ),
);
const workspaceValidator = Schema.Compile(WorkspaceInputSchema);
const activityValidator = Schema.Compile(PublishActivitySchema);
const targetValidator = Schema.Compile(AgentTargetSchema);
const messageValidator = Schema.Compile(SendAgentMessageSchema);
const savedMessageValidator = Schema.Compile(AgentMessageSchema);

export class StoreError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = 'StoreError';
  }
}

function workspaceInput(input: WorkspaceInput): WorkspaceInput {
  if (!workspaceValidator.Check(input)) throw new StoreError('Invalid workspace input.', 400);
  const normalized = {
    name: input.name.trim(),
    description: input.description.trim(),
    repositories: [...new Set(input.repositories.map((repository) => repository.trim()))],
  };
  if (!normalized.name || normalized.repositories.some((repository) => !repository)) {
    throw new StoreError('Workspace and repository names cannot be blank.', 400);
  }
  return normalized;
}

function activityInput(input: PublishActivity): PublishActivity {
  if (!activityValidator.Check(input)) throw new StoreError('Invalid activity input.', 400);
  const normalized: PublishActivity = {
    workspaceId: input.workspaceId,
    ...(input.workId ? { workId: input.workId.trim() } : {}),
    ...(input.workKey ? { workKey: input.workKey.toLowerCase() } : {}),
    ...(input.requestId ? { requestId: input.requestId.toLowerCase() } : {}),
    ...(input.title !== undefined ? { title: input.title.trim() } : {}),
    ...(input.subtitle !== undefined ? { subtitle: input.subtitle.trim() } : {}),
    // Markdown indentation and trailing spaces are content, including on the outer lines.
    summary: input.summary,
    status: input.status,
    source: input.source.trim(),
    ...(input.desktopSession ? { desktopSession: { ...input.desktopSession } } : {}),
    ...(input.sourceUrl ? { sourceUrl: input.sourceUrl.trim() } : {}),
    ...(input.agentTarget
      ? {
          agentTarget: {
            provider: input.agentTarget.provider,
            sessionId: input.agentTarget.sessionId.trim(),
          },
        }
      : {}),
  };
  if (!normalized.source || (normalized.title !== undefined && !normalized.title)) {
    throw new StoreError('Title and source cannot be blank.', 400);
  }
  if (normalized.sourceUrl) {
    try {
      const url = new URL(normalized.sourceUrl);
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Unsupported protocol');
    } catch {
      throw new StoreError('Source URL must be an HTTP or HTTPS URL.', 400);
    }
  }
  return normalized;
}

function requireWorkspace(state: State, id: string): Workspace {
  const workspace = state.workspaces.find((item) => item.id === id || item.shortId === id);
  if (!workspace) throw new StoreError('Workspace not found.', 404);
  return workspace;
}

function validateRelationships(state: State): void {
  const workspaceIds = new Set(state.workspaces.map((item) => item.id));
  const workspaceShortIds = new Set(state.workspaces.map((item) => item.shortId));
  const activityIds = new Set(state.activity.map((item) => item.id));
  const activityKeys = new Set(state.activity.map((item) => item.workKey));
  const workIds = new Set(state.activity.map((item) => item.workId));
  if (
    workspaceIds.size !== state.workspaces.length ||
    workspaceShortIds.size !== state.workspaces.length ||
    state.workspaces.some((item) => workspaceIds.has(item.shortId)) ||
    activityIds.size !== state.activity.length ||
    activityKeys.size !== state.activity.length ||
    workIds.size !== state.activity.length ||
    state.activity.some((item) => !workspaceIds.has(item.workspaceId))
  ) {
    throw new Error('Stored data contains duplicate IDs or an unknown workspace.');
  }
  for (const item of state.activity) {
    const versions = state.activityVersions.filter((version) => version.id === item.id);
    if (
      versions.length !== item.revision ||
      versions.some(
        (version, index) =>
          version.revision !== index + 1 ||
          version.workspaceId !== item.workspaceId ||
          version.workId !== item.workId ||
          version.workKey !== item.workKey ||
          version.title !== item.title ||
          version.createdAt !== item.createdAt,
      ) ||
      !isDeepStrictEqual(versions.at(-1), item)
    )
      throw new Error('Stored activity history is inconsistent.');
  }
  if (
    state.activityVersions.some((version) => !activityIds.has(version.id)) ||
    state.activityRequests.some(
      (request) =>
        request.input.requestId !== request.id ||
        request.input.workKey !== undefined ||
        request.input.workId !== undefined ||
        !state.activity.some(
          (item) =>
            item.id === request.activityId &&
            item.workspaceId === request.input.workspaceId &&
            item.title === request.input.title,
        ),
    ) ||
    new Set(state.activityRequests.map((request) => request.id)).size !==
      state.activityRequests.length ||
    state.legacyWorkIds.some(
      (alias) =>
        !state.activity.some(
          (item) => item.id === alias.activityId && item.workspaceId === alias.workspaceId,
        ),
    ) ||
    new Set(
      state.legacyWorkIds.map((alias) =>
        JSON.stringify([alias.workspaceId, alias.source, alias.workId]),
      ),
    ).size !== state.legacyWorkIds.length
  )
    throw new Error('Stored activity references are inconsistent.');
}

function nextShortId(existing: Iterable<string>): string {
  const used = new Set(existing);
  let id: string;
  do {
    id = randomInt(36 ** 8)
      .toString(36)
      .padStart(8, '0');
  } while (used.has(id));
  return id;
}

function nextWorkKey(existing: Iterable<string>): string {
  const used = new Set(existing);
  let key: string;
  do {
    key = randomUUID();
  } while (used.has(key));
  return key;
}

function resolveActivity(state: State, input: PublishActivity): Activity | undefined {
  const keyMatch = input.workKey
    ? state.activity.find(
        (item) => item.workKey === input.workKey && item.workspaceId === input.workspaceId,
      )
    : undefined;
  const idMatch = input.workId
    ? (state.activity.find(
        (item) => item.workId === input.workId && item.workspaceId === input.workspaceId,
      ) ??
      state.activity.find(
        (item) =>
          item.id ===
          state.legacyWorkIds.find(
            (alias) =>
              alias.workspaceId === input.workspaceId &&
              alias.source === input.source &&
              alias.workId === input.workId,
          )?.activityId,
      ))
    : undefined;
  if ((input.workKey && !keyMatch) || (input.workId && !idMatch))
    throw new StoreError(
      'Activity not found. Omit workId and workKey when creating an activity.',
      404,
    );
  if (keyMatch && idMatch && keyMatch.id !== idMatch.id)
    throw new StoreError('Work ID and Work Key identify different activities.', 409);
  if (input.requestId && (input.workKey || input.workId))
    throw new StoreError('Use requestId for creation only; use workKey for updates.', 400);
  const receipt = input.requestId
    ? state.activityRequests.find((request) => request.id === input.requestId)
    : undefined;
  if (receipt && !isDeepStrictEqual(receipt.input, input))
    throw new StoreError('This request ID was already used for a different report.', 409);
  return (
    keyMatch ??
    idMatch ??
    (receipt ? state.activity.find((item) => item.id === receipt.activityId) : undefined)
  );
}

function recordVersion(state: State, item: Activity): void {
  state.activityVersions.push(structuredClone(item));
}

export async function createStore(dataDir: string) {
  await mkdir(dataDir, { recursive: true });
  const file = join(dataDir, 'state.json');
  let state: State = {
    version: 3,
    workspaces: [],
    activity: [],
    activityVersions: [],
    activityRequests: [],
    legacyWorkIds: [],
  };
  try {
    const original = await readFile(file, 'utf8');
    let data: unknown = JSON.parse(original);
    let migratedFrom: number | undefined;
    if (legacyStateValidator.Check(data)) {
      const legacy = data;
      const legacyKeys = legacy.activity.map((item) =>
        JSON.stringify([item.workspaceId, item.source, item.workId]),
      );
      if (new Set(legacyKeys).size !== legacyKeys.length)
        throw new Error('Stored data contains duplicate work IDs.');
      const activity: Activity[] = [];
      for (const item of legacy.activity)
        activity.push({
          ...item,
          workId: nextShortId([...legacy.activity, ...activity].map((existing) => existing.workId)),
          workKey: nextWorkKey(activity.map((existing) => existing.workKey)),
          subtitle: '',
          revision: 1,
        });
      data = {
        ...legacy,
        version: 2,
        activity,
        activityVersions: structuredClone(activity),
        activityRequests: [],
        legacyWorkIds: legacy.activity.map((item) => ({
          workspaceId: item.workspaceId,
          source: item.source,
          workId: item.workId,
          activityId: item.id,
        })),
      };
      migratedFrom = 1;
    }
    if (version2Validator.Check(data)) {
      const legacy = data;
      const workspaceIds = new Set(legacy.workspaces.map((workspace) => workspace.id));
      const messageIds = new Set((legacy.agentMessages ?? []).map((message) => message.id));
      data = {
        ...legacy,
        version: 3,
        workspaces: legacy.workspaces.map((workspace) => {
          const shortId = nextShortId(workspaceIds);
          workspaceIds.add(shortId);
          return { ...workspace, shortId };
        }),
        ...(legacy.agentMessages
          ? {
              agentMessages: legacy.agentMessages.map((message) => {
                const shortId = nextShortId(messageIds);
                messageIds.add(shortId);
                return { ...message, shortId };
              }),
            }
          : {}),
      };
      migratedFrom ??= 2;
    }
    if (!stateValidator.Check(data)) throw new Error('Unsupported schema or invalid stored data.');
    state = data;
    validateRelationships(state);
    const messageIds = new Set<string>();
    const messageShortIds = new Set<string>();
    for (const message of state.agentMessages ?? []) {
      if (
        messageIds.has(message.id) ||
        messageShortIds.has(message.shortId) ||
        !state.activity.some(
          (item) => item.id === message.activityId && item.workspaceId === message.workspaceId,
        )
      )
        throw new Error('Stored messages contain duplicate IDs or an unknown activity.');
      messageIds.add(message.id);
      messageShortIds.add(message.shortId);
      // A Claude Desktop message still sending has not left this queue, so it stays deliverable.
      if (message.status === 'sending' && message.target.provider !== 'claude-desktop') {
        message.status = 'unknown';
        message.detail =
          'The server restarted before delivery was confirmed. Check the agent before sending again.';
      }
    }
    if (migratedFrom !== undefined) {
      await writeFile(
        join(dataDir, `state.v${migratedFrom}-${randomUUID()}.backup.json`),
        original,
        {
          encoding: 'utf8',
          flag: 'wx',
        },
      );
      const temporaryFile = join(dataDir, `.state-${randomUUID()}.tmp`);
      try {
        await writeFile(temporaryFile, `${JSON.stringify(state, null, 2)}\n`, {
          encoding: 'utf8',
          flag: 'wx',
        });
        await rename(temporaryFile, file);
      } catch (error) {
        await unlink(temporaryFile).catch(() => undefined);
        throw error;
      }
    }
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
      throw new Error(
        `Cannot load workspace data from ${file}. Original file has been preserved.`,
        { cause: error },
      );
    }
  }

  const listeners = new Set<(change: DashboardChange) => void>();
  function notify(event: DashboardChange) {
    for (const listener of listeners) {
      try {
        listener(event);
      } catch {
        listeners.delete(listener);
      }
    }
  }
  let pending: Promise<unknown> = Promise.resolve();
  function mutate<T>(
    change: (draft: State) => T | undefined,
    notification: (result: T) => DashboardChange,
  ): Promise<T | undefined> {
    const operation = pending.then(async () => {
      const draft = structuredClone(state);
      const result = change(draft);
      if (result === undefined) return result;
      const temporaryFile = join(dataDir, `.state-${randomUUID()}.tmp`);
      try {
        await writeFile(temporaryFile, `${JSON.stringify(draft, null, 2)}\n`, {
          encoding: 'utf8',
          flag: 'wx',
        });
        await rename(temporaryFile, file);
      } catch (error) {
        await unlink(temporaryFile).catch(() => undefined);
        throw error;
      }
      state = draft;
      notify(notification(result));
      return structuredClone(result);
    });
    pending = operation.catch(() => undefined);
    return operation;
  }

  return {
    notifyAgentSettings() {
      notify({ resource: 'agent-settings' });
    },
    notifyAgents(workspaceId: string) {
      notify({ resource: 'agents', workspaceId: requireWorkspace(state, workspaceId).id });
    },
    subscribe(listener: (change: DashboardChange) => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async listWorkspaces(): Promise<Workspace[]> {
      await pending;
      return structuredClone(state.workspaces);
    },
    async getWorkspace(idOrShortId: string): Promise<Workspace> {
      await pending;
      return structuredClone(requireWorkspace(state, idOrShortId));
    },
    async createWorkspace(input: WorkspaceInput): Promise<Workspace> {
      const values = workspaceInput(input);
      return (await mutate(
        (draft) => {
          const now = new Date().toISOString();
          const workspace = {
            ...values,
            id: randomUUID(),
            shortId: nextShortId(draft.workspaces.flatMap((item) => [item.id, item.shortId])),
            createdAt: now,
            updatedAt: now,
          };
          draft.workspaces.push(workspace);
          return workspace;
        },
        (workspace) => ({ resource: 'workspaces', workspaceId: workspace.id }),
      ))!;
    },
    async updateWorkspace(id: string, input: WorkspaceInput): Promise<Workspace> {
      const values = workspaceInput(input);
      return (await mutate(
        (draft) => {
          const workspace = requireWorkspace(draft, id);
          Object.assign(workspace, values, { updatedAt: new Date().toISOString() });
          return workspace;
        },
        (workspace) => ({ resource: 'workspaces', workspaceId: workspace.id }),
      ))!;
    },
    async listActivity(workspaceId: string): Promise<Activity[]> {
      await pending;
      workspaceId = requireWorkspace(state, workspaceId).id;
      return structuredClone(
        state.activity
          .filter((item) => item.workspaceId === workspaceId)
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id)),
      );
    },
    async findActivityForReport(input: PublishActivity): Promise<Activity | undefined> {
      await pending;
      const values = activityInput(input);
      values.workspaceId = requireWorkspace(state, values.workspaceId).id;
      return structuredClone(resolveActivity(state, values));
    },
    async listActivityVersions(workspaceId: string, activityId: string): Promise<Activity[]> {
      await pending;
      workspaceId = requireWorkspace(state, workspaceId).id;
      if (
        !state.activity.some((item) => item.workspaceId === workspaceId && item.id === activityId)
      )
        throw new StoreError('Activity not found.', 404);
      return structuredClone(state.activityVersions.filter((item) => item.id === activityId));
    },
    async publishActivity(input: PublishActivity): Promise<Activity> {
      const values = activityInput(input);
      let unchanged: Activity | undefined;
      const updated = await mutate(
        (draft) => {
          values.workspaceId = requireWorkspace(draft, values.workspaceId).id;
          const existing = resolveActivity(draft, values);
          // A delayed retry of a creation returns current reality, never overwrites newer work.
          if (existing && values.requestId) {
            unchanged = existing;
            return undefined;
          }
          if (existing && values.title !== undefined && values.title !== existing.title)
            throw new StoreError(
              'Activity titles cannot be changed. Update the subtitle instead.',
              409,
            );
          if (!existing && !values.title)
            throw new StoreError('Title is required when creating an activity.', 400);
          const canLinkDesktop =
            !existing?.agentTarget ||
            (existing.agentTarget.provider === values.agentTarget?.provider &&
              existing.agentTarget.sessionId === values.agentTarget?.sessionId) ||
            (existing.agentTarget.provider === 'claude-desktop' &&
              values.desktopSession?.provider === 'claude' &&
              existing.agentTarget.sessionId === values.desktopSession.sessionId);
          const desktopSession =
            existing?.desktopSession ?? (canLinkDesktop ? values.desktopSession : undefined);
          const now = new Date().toISOString();
          const { requestId, workId: _workId, workKey: _workKey, ...content } = values;
          const activity: Activity = {
            ...content,
            title: existing?.title ?? values.title!,
            subtitle: values.subtitle ?? existing?.subtitle ?? '',
            workId:
              existing?.workId ??
              nextShortId([...draft.activity, ...draft.legacyWorkIds].map((item) => item.workId)),
            workKey: existing?.workKey ?? nextWorkKey(draft.activity.map((item) => item.workKey)),
            revision: existing?.revision ?? 1,
            desktopSession,
            // A report can link an unbound item; later reports keep the established destination,
            // including an explicit choice made by the user in the message dialog.
            ...(existing?.agentTarget ? { agentTarget: existing.agentTarget } : {}),
            id: existing?.id ?? randomUUID(),
            createdAt: existing?.createdAt ?? now,
            updatedAt: existing?.updatedAt ?? now,
          };
          if (!desktopSession) delete activity.desktopSession;
          if (existing && isDeepStrictEqual(existing, activity)) {
            unchanged = existing;
            return undefined;
          }
          activity.revision = existing ? existing.revision + 1 : 1;
          activity.updatedAt = now;
          if (existing) draft.activity[draft.activity.indexOf(existing)] = activity;
          else draft.activity.push(activity);
          recordVersion(draft, activity);
          if (requestId)
            draft.activityRequests.push({ id: requestId, activityId: activity.id, input: values });
          return activity;
        },
        (activity) => ({ resource: 'activity', workspaceId: activity.workspaceId }),
      );
      return updated ?? structuredClone(unchanged!);
    },
    async getActivity(workspaceId: string, activityId: string): Promise<Activity> {
      await pending;
      workspaceId = requireWorkspace(state, workspaceId).id;
      const item = state.activity.find(
        (item) => item.id === activityId && item.workspaceId === workspaceId,
      );
      if (!item) throw new StoreError('Activity not found.', 404);
      return structuredClone(item);
    },
    async createAgentMessage(
      workspaceId: string,
      activityId: string,
      input: SendAgentMessage,
    ): Promise<{ message: AgentMessage; created: boolean }> {
      if (!messageValidator.Check(input) || !targetValidator.Check(input.target))
        throw new StoreError('Invalid message.', 400);
      const values = { ...input, text: input.text.trim() };
      let duplicate: AgentMessage | undefined;
      const saved = await mutate(
        (draft) => {
          workspaceId = requireWorkspace(draft, workspaceId).id;
          const item = draft.activity.find(
            (item) => item.id === activityId && item.workspaceId === workspaceId,
          );
          if (!item) throw new StoreError('Activity not found.', 404);
          draft.agentMessages ??= [];
          const existing = draft.agentMessages.find((message) => message.id === values.id);
          if (existing) {
            if (
              existing.workspaceId !== workspaceId ||
              existing.activityId !== activityId ||
              existing.text !== values.text ||
              existing.target.provider !== values.target.provider ||
              existing.target.sessionId !== values.target.sessionId
            )
              throw new StoreError(
                'This message ID was already used for a different message.',
                409,
              );
            duplicate = existing;
            return undefined;
          }
          const now = new Date().toISOString();
          const message: AgentMessage = {
            ...values,
            shortId: nextShortId(draft.agentMessages.map((message) => message.shortId)),
            workspaceId,
            activityId,
            status: 'sending',
            detail: 'Sending to the selected session.',
            createdAt: now,
            updatedAt: now,
          };
          const previous = structuredClone(item);
          // A Claude Desktop target is addressed by the same native ID that opens the session.
          const sameDesktop =
            values.target.provider === 'claude-desktop' &&
            item.desktopSession?.provider === 'claude' &&
            item.desktopSession.sessionId === values.target.sessionId;
          if (
            !sameDesktop &&
            (item.agentTarget?.provider !== values.target.provider ||
              item.agentTarget?.sessionId !== values.target.sessionId)
          )
            delete item.desktopSession;
          item.agentTarget = structuredClone(values.target);
          if (!isDeepStrictEqual(previous, item)) {
            item.revision += 1;
            item.updatedAt = now;
            recordVersion(draft, item);
          }
          draft.agentMessages.push(message);
          return message;
        },
        () => ({ resource: 'agents', workspaceId }),
      );
      return { message: saved ?? structuredClone(duplicate!), created: Boolean(saved) };
    },
    async listAgentMessages(workspaceId: string, activityId: string): Promise<AgentMessage[]> {
      await pending;
      workspaceId = requireWorkspace(state, workspaceId).id;
      if (
        !state.activity.some((item) => item.id === activityId && item.workspaceId === workspaceId)
      )
        throw new StoreError('Activity not found.', 404);
      return structuredClone(
        (state.agentMessages ?? []).filter(
          (message) => message.workspaceId === workspaceId && message.activityId === activityId,
        ),
      );
    },
    async pendingAgentMessages(target: AgentTarget): Promise<AgentMessage[]> {
      await pending;
      return structuredClone(
        (state.agentMessages ?? []).filter(
          (message) =>
            message.status === 'sending' &&
            message.target.provider === target.provider &&
            message.target.sessionId === target.sessionId,
        ),
      );
    },
    /** Updates a message only while it is still sending, so concurrent claims apply once. */
    async updatePendingAgentMessage(
      id: string,
      update: Pick<AgentMessage, 'status' | 'detail'>,
    ): Promise<AgentMessage | undefined> {
      return mutate(
        (draft) => {
          const message = draft.agentMessages?.find((message) => message.id === id);
          if (message?.status !== 'sending') return undefined;
          Object.assign(message, update, { updatedAt: new Date().toISOString() });
          return message;
        },
        (message) => ({ resource: 'agents', workspaceId: message.workspaceId }),
      );
    },
    async findAgentMessage(idOrShortId: string): Promise<AgentMessage> {
      await pending;
      const message = state.agentMessages?.find(
        (message) => message.id === idOrShortId || message.shortId === idOrShortId,
      );
      if (!message) throw new StoreError('Message not found.', 404);
      return structuredClone(message);
    },
    async updateAgentMessage(
      id: string,
      update: Partial<Pick<AgentMessage, 'status' | 'detail' | 'reply' | 'turnId'>>,
    ): Promise<AgentMessage> {
      return (await mutate(
        (draft) => {
          const message = draft.agentMessages?.find((message) => message.id === id);
          if (!message) throw new StoreError('Message not found.', 404);
          Object.assign(message, update, { updatedAt: new Date().toISOString() });
          if (!savedMessageValidator.Check(message))
            throw new StoreError('Invalid delivery update.', 400);
          return message;
        },
        (message) => ({ resource: 'agents', workspaceId: message.workspaceId }),
      ))!;
    },
    async flush(): Promise<void> {
      await pending;
    },
  };
}

export type Store = Awaited<ReturnType<typeof createStore>>;
