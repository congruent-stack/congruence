import {
  createMcpHandler,
  fromJsonSchema,
  McpServer,
  type CallToolResult,
} from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import type { FastifyInstance } from 'fastify';
import Type from 'typebox';
import {
  ActivitySchema,
  PublishActivitySchema,
  WorkspaceSchema,
  AgentSettingsReviewSchema,
  AgentSettingsRequestSchema,
  ProposeAgentSettingsSchema,
  type Activity,
  type PublishActivity,
  type Workspace,
  type ProposeAgentSettings,
} from '@congruence/contracts';
import { StoreError, type Store } from '../storage/store.js';
import type { AgentSettingsStore } from '../features/agents/settings.js';
import type { AgentService } from '../features/agents/service.js';
import type { DashboardRuntime } from '../features/dashboards/runtime.js';
import type { DashboardCommands } from '../features/dashboards/commands.js';
import { dashboardInstructions, registerDashboardTools } from './dashboards.js';
import {
  AgentConfigurationSchema,
  ConfigurationRequiredError,
  agentConfiguration,
  type AgentConfiguration,
} from './configuration.js';

const emptyInput = fromJsonSchema<Record<string, never>>(
  Type.Object({}, { additionalProperties: false }),
);
const workspaceInput = fromJsonSchema<{ workspaceId: string }>(
  Type.Pick(PublishActivitySchema, ['workspaceId']),
);
const publishInput = fromJsonSchema<PublishActivity>(PublishActivitySchema);
const workspaceOutput = fromJsonSchema<{
  workspaces: Workspace[];
  configuration: AgentConfiguration;
}>(
  Type.Object({ workspaces: Type.Array(WorkspaceSchema), configuration: AgentConfigurationSchema }),
);
const activityOutput = fromJsonSchema<{ activity: Activity[] }>(
  Type.Object({ activity: Type.Array(ActivitySchema) }),
);
const ClaudeDesktopStatusSchema = Type.Object({
  status: Type.Literal('mod_not_connected'),
  nextStep: Type.String(),
});
const publishOutput = fromJsonSchema<{
  activity: Activity;
  configuration: AgentConfiguration;
  claudeDesktop?: Type.Static<typeof ClaudeDesktopStatusSchema>;
}>(
  Type.Object({
    activity: ActivitySchema,
    configuration: AgentConfigurationSchema,
    claudeDesktop: Type.Optional(ClaudeDesktopStatusSchema),
  }),
);
const modNotConnected = {
  status: 'mod_not_connected' as const,
  nextStep:
    'Saved. Dashboard messages cannot reach this Claude Desktop session, because it does not run the Congruence mod. Tell the human once: open Agents → Agent settings → Claude Code Desktop in Congruence, choose Apply, and restart Claude Desktop. Keep reporting progress as usual.',
};
const sessionInstructions =
  'When publishing, include agentTarget with the actual current chat/session ID so follow-up messages return to this agent. For Codex, read CODEX_THREAD_ID from the current tool environment; use provider codex-desktop in Desktop or codex for a shared App Server. Keep that target with the task. If the actual ID is unavailable, omit agentTarget; never guess from the repository, most recent chat, workId, or MCP transport session ID. Existing destinations selected in the dashboard are preserved. ' +
  'To enable Open in desktop, Codex Desktop needs only its agentTarget. For Claude Code in Desktop, also report desktopSession with provider claude and the actual local_... Desktop session ID. Claude Desktop sets CLAUDE_CODE_ENTRYPOINT=claude-desktop and puts that ID in the CLAUDE_CODE_HOST_SESSION_ID tool environment variable; read it with $env:CLAUDE_CODE_HOST_SESSION_ID in PowerShell or printenv CLAUDE_CODE_HOST_SESSION_ID in sh. publish_activity refuses a Claude Desktop report without desktopSession until the item has one. With the Congruence mod installed, that desktopSession also routes dashboard messages to the session, so Claude Desktop needs no agentTarget. When publish_activity returns claudeDesktop.nextStep, pass it to the human once. Never prefix an unverified ID with local_. Claude Code CLI sessions can report progress without agentTarget or desktopSession, but cannot receive dashboard messages. For a verified local Codex chat without an agentTarget, desktopSession may use provider codex-desktop and its actual chat ID.';
