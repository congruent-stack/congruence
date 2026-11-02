import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import Type from 'typebox';
import {
  AgentConversationSchema,
  AgentDirectorySchema,
  AgentMessageSchema,
  AgentSetupSchema,
  ClaudeDesktopModSetupSchema,
  CodexMcpSetupSchema,
  AgentSettingsSchema,
  AgentSettingsReviewSchema,
  AgentSettingsRequestSchema,
  ReapplyAgentSettingsSchema,
  ErrorSchema,
  SendAgentMessageSchema,
} from '@congruence/contracts';
import { WorkspaceParamsSchema } from '../workspaces/routes.js';
import { StoreError, type Store } from '../../storage/store.js';
import type { AgentService } from './service.js';
import type { AgentSettingsStore } from './settings.js';
import { codexConfigPath, installCodexMcp, removeCodexMcp } from './mcp-setup.js';
import {
  claudeDesktopConfigPath,
  installClaudeDesktopMcp,
  removeClaudeDesktopMcp,
} from './claude-desktop-mcp.js';
import {
  claudeDesktopModInstalled,
  claudeSettingsPath,
  installClaudeDesktopMod,
  removeClaudeDesktopMod,
} from './claude-desktop-mod.js';

const Id = Type.String({ minLength: 1, maxLength: 200 });
const ActivityParams = Type.Object({ workspaceId: Id, activityId: Id });
const DesktopSessionId = Type.String({ pattern: '^local_[A-Za-z0-9-]{1,64}$' });
const DesktopSessionParams = Type.Object({ sessionId: DesktopSessionId });
const errors = {
  400: ErrorSchema,
  401: ErrorSchema,
  403: ErrorSchema,
  404: ErrorSchema,
  409: ErrorSchema,
  503: ErrorSchema,
};
const quote = (value: string) =>
  `'${value.replace(/'/g, process.platform === 'win32' ? "''" : "'\\''")}'`;

