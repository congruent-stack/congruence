import { fromJsonSchema, type McpServer, type CallToolResult } from '@modelcontextprotocol/server';
import Type from 'typebox';
import {
  DashboardClaimSchema,
  DashboardCreateSchema,
  DashboardLocationSchema,
  DashboardRunSchema,
  DashboardSummarySchema,
  type DashboardClaim,
  type DashboardCreate,
  type DashboardRun,
} from '@congruence/contracts';
import type { DashboardRuntime } from '../features/dashboards/runtime.js';
import type { DashboardCommands } from '../features/dashboards/commands.js';

export const dashboardInstructions =
  'Workspace dashboards are React apps for humans, separate from activity reporting. When the human asks for a dashboard, use create_dashboard (or list_dashboards and get_dashboard_directory for an existing one). Read DASHBOARD.md at the returned internal directory, implement the frontend and optional Node/TypeScript backend there, then call publish_dashboard. A browser refresh loads the latest successfully published version. Building a dashboard does not enable activity reporting. Commands must go through the host review UI; do not bypass review with direct execution endpoints. New Desktop destinations only prepare a composer; the human sends the prompt and chooses native project/environment/model/effort. Only link_dashboard_session after the human has sent the prepared prompt, using the actual current native session ID from the environment. The request marker is correlation, not authentication. ';

export function registerDashboardTools(
  server: McpServer,
  runtime: DashboardRuntime,
  commands: DashboardCommands,
  run: (operation: () => Promise<Record<string, unknown>>) => Promise<CallToolResult>,
): void {
  const workspace = Type.Object(
    { workspaceId: Type.String({ minLength: 1, maxLength: 200 }) },
    { additionalProperties: false },
  );
  const dashboard = Type.Object(
    {
      ...workspace.properties,
      dashboardId: Type.String({ minLength: 1, maxLength: 200 }),
    },
    { additionalProperties: false },
  );
  server.registerTool(
    'list_dashboards',
    {
      title: 'List workspace dashboards',
      description:
        'List agent-built dashboards in one workspace, including published versions and build errors. Activity is the built-in view and is not listed here.',
      inputSchema: fromJsonSchema<{ workspaceId: string }>(workspace),
      outputSchema: fromJsonSchema(Type.Object({ dashboards: Type.Array(DashboardSummarySchema) })),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ workspaceId }) => run(async () => ({ dashboards: await runtime.list(workspaceId) })),
  );
  server.registerTool(
    'create_dashboard',
    {
      title: 'Create a workspace dashboard',
      description:
        'Create a React dashboard starter in an internal Congruence directory for one workspace. Returns absolute source and DASHBOARD.md paths. Read those instructions, edit the source, then publish_dashboard. Creating it does not publish or execute commands. This does not enable activity reporting.',
      inputSchema: fromJsonSchema<DashboardCreate & { workspaceId: string }>(
        Type.Object(
          {
            ...workspace.properties,
            ...DashboardCreateSchema.properties,
          },
          { additionalProperties: false },
        ),
      ),
      outputSchema: fromJsonSchema(DashboardLocationSchema),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    ({ workspaceId, ...input }) =>
      run(async () => ({ ...(await runtime.create(workspaceId, input)) })),
  );
  server.registerTool(
    'get_dashboard_directory',
    {
      title: 'Locate dashboard source',
      description:
        'Return the absolute internal source directory and DASHBOARD.md instructions for an existing workspace dashboard. Edit only its source directory; Congruence manages releases and backend processes.',
      inputSchema: fromJsonSchema<{ workspaceId: string; dashboardId: string }>(dashboard),
      outputSchema: fromJsonSchema(DashboardLocationSchema),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ workspaceId, dashboardId }) =>
      run(async () => ({ ...(await runtime.location(workspaceId, dashboardId)) })),
  );
  server.registerTool(
    'publish_dashboard',
    {
      title: 'Publish a dashboard version',
      description:
        'Build the dashboard frontend and optional backend from its internal source. Activate a successfully built version; refresh Congruence to load it. Starts its backend including declared background collection. A failed build leaves the previous published version available. Do not place unreviewed command side effects in startup or data reads.',
      inputSchema: fromJsonSchema<{ workspaceId: string; dashboardId: string }>(dashboard),
      outputSchema: fromJsonSchema(Type.Object({ dashboard: DashboardSummarySchema })),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    ({ workspaceId, dashboardId }) =>
      run(async () => ({ dashboard: await runtime.publish(workspaceId, dashboardId) })),
  );
  server.registerTool(
    'link_dashboard_session',
    {
      title: 'Link a prepared Desktop session',
      description:
        'After the human sends a prepared dashboard prompt in a new native Desktop chat, bind its request to your actual current session and create the requested activity. Read CODEX_THREAD_ID for codex-desktop or CLAUDE_CODE_HOST_SESSION_ID for claude-desktop; never guess an ID. This correlates a local request and does not authenticate the agent or enable ongoing activity reporting. Repeating the same link is safe; replacing an existing link is refused.',
      inputSchema: fromJsonSchema<DashboardClaim>(DashboardClaimSchema),
      // TypeBox's empty schema for unknown JSON values is valid JSON Schema; the SDK's
      // TypeScript schema type is narrower than the schema its validator accepts.
      outputSchema: fromJsonSchema<{ run: DashboardRun }>(
        Type.Object({ run: DashboardRunSchema }) as unknown as Parameters<typeof fromJsonSchema>[0],
      ),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    (input) => run(async () => ({ run: await commands.claim(input) })),
  );
}