const configurationInstructions =
  'Only after the human enables reporting or requests setup, identify your host: Codex Desktop app (codex-desktop), Codex CLI (codex-cli), Claude Code in the desktop app, or Claude Code CLI. Use actual session evidence; never guess. Read get_agent_settings. For Codex, locate the executable (Get-Command codex or command -v codex); if codexCommand is empty, submit its verified path with propose_agent_settings before publishing. A matching pending proposal permits reporting while awaiting review. Claude Code needs no executable settings. Reuse matching pending proposals and stable request IDs. The human approves settings in Congruence → Agents. Never approve your own request or bypass review through HTTP, files, or environment variables. If rejected, do not resubmit without a new human instruction. Continue authorized work while awaiting review. ';
const reportingInstructions =
  'Activity reporting is opt-in. Start only when the human requests "report activity to congruence" or sends exactly "CGR:ACT". Connection alone does not enable reporting or setup. Dashboard activity context does not enable or resume reporting or override the human\'s last start/stop instruction. Once enabled, keep reporting to the current activity across turns, follow-ups, and completion until the human explicitly switches activity or stops reporting. A done status does not disable reporting. ';
const statusInstructions =
  'When reporting is enabled, complete any required reporting setup, then create the current activity with status in_progress if it does not exist. Publish this initial report before doing the work; do not wait until completion to create it. If the current activity already exists, reuse it. If its identifiers are missing from context, recover it with list_activity instead of creating a duplicate. For every new task or follow-up, publish in_progress on that same activity before starting the new work, even if its previous status was done or blocked. If anything prevents finishing the current task, publish blocked and state the obstacle and what is needed to proceed, including missing input, approval, access, or a dependency. Pending setup approval alone is not a blocker if the task can still be completed. When the blocker is resolved, publish in_progress before resuming. Publish done only when the current task is complete; waiting, interruption, or ending a turn is not completion. These status transitions are meaningful updates even when the summary needs little or no change. ';
const contentInstructions =
  'On creation, choose a short, generic title for the kind of work, such as "Weather report". Leave exact places, dates, versions, quantities, and current outcomes to subtitle and summary. Keep existing titles unchanged. Edit subtitle and summary surgically. Preserve unchanged wording, order, indentation, and line breaks. Update or remove obsolete facts; current reality takes priority over a small diff. Add new bullets or sub-bullets when there are new facts. Keep title and subtitle in plain text, and keep the subtitle short. Write the summary in Markdown; do not wrap the whole summary in a code fence. The summary should add useful detail beyond title and subtitle; do not repeat their information unless adding relevant new information. For new summary content, group related facts under a short "- Topic" parent bullet with two-space-indented "  - Fact" sub-bullets and one fact per line. For example, put daily forecasts under one Forecast bullet. Do not flatten related details into top-level bullets; independent facts can stay at the top level. On updates, preserve existing groups and edit or add facts within the relevant group. Do not manually wrap lines or reformat unchanged text for style alone. Prefer ASD-STE100 Simplified Technical English: short, clear sentences, active voice, and consistent terms. ';
const updateInstructions =
  statusInstructions +
  'Create by omitting workId and workKey; Congruence returns a short workId in the same response. Use a stable requestId UUID for creation retries. Update with the returned workId and use the workspace shortId as workspaceId; existing internal IDs remain accepted for compatibility. Never invent identifiers or create a replacement item for follow-up work. The title is fixed; update subtitle, status, and summary to describe present reality, replacing outdated content instead of appending a log. Previous versions are saved automatically. Publish meaningful changes, not heartbeats. ' +
  contentInstructions;

// Claude Desktop names its entrypoint in the User-Agent, e.g. "claude-code/2.1.309 (claude-desktop, agent-sdk/0.3.309)".
const claudeDesktopAgent = /^claude-code\/\S+ \(claude-desktop[,)]/;

