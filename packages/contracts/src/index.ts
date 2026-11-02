import Type from 'typebox';
export * from './dashboards.js';

const Id = Type.String({ minLength: 1, maxLength: 200 });
const ShortId = Type.String({ pattern: '^[a-z0-9]{8}$' });
const Name = Type.String({ minLength: 1, maxLength: 120, pattern: '\\S' });
const DateTime = Type.String({ format: 'date-time' });
export const WorkspaceInputSchema = Type.Object(
  {
    name: Name,
    description: Type.String({ maxLength: 1000 }),
    repositories: Type.Array(Type.String({ minLength: 1, maxLength: 2000, pattern: '\\S' }), {
      maxItems: 50,
      uniqueItems: true,
    }),
  },
  { additionalProperties: false },
);
export const WorkspaceSchema = Type.Object(
  {
    ...WorkspaceInputSchema.properties,
    id: Id,
    shortId: ShortId,
    createdAt: DateTime,
    updatedAt: DateTime,
  },
  { additionalProperties: false },
);
export const ActivityStatusSchema = Type.Union(
  [Type.Literal('in_progress'), Type.Literal('blocked'), Type.Literal('done')],
  {
    description:
      'When reporting is enabled, create the activity with in_progress before doing the work. For every new task or follow-up, set the same activity to in_progress before starting. Use blocked whenever anything prevents finishing the current task; explain the obstacle and required next step in the summary. Return to in_progress when unblocked. Use done only after completion, never merely when waiting or ending a turn.',
  },
);
export const AgentTargetSchema = Type.Object(
  {
    provider: Type.Union([
      Type.Literal('codex'),
      Type.Literal('codex-desktop'),
      Type.Literal('claude-desktop'),
    ]),
    sessionId: Type.String({ minLength: 1, maxLength: 200, pattern: '\\S' }),
  },
  { additionalProperties: false },
);
// The native Desktop session ID that Open in desktop uses; for Claude it also routes messages.
export const DesktopSessionSchema = Type.Union([
  Type.Object(
    {
      provider: Type.Literal('codex-desktop'),
      sessionId: Type.String({ minLength: 1, maxLength: 200, pattern: '^(?!new$)[A-Za-z0-9_-]+$' }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      provider: Type.Literal('claude'),
      sessionId: Type.String({ pattern: '^local_[A-Za-z0-9-]{1,64}$' }),
    },
    { additionalProperties: false },
  ),
]);
export const PublishActivitySchema = Type.Object(
  {
    workspaceId: Type.String({
      minLength: 1,
      maxLength: 200,
      description: 'Workspace shortId or its existing internal ID.',
    }),
    workId: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 200,
        pattern: '\\S',
        description: 'Existing server-issued Work ID. Omit when creating an activity.',
      }),
    ),
    workKey: Type.Optional(
      Type.String({
        format: 'uuid',
        description:
          'Existing internal Work Key, accepted for compatibility. Prefer workId for updates; omit when creating.',
      }),
    ),
    requestId: Type.Optional(
      Type.String({
        format: 'uuid',
        description: 'Stable retry token for creation; reuse only for an identical create request.',
      }),
    ),
    title: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 200,
        pattern: '\\S',
        description:
          'Required on creation; immutable afterwards. Use a short, generic plain-text title for the kind of work, such as "Weather report". Leave exact places, dates, versions, quantities, and current outcomes to subtitle and summary. Keep existing titles unchanged.',
      }),
    ),
    subtitle: Type.Optional(
      Type.String({
        maxLength: 300,
        description:
          'Short plain-text context or current state. Put relevant specifics here instead of in the fixed title. Edit surgically and avoid repeating the title.',
      }),
    ),
    summary: Type.String({
      maxLength: 10000,
      description:
        'Current state in Markdown, with one fact per line. Add useful detail beyond title and subtitle; do not repeat their information unless adding relevant new information. Do not wrap the whole summary in a code fence. Group related facts under a short "- Topic" parent bullet; put each supporting fact on its own "  - Fact" sub-bullet line with two leading spaces. Independent facts can stay at the top level. Preserve existing groups and unchanged lines when updating; add new facts within the relevant group. Example structure:\n- Forecast\n  - Sunday: Cloudy.\n  - Monday: Rain.\n- Advice: Bring an umbrella.',
    }),
    status: ActivityStatusSchema,
    source: Type.String({ minLength: 1, maxLength: 80, pattern: '\\S' }),
    sourceUrl: Type.Optional(Type.String({ maxLength: 2000, pattern: '^https?://[^\\s]+$' })),
    agentTarget: Type.Optional(AgentTargetSchema),
    desktopSession: Type.Optional(DesktopSessionSchema),
  },
  { additionalProperties: false },
);
export const ActivitySchema = Type.Object(
  {
    ...Type.Omit(PublishActivitySchema, ['requestId']).properties,
    workId: ShortId,
    workKey: Type.String({ format: 'uuid' }),
    title: Type.String({ minLength: 1, maxLength: 200, pattern: '\\S' }),
    subtitle: Type.String({ maxLength: 300 }),
    revision: Type.Integer({ minimum: 1 }),
    id: Id,
    createdAt: DateTime,
    updatedAt: DateTime,
  },
  { additionalProperties: false },
);
export const ErrorSchema = Type.Object({ message: Type.String() });
export const DashboardChangeSchema = Type.Union([
  Type.Object(
    {
      resource: Type.Union([
        Type.Literal('workspaces'),
        Type.Literal('activity'),
        Type.Literal('agents'),
      ]),
      workspaceId: Id,
    },
    { additionalProperties: false },
  ),
  Type.Object({ resource: Type.Literal('agent-settings') }, { additionalProperties: false }),
]);
export const AgentSessionSchema = Type.Object({
  ...AgentTargetSchema.properties,
  name: Type.String(),
  cwd: Type.String(),
  state: Type.Union([
    Type.Literal('active'),
    Type.Literal('idle'),
    Type.Literal('offline'),
    Type.Literal('connected'),
    Type.Literal('unloaded'),
    Type.Literal('saved'),
  ]),
});
export const AgentDirectorySchema = Type.Object({
  sessions: Type.Array(AgentSessionSchema),
  codexError: Type.Optional(Type.String()),
  desktopError: Type.Optional(Type.String()),
});
export const SendAgentMessageSchema = Type.Object(
  {
    id: Type.String({ format: 'uuid' }),
    target: AgentTargetSchema,
    text: Type.String({ minLength: 1, maxLength: 10000, pattern: '\\S' }),
  },
  { additionalProperties: false },
);
export const AgentMessageSchema = Type.Object(
  {
    ...SendAgentMessageSchema.properties,
    shortId: ShortId,
    workspaceId: Id,
    activityId: Id,
    status: Type.Union([
      Type.Literal('sending'),
      Type.Literal('accepted'),
      Type.Literal('queued'),
      Type.Literal('replied'),
      Type.Literal('failed'),
      Type.Literal('unknown'),
    ]),
    detail: Type.String(),
    reply: Type.Optional(Type.String({ maxLength: 50000 })),
    turnId: Type.Optional(Id),
    createdAt: DateTime,
    updatedAt: DateTime,
  },
  { additionalProperties: false },
);
export const AgentRequestSchema = Type.Object({
  id: Id,
  sessionId: Id,
  title: Type.String(),
  detail: Type.String(),
  canApprove: Type.Boolean(),
});
export const AgentConversationSchema = Type.Object({
  messages: Type.Array(AgentMessageSchema),
  requests: Type.Array(AgentRequestSchema),
});
export const AgentSettingsSchema = Type.Object(
  {
    codexCommand: Type.String({ maxLength: 2000, pattern: '^$|\\S' }),
    codexUrl: Type.String({ minLength: 1, maxLength: 2000 }),
    codexSocket: Type.String({ maxLength: 2000 }),
  },
  { additionalProperties: false },
);
export type AgentSettings = Type.Static<typeof AgentSettingsSchema>;
// Only Codex has connection settings, so only Codex hosts propose changes.
export const AgentHostSchema = Type.Union([
  Type.Literal('codex-desktop'),
  Type.Literal('codex-cli'),
]);
export const AgentSettingsChangesSchema = Type.Partial(AgentSettingsSchema, {
  minProperties: 1,
  additionalProperties: false,
});
export const ProposeAgentSettingsSchema = Type.Object(
  {
    id: Type.String({ format: 'uuid' }),
    workspaceId: Id,
    host: AgentHostSchema,
    sessionId: Type.Optional(Id),
    evidence: Type.String({ minLength: 1, maxLength: 2000, pattern: '\\S' }),
    reason: Type.String({ minLength: 1, maxLength: 2000, pattern: '\\S' }),
    changes: AgentSettingsChangesSchema,
  },
  { additionalProperties: false },
);
export const AgentSettingsRequestSchema = Type.Object(
  {
    ...ProposeAgentSettingsSchema.properties,
    baseSettings: AgentSettingsSchema,
    status: Type.Union([
      Type.Literal('pending'),
      Type.Literal('approved'),
      Type.Literal('rejected'),
    ]),
    createdAt: DateTime,
    decidedAt: Type.Optional(DateTime),
    reappliedFrom: Type.Optional(Type.String({ format: 'uuid' })),
  },
  { additionalProperties: false },
);
// A Claude Desktop session that reported work but does not run the Congruence mod.
export const ClaudeDesktopNoticeSchema = Type.Object({
  sessionId: Type.String(),
  workspaceId: Id,
  title: Type.String(),
  reportedAt: DateTime,
});
export const AgentSettingsReviewSchema = Type.Object({
  settings: AgentSettingsSchema,
  requests: Type.Array(AgentSettingsRequestSchema),
  claudeDesktopNotices: Type.Optional(Type.Array(ClaudeDesktopNoticeSchema)),
});
export type ProposeAgentSettings = Type.Static<typeof ProposeAgentSettingsSchema>;
export type AgentSettingsRequest = Type.Static<typeof AgentSettingsRequestSchema>;
export const ReapplyAgentSettingsSchema = Type.Object(
  {
    id: Type.String({ format: 'uuid' }),
    expectedSettings: AgentSettingsSchema,
  },
  { additionalProperties: false },
);
export type ReapplyAgentSettings = Type.Static<typeof ReapplyAgentSettingsSchema>;
export const CodexMcpSetupSchema = Type.Object({
  configPath: Type.String(),
  endpoint: Type.String(),
});
export const ClaudeDesktopModSetupSchema = Type.Object({
  settingsPath: Type.String(),
  pluginDir: Type.String(),
  url: Type.String(),
  installed: Type.Boolean(),
  connectedSessions: Type.Integer({ minimum: 0 }),
});
export const AgentSetupSchema = Type.Object({
  codexMcp: Type.String(),
  codexServer: Type.String(),
  codexClient: Type.String(),
});
export type AgentTarget = Type.Static<typeof AgentTargetSchema>;
export type DesktopSession = Type.Static<typeof DesktopSessionSchema>;
export type AgentSession = Type.Static<typeof AgentSessionSchema>;
export type ClaudeDesktopModSetup = Type.Static<typeof ClaudeDesktopModSetupSchema>;
export type ClaudeDesktopNotice = Type.Static<typeof ClaudeDesktopNoticeSchema>;
export type AgentMessage = Type.Static<typeof AgentMessageSchema>;
export type SendAgentMessage = Type.Static<typeof SendAgentMessageSchema>;
export type AgentRequest = Type.Static<typeof AgentRequestSchema>;
export type DashboardChange = Type.Static<typeof DashboardChangeSchema>;
export type WorkspaceInput = Type.Static<typeof WorkspaceInputSchema>;
export type Workspace = Type.Static<typeof WorkspaceSchema>;
export type ActivityStatus = Type.Static<typeof ActivityStatusSchema>;
export type PublishActivity = Type.Static<typeof PublishActivitySchema>;
export type Activity = Type.Static<typeof ActivitySchema>;