export function registerAgentRoutes(
  server: FastifyInstance,
  service: AgentService,
  store: Store,
  repoRoot: string,
  settings: AgentSettingsStore,
  codexHome?: string,
  claudeConfigFile = claudeDesktopConfigPath(),
  claudeSettingsFile = claudeSettingsPath(),
) {
  const app = server.withTypeProvider<TypeBoxTypeProvider>();
  const configPath = codexConfigPath(codexHome);
  const pluginDir = join(repoRoot, 'apps', 'claude-mod');
  const serverOrigin = (request: {
    raw: { socket: { localPort?: number } };
    headers: { host?: string };
  }) =>
    request.raw.socket.localPort
      ? `http://127.0.0.1:${request.raw.socket.localPort}`
      : `http://${request.headers.host}`;
  const mcpEndpoint = (request: Parameters<typeof serverOrigin>[0]) =>
    `${serverOrigin(request)}/mcp`;
  const bearer = (request: { headers: { authorization?: string } }) =>
    request.headers.authorization?.replace(/^Bearer /, '');
  const modSetup = async (request: Parameters<typeof serverOrigin>[0]) => {
    const url = serverOrigin(request);
    return {
      settingsPath: claudeSettingsFile,
      pluginDir,
      url,
      installed: await claudeDesktopModInstalled(claudeSettingsFile, pluginDir, url),
      connectedSessions: service.connectedClaudeDesktopSessions(),
    };
  };
  app.get(
    '/api/agent-settings/codex-mcp',
    {
      schema: {
        operationId: 'getCodexMcpSetup',
        tags: ['agents'],
        response: { 200: CodexMcpSetupSchema, ...errors },
      },
    },
    async (request) => ({
      configPath,
      endpoint: mcpEndpoint(request),
    }),
  );
  app.post(
    '/api/agent-settings/codex-mcp',
    {
      schema: {
        operationId: 'installCodexMcpSetup',
        tags: ['agents'],
        response: { 200: CodexMcpSetupSchema, ...errors },
      },
    },
    async (request) => {
      if (!request.headers.origin)
        throw new StoreError('Add this connection in the Congruence frontend.', 403);
      const endpoint = mcpEndpoint(request);
      await installCodexMcp(configPath, endpoint);
      return { configPath, endpoint };
    },
  );
  app.delete(
    '/api/agent-settings/codex-mcp',
    {
      schema: {
        operationId: 'removeCodexMcpSetup',
        tags: ['agents'],
        response: { 200: CodexMcpSetupSchema, ...errors },
      },
    },
    async (request) => {
      if (!request.headers.origin)
        throw new StoreError('Remove this connection in the Congruence frontend.', 403);
      await removeCodexMcp(configPath);
      return {
        configPath,
        endpoint: mcpEndpoint(request),
      };
    },
  );
  app.get(
    '/api/agent-settings/claude-desktop-mcp',
    {
      schema: {
        operationId: 'getClaudeDesktopMcpSetup',
        tags: ['agents'],
        response: { 200: CodexMcpSetupSchema, ...errors },
      },
    },
    async (request) => ({ configPath: claudeConfigFile, endpoint: mcpEndpoint(request) }),
  );
  app.post(
    '/api/agent-settings/claude-desktop-mcp',
    {
      schema: {
        operationId: 'installClaudeDesktopMcpSetup',
        tags: ['agents'],
        response: { 200: CodexMcpSetupSchema, ...errors },
      },
    },
    async (request) => {
      if (!request.headers.origin)
        throw new StoreError('Add this connection in the Congruence frontend.', 403);
      const endpoint = mcpEndpoint(request);
      await installClaudeDesktopMcp(claudeConfigFile, endpoint);
      return { configPath: claudeConfigFile, endpoint };
    },
  );
  app.delete(
    '/api/agent-settings/claude-desktop-mcp',
    {
      schema: {
        operationId: 'removeClaudeDesktopMcpSetup',
        tags: ['agents'],
        response: { 200: CodexMcpSetupSchema, ...errors },
      },
    },
    async (request) => {
      if (!request.headers.origin)
        throw new StoreError('Remove this connection in the Congruence frontend.', 403);
      await removeClaudeDesktopMcp(claudeConfigFile);
      return { configPath: claudeConfigFile, endpoint: mcpEndpoint(request) };
    },
  );
  app.get(
    '/api/agent-settings/claude-desktop-mod',
    {
      schema: {
        operationId: 'getClaudeDesktopModSetup',
        tags: ['agents'],
        response: { 200: ClaudeDesktopModSetupSchema, ...errors },
      },
    },
    (request) => modSetup(request),
  );
  app.post(
    '/api/agent-settings/claude-desktop-mod',
    {
      schema: {
        operationId: 'installClaudeDesktopModSetup',
        tags: ['agents'],
        response: { 200: ClaudeDesktopModSetupSchema, ...errors },
      },
    },
    async (request) => {
      if (!request.headers.origin)
        throw new StoreError('Install the mod in the Congruence frontend.', 403);
      if (!existsSync(join(pluginDir, '.claude-plugin', 'plugin.json')))
        throw new StoreError(`The Congruence mod is missing from ${pluginDir}.`, 409);
      await installClaudeDesktopMod(claudeSettingsFile, pluginDir, serverOrigin(request));
      service.clearClaudeDesktopNotices();
      return modSetup(request);
    },
  );
  app.delete(
    '/api/agent-settings/claude-desktop-mod',
    {
      schema: {
        operationId: 'removeClaudeDesktopModSetup',
        tags: ['agents'],
        response: { 200: ClaudeDesktopModSetupSchema, ...errors },
      },
    },
    async (request) => {
      if (!request.headers.origin)
        throw new StoreError('Remove the mod in the Congruence frontend.', 403);
      await removeClaudeDesktopMod(claudeSettingsFile, pluginDir);
      return modSetup(request);
    },
  );
  app.get(
    '/api/agent-settings',
    {
      schema: {
        operationId: 'getAgentSettings',
        tags: ['agents'],
        response: { 200: AgentSettingsSchema, ...errors },
      },
    },
    async () => settings.get(),
  );
  app.put(
    '/api/agent-settings',
    {
      schema: {
        operationId: 'updateAgentSettings',
        tags: ['agents'],
        body: AgentSettingsSchema,
        response: { 200: AgentSettingsSchema, ...errors },
      },
    },
    async (request) => {
      const saved = await settings.save(request.body);
      return saved;
    },
  );
  app.get(
    '/api/agent-settings/requests',
    {
      schema: {
        operationId: 'getAgentSettingsReview',
        tags: ['agents'],
        response: { 200: AgentSettingsReviewSchema, ...errors },
      },
    },
    async () => ({
      ...settings.review(),
      claudeDesktopNotices: service.claudeDesktopNoticeList(),
    }),
  );
  // Only the frontend offers decisions and history actions. MCP clients can propose and read status.
  app.post(
    '/api/agent-settings/requests/:requestId/decision',
    {
      schema: {
        operationId: 'decideAgentSettingsRequest',
        tags: ['agents'],
        params: Type.Object({ requestId: Type.String({ format: 'uuid' }) }),
        body: Type.Object(
          { decision: Type.Union([Type.Literal('approve'), Type.Literal('reject')]) },
          { additionalProperties: false },
        ),
        response: { 200: AgentSettingsRequestSchema, ...errors },
      },
    },
    async (request) => {
      if (!request.headers.origin)
        throw new StoreError('Review this request in the Congruence frontend.', 403);
      return settings.decide(request.params.requestId, request.body.decision);
    },
  );
  app.post(
    '/api/agent-settings/requests/:requestId/reapply',
    {
      schema: {
        operationId: 'reapplyAgentSettingsRequest',
        tags: ['agents'],
        params: Type.Object({ requestId: Type.String({ format: 'uuid' }) }),
        body: ReapplyAgentSettingsSchema,
        response: { 200: AgentSettingsRequestSchema, ...errors },
      },
    },
    async (request) => {
      if (!request.headers.origin)
        throw new StoreError('Reapply this request in the Congruence frontend.', 403);
      return settings.reapply(request.params.requestId, request.body);
    },
  );
  app.delete(
    '/api/agent-settings/requests/:requestId',
    {
      schema: {
        operationId: 'deleteAgentSettingsRequest',
        tags: ['agents'],
        params: Type.Object({ requestId: Type.String({ format: 'uuid' }) }),
        response: { 200: Type.Object({ ok: Type.Boolean() }), ...errors },
      },
    },
    async (request) => {
      if (!request.headers.origin)
        throw new StoreError('Delete this request in the Congruence frontend.', 403);
      return settings.removeRequest(request.params.requestId);
    },
  );
  app.get(
    '/api/workspaces/:workspaceId/agent-sessions',
    {
      schema: {
        operationId: 'listAgentSessions',
        tags: ['agents'],
        params: WorkspaceParamsSchema,
        response: { 200: AgentDirectorySchema, ...errors },
      },
    },
    (request) => service.directory(request.params.workspaceId),
  );
  app.get(
    '/api/workspaces/:workspaceId/agent-setup',
    {
      schema: {
        operationId: 'getAgentSetup',
        tags: ['agents'],
        params: WorkspaceParamsSchema,
        response: { 200: AgentSetupSchema, ...errors },
      },
    },
    async (request) => {
      await store.getWorkspace(request.params.workspaceId);
      const origin = serverOrigin(request);
      const { codexUrl: url, codexSocket: socket, codexCommand } = settings.get();
      const executable = quote(codexCommand);
      return {
        codexMcp: `codex mcp add congruence --url ${origin}/mcp`,
        codexServer: socket
          ? `${process.platform === 'win32' ? '& ' : ''}${executable} app-server daemon start`
          : `${process.platform === 'win32' ? '& ' : ''}${executable} app-server --listen ${quote(url)}`,
        codexClient: `${process.platform === 'win32' ? '& ' : ''}${executable} --remote ${quote(socket ? `unix://${socket}` : url)}`,
      };
    },
  );
  app.get(
    '/api/workspaces/:workspaceId/activity/:activityId/messages',
    {
      schema: {
        operationId: 'getAgentConversation',
        tags: ['agents'],
        params: ActivityParams,
        response: { 200: AgentConversationSchema, ...errors },
      },
    },
    (request) => service.conversation(request.params.workspaceId, request.params.activityId),
  );
  app.post(
    '/api/workspaces/:workspaceId/activity/:activityId/messages',
    {
      schema: {
        operationId: 'sendAgentMessage',
        tags: ['agents'],
        params: ActivityParams,
        body: SendAgentMessageSchema,
        response: { 200: AgentMessageSchema, ...errors },
      },
    },
    (request) => service.send(request.params.workspaceId, request.params.activityId, request.body),
  );
  app.post(
    '/api/workspaces/:workspaceId/activity/:activityId/agent-requests/:requestId',
    {
      schema: {
        operationId: 'answerAgentRequest',
        tags: ['agents'],
        params: Type.Object({ ...ActivityParams.properties, requestId: Id }),
        body: Type.Object({ approve: Type.Boolean() }, { additionalProperties: false }),
        response: { 200: Type.Object({ ok: Type.Boolean() }), ...errors },
      },
    },
    async (request) => {
      await service.answerRequest(
        request.params.workspaceId,
        request.params.activityId,
        request.params.requestId,
        request.body.approve,
      );
      return { ok: true };
    },
  );
  // The Congruence mod in a Claude Desktop session polls these; see apps/claude-mod.
  app.post(
    '/api/agents/claude-desktop/register',
    {
      schema: {
        hide: true,
        body: Type.Object(
          { sessionId: DesktopSessionId, cwd: Type.String({ maxLength: 2000 }) },
          { additionalProperties: false },
        ),
      },
    },
    (request) => service.registerClaudeDesktop(request.body),
  );
  app.post(
    '/api/agents/claude-desktop/:sessionId/poll',
    { schema: { hide: true, params: DesktopSessionParams } },
    (request) => service.pollClaudeDesktop(request.params.sessionId, bearer(request)),
  );
  app.post(
    '/api/agents/claude-desktop/:sessionId/receipts',
    {
      schema: {
        hide: true,
        params: DesktopSessionParams,
        body: Type.Object(
          {
            messageId: Type.Union([
              Type.String({ pattern: '^[a-z0-9]{8}$' }),
              Type.String({ format: 'uuid' }),
            ]),
            outcome: Type.Union([
              Type.Literal('started'),
              Type.Literal('replied'),
              Type.Literal('stopped'),
              Type.Literal('dropped'),
            ]),
            reply: Type.Optional(Type.String({ maxLength: 50000 })),
            reason: Type.Optional(Type.String({ maxLength: 4096 })),
          },
          { additionalProperties: false },
        ),
      },
    },
    (request) =>
      service.claudeDesktopReceipt(request.params.sessionId, bearer(request), request.body),
  );
}