// The User-Agent identifies Claude Desktop but not which session; only the agent can report that ID.
class DesktopSessionRequiredError extends StoreError {
  readonly code = 'DESKTOP_SESSION_REQUIRED';
  constructor(readonly workspaceId: string) {
    super(
      'DESKTOP_SESSION_REQUIRED: Activity was not saved. This request comes from Claude Code in the desktop app, so the report must include desktopSession for Open in desktop. Read CLAUDE_CODE_HOST_SESSION_ID from your tool environment ($env:CLAUDE_CODE_HOST_SESSION_ID in PowerShell, printenv CLAUDE_CODE_HOST_SESSION_ID in sh), then retry publish_activity with desktopSession {"provider":"claude","sessionId":"<that local_... value>"}. If the variable is unset, use the verified local_... ID from this session\'s desktop metadata; never invent one.',
      409,
    );
  }
}

function result(value: Record<string, unknown>): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
}

export function registerMcp(
  app: FastifyInstance,
  store: Store,
  settings: AgentSettingsStore,
  agents?: Pick<AgentService, 'noteClaudeDesktopReport'>,
  dashboards?: { runtime: DashboardRuntime; commands: DashboardCommands },
): void {
  const configuration = () => agentConfiguration(settings.review());
  async function run(operation: () => Promise<Record<string, unknown>>): Promise<CallToolResult> {
    try {
      return result(await operation());
    } catch (error) {
      if (!(error instanceof StoreError)) app.log.error(error);
      return {
        isError: true,
        ...(error instanceof ConfigurationRequiredError
          ? {
              structuredContent: {
                code: error.code,
                workspaceId: error.workspaceId,
                configuration: error.configuration,
                nextTool: 'propose_agent_settings',
              },
            }
          : error instanceof DesktopSessionRequiredError
            ? {
                structuredContent: {
                  code: error.code,
                  workspaceId: error.workspaceId,
                  environmentVariable: 'CLAUDE_CODE_HOST_SESSION_ID',
                },
              }
            : {}),
        content: [
          {
            type: 'text',
            text:
              error instanceof StoreError ? error.message : 'The operation could not be completed.',
          },
        ],
      };
    }
  }

  const handler = createMcpHandler(
    (context) => {
      const claudeDesktop = claudeDesktopAgent.test(
        context.requestInfo?.headers.get('user-agent') ?? '',
      );
      const server = new McpServer(
        { name: 'congruence', version: '0.1.0' },
        {
          instructions:
            reportingInstructions +
            updateInstructions +
            configurationInstructions +
            'Use list_workspaces to select an existing workspace when first enabling reporting. Congruence shows the last explicit report; it does not monitor agents automatically. ' +
            sessionInstructions +
            ' ' +
            dashboardInstructions,
        },
      );
      server.registerTool(
        'list_workspaces',
        {
          title: 'List workspaces',
          description:
            'List dashboard workspaces. Reporting stays off until the human requests "report activity to congruence" or exactly "CGR:ACT".',
          inputSchema: emptyInput,
          outputSchema: workspaceOutput,
          annotations: { readOnlyHint: true, openWorldHint: false },
        },
        async () =>
          run(async () => ({
            workspaces: await store.listWorkspaces(),
            configuration: configuration(),
          })),
      );
      server.registerTool(
        'get_agent_settings',
        {
          title: 'Read agent connection settings',
          description:
            'Read connection settings and pending changes when the human requests setup or enables reporting. For Codex, follow configuration.codex.nextStep before publishing. Reading settings does not submit a proposal. Pending changes need human review in Congruence.',
          inputSchema: emptyInput,
          outputSchema: fromJsonSchema(
            Type.Object({
              ...AgentSettingsReviewSchema.properties,
              configuration: AgentConfigurationSchema,
            }),
          ),
          annotations: { readOnlyHint: true, openWorldHint: false },
        },
        async () => run(async () => ({ ...settings.review(), configuration: configuration() })),
      );
      server.registerTool(
        'propose_agent_settings',
        {
          title: 'Request approval for connection settings',
          description:
            'Submit a verified connection-settings change for human approval in the Congruence frontend. Include your identified host, evidence, reason, workspace, and a stable request UUID. Codex hosts may propose codexCommand, codexUrl, and codexSocket; Claude Code has nothing to propose. Only changed fields are applied after approval. This tool never applies settings or runs a proposed executable. Reuse the same ID for retries and inspect get_agent_settings for existing requests and decisions. You must not approve your own request or bypass the frontend review.',
          inputSchema: fromJsonSchema<ProposeAgentSettings>(ProposeAgentSettingsSchema),
          outputSchema: fromJsonSchema(
            Type.Object({ request: AgentSettingsRequestSchema, nextStep: Type.String() }),
          ),
          annotations: {
            readOnlyHint: false,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false,
          },
        },
        async (input) =>
          run(async () => {
            const workspace = await store.getWorkspace(input.workspaceId);
            const request = await settings.propose({ ...input, workspaceId: workspace.id });
            return {
              request,
              nextStep:
                request.status === 'pending'
                  ? 'Waiting for a human. Open Agents in the Congruence frontend to approve or reject. Active settings are unchanged.'
                  : `This request was ${request.status}. Read get_agent_settings for the current configuration.`,
            };
          }),
      );
      server.registerTool(
        'list_activity',
        {
          title: 'List workspace activity',
          description: 'Read the last reported status and results of work in one workspace.',
          inputSchema: workspaceInput,
          outputSchema: activityOutput,
          annotations: { readOnlyHint: true, openWorldHint: false },
        },
        async ({ workspaceId }) =>
          run(async () => ({ activity: await store.listActivity(workspaceId) })),
      );
      server.registerTool(
        'publish_activity',
        {
          title: 'Publish work update',
          description:
            reportingInstructions +
            updateInstructions +
            'For Codex with an empty codexCommand, propose the verified executable first; a pending proposal permits reporting. source names the producer; sourceUrl is an optional real HTTP(S) reference. ' +
            sessionInstructions,
          inputSchema: publishInput,
          outputSchema: publishOutput,
          annotations: {
            readOnlyHint: false,
            destructiveHint: false,
            // A creation without requestId deliberately allocates a new item.
            idempotentHint: false,
            openWorldHint: false,
          },
        },
        async (input) =>
          run(async () => {
            // Consult an existing target as well: later progress updates may omit agentTarget.
            const existing = await store.findActivityForReport(input);
            const provider = (input.agentTarget ?? existing?.agentTarget)?.provider;
            const setup = configuration();
            const codex =
              provider === 'codex-desktop' ||
              provider === 'codex' ||
              /\bcodex\b/i.test(input.source);
            if (codex && setup.codex.status === 'proposal_required')
              throw new ConfigurationRequiredError(setup, input.workspaceId);
            // Later progress reports may omit desktopSession once the item has one.
            if (claudeDesktop && !input.desktopSession && !existing?.desktopSession)
              throw new DesktopSessionRequiredError(input.workspaceId);
            const saved = await store.publishActivity(input);
            // Only a Claude Desktop session that runs the mod can receive dashboard messages.
            const unreachable =
              claudeDesktop &&
              saved.desktopSession?.provider === 'claude' &&
              agents?.noteClaudeDesktopReport(
                saved.desktopSession.sessionId,
                saved.workspaceId,
                saved.title,
              ) === false;
            return {
              activity: saved,
              configuration: configuration(),
              ...(unreachable ? { claudeDesktop: modNotConnected } : {}),
            };
          }),
      );
      if (dashboards) registerDashboardTools(server, dashboards.runtime, dashboards.commands, run);
      return server;
    },
    { onerror: (error) => app.log.error(error) },
  );

  const nodeHandler = toNodeHandler(handler, { onerror: (error) => app.log.error(error) });
  // End subscription streams before Fastify waits for active HTTP responses to finish.
  app.addHook('preClose', async () => handler.close());
  app.all('/mcp', { schema: { hide: true } }, async (request, reply) => {
    reply.hijack();
    // Fastify has already consumed the body stream; the official adapter needs the parsed value.
    await nodeHandler(request.raw, reply.raw, request.body);
  });
}
