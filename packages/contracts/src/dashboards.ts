import Type from 'typebox';

const Id = Type.String({ minLength: 1, maxLength: 200 });
const JsonInput = Type.Record(Type.String(), Type.Unknown());
export const DashboardDestinationSchema = Type.Union([
  Type.Object({ kind: Type.Literal('activity'), activityId: Id }, { additionalProperties: false }),
  Type.Object(
    {
      kind: Type.Literal('desktop'),
      provider: Type.Union([Type.Literal('codex-desktop'), Type.Literal('claude-desktop')]),
      folder: Type.String({ maxLength: 2000 }),
      title: Type.String({ minLength: 1, maxLength: 120, pattern: '\\S' }),
    },
    { additionalProperties: false },
  ),
]);
export const DashboardCommandSchema = Type.Object(
  {
    id: Type.String({ pattern: '^[a-z][a-z0-9-]{0,63}$' }),
    label: Type.String({ minLength: 1, maxLength: 120 }),
    type: Type.Union([Type.Literal('agent'), Type.Literal('backend')]),
    description: Type.Optional(Type.String({ maxLength: 1000 })),
  },
  { additionalProperties: false },
);
export const DashboardManifestSchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    name: Type.String({ minLength: 1, maxLength: 120, pattern: '\\S' }),
    description: Type.Optional(Type.String({ maxLength: 1000 })),
    commands: Type.Array(DashboardCommandSchema, { maxItems: 100 }),
  },
  { additionalProperties: false },
);
export const DashboardSummarySchema = Type.Object({
  id: Id,
  workspaceId: Id,
  name: Type.String(),
  description: Type.String(),
  version: Type.Optional(Type.String()),
  backend: Type.Boolean(),
  status: Type.Union([Type.Literal('draft'), Type.Literal('ready'), Type.Literal('error')]),
  error: Type.Optional(Type.String()),
  frameUrl: Type.Optional(Type.String()),
  commands: Type.Array(DashboardCommandSchema),
});
export const DashboardLocationSchema = Type.Object({
  dashboard: DashboardSummarySchema,
  directory: Type.String(),
  instructionsPath: Type.String(),
});
export const DashboardCreateSchema = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: 120, pattern: '\\S' }),
    description: Type.Optional(Type.String({ maxLength: 1000 })),
  },
  { additionalProperties: false },
);
export const DashboardReadSchema = Type.Object(
  {
    version: Type.String({ minLength: 1, maxLength: 100 }),
    query: Type.String({ minLength: 1, maxLength: 120 }),
    input: JsonInput,
  },
  { additionalProperties: false },
);
export const DashboardPreviewInputSchema = Type.Object(
  {
    version: Type.String({ minLength: 1, maxLength: 100 }),
    commandId: Type.String({ minLength: 1, maxLength: 64 }),
    input: JsonInput,
    prompt: Type.Optional(Type.String({ maxLength: 10000 })),
    destination: Type.Optional(DashboardDestinationSchema),
  },
  { additionalProperties: false },
);
export const DashboardPreviewSchema = Type.Object({
  id: Type.String({ format: 'uuid' }),
  workspaceId: Id,
  dashboardId: Id,
  version: Type.String(),
  command: DashboardCommandSchema,
  input: JsonInput,
  prompt: Type.Optional(Type.String()),
  destination: Type.Optional(DashboardDestinationSchema),
  summary: Type.String(),
  createdAt: Type.String(),
});
export const DashboardExecuteSchema = Type.Object(
  {
    previewId: Type.String({ format: 'uuid' }),
    destination: Type.Optional(DashboardDestinationSchema),
  },
  { additionalProperties: false },
);
export const DashboardRunSchema = Type.Object({
  id: Type.String({ format: 'uuid' }),
  workspaceId: Id,
  dashboardId: Id,
  version: Type.String(),
  command: DashboardCommandSchema,
  input: JsonInput,
  prompt: Type.Optional(Type.String()),
  status: Type.Union([
    Type.Literal('prepared'),
    Type.Literal('running'),
    Type.Literal('queued'),
    Type.Literal('succeeded'),
    Type.Literal('failed'),
    Type.Literal('interrupted'),
    Type.Literal('linked'),
  ]),
  detail: Type.String(),
  result: Type.Optional(Type.Unknown()),
  launchUrl: Type.Optional(Type.String()),
  activityId: Type.Optional(Type.String()),
  destination: Type.Optional(DashboardDestinationSchema),
  createdAt: Type.String(),
  updatedAt: Type.String(),
});
export const DashboardClaimSchema = Type.Object(
  {
    workspaceId: Id,
    runId: Type.String({ format: 'uuid' }),
    provider: Type.Union([Type.Literal('codex-desktop'), Type.Literal('claude-desktop')]),
    sessionId: Type.String({ minLength: 1, maxLength: 200 }),
  },
  { additionalProperties: false },
);
export type DashboardManifest = Type.Static<typeof DashboardManifestSchema>;
export type DashboardCommand = Type.Static<typeof DashboardCommandSchema>;
export type DashboardSummary = Type.Static<typeof DashboardSummarySchema>;
export type DashboardLocation = Type.Static<typeof DashboardLocationSchema>;
export type DashboardCreate = Type.Static<typeof DashboardCreateSchema>;
export type DashboardRead = Type.Static<typeof DashboardReadSchema>;
export type DashboardPreviewInput = Type.Static<typeof DashboardPreviewInputSchema>;
export type DashboardPreview = Type.Static<typeof DashboardPreviewSchema>;
export type DashboardDestination = Type.Static<typeof DashboardDestinationSchema>;
export type DashboardExecute = Type.Static<typeof DashboardExecuteSchema>;
export type DashboardRun = Type.Static<typeof DashboardRunSchema>;
export type DashboardClaim = Type.Static<typeof DashboardClaimSchema>;
