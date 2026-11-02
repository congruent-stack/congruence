import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyError } from 'fastify';
import swagger from '@fastify/swagger';
import fastifyStatic from '@fastify/static';
import Type from 'typebox';
import { registerWorkspaceRoutes } from './features/workspaces/routes.js';
import { registerActivityRoutes } from './features/activity/routes.js';
import { registerEventRoutes } from './features/events/routes.js';
import { createStore, StoreError, type Store } from './storage/store.js';
import { AgentService } from './features/agents/service.js';
import { registerAgentRoutes } from './features/agents/routes.js';
import {
  CodexClient,
  openCodexProcess,
  openCodexTransport,
  type CodexAdapter,
} from './features/agents/codex.js';
import {
  CodexDesktop,
  CodexDesktopHistory,
  runCodexQueue,
  type DesktopAdapter,
} from './features/agents/desktop.js';
import { createAgentSettings } from './features/agents/settings.js';
import { createDashboardRuntime } from './features/dashboards/runtime.js';
import { createDashboardCommands } from './features/dashboards/commands.js';
import { registerDashboardRoutes } from './features/dashboards/routes.js';
import { registerConnectionShutdown } from './shutdown.js';

declare module 'fastify' {
  interface FastifyInstance {
    store: Store;
  }
}

export interface AppOptions {
  dataDir?: string;
  serveWeb?: boolean;
  logger?: boolean;
  mcp?: boolean;
  codexAdapter?: CodexAdapter;
  desktopAdapter?: DesktopAdapter | false;
  codexHome?: string;
  claudeConfigPath?: string;
  claudeSettingsPath?: string;
}

const defaultDataDir = fileURLToPath(new URL('../../../.local/', import.meta.url));
const webRoot = fileURLToPath(new URL('../../web/dist/', import.meta.url));
const loopbackHosts = new Set(['localhost', '127.0.0.1', '[::1]']);

export async function buildApp(options: AppOptions = {}) {
  const dataDir = options.dataDir ?? process.env.CONGRUENCE_DATA_DIR ?? defaultDataDir;
  const store = await createStore(dataDir);
  const settings = await createAgentSettings(dataDir);
  const app = Fastify({
    logger: options.logger ?? false,
    bodyLimit: 256 * 1024,
    ajv: { customOptions: { coerceTypes: false, removeAdditional: false, useDefaults: false } },
  });
  registerConnectionShutdown(app);
  app.decorate('store', store);
  const agents = new AgentService(
    store,
    options.codexAdapter ?? new CodexClient(() => openCodexTransport(settings.get())),
    (error) => app.log.error(error),
    options.desktopAdapter ??
      new CodexDesktop(
        new CodexDesktopHistory(() =>
          openCodexProcess(['app-server', '--listen', 'stdio://'], settings.get().codexCommand),
        ),
        (sessionId, text) => runCodexQueue(sessionId, text, settings.get().codexCommand),
      ),
  );
  const unsubscribeSettings = settings.subscribe((changed) => {
    if (changed) agents.reconnect();
    store.notifyAgentSettings();
  });
  const dashboards = await createDashboardRuntime(dataDir, store);
  const dashboardCommands = await createDashboardCommands(dataDir, store, agents, dashboards);
  app.addHook('onClose', async () => {
    await dashboardCommands.close();
    await dashboards.close();
    await settings.flush();
    unsubscribeSettings();
    await agents.close();
  });
  app.addHook('onClose', async () => store.flush());
  app.addHook('onRequest', async (request, reply) => {
    const host = request.headers.host;
    let hostname = '';
    try {
      hostname = new URL(`http://${host}`).hostname;
    } catch {
      /* Invalid hosts are rejected below. */
    }
    if (!host || !loopbackHosts.has(hostname)) {
      return reply.code(403).send({ message: 'This local server accepts loopback hosts only.' });
    }
    const origin = request.headers.origin;
    const publicDashboardAsset =
      request.method === 'GET' &&
      /^\/api\/workspaces\/[^/]+\/dashboards\/[^/]+\/versions\/[^/]+\/assets\//.test(request.url);
    if (origin && !(origin === 'null' && publicDashboardAsset)) {
      try {
        const url = new URL(origin);
        if (!['http:', 'https:'].includes(url.protocol) || !loopbackHosts.has(url.hostname))
          throw new Error('Origin');
        if (
          (request.url.includes('/messages') ||
            request.url.includes('/agent-requests/') ||
            request.url.startsWith('/api/agents/claude-desktop/') ||
            (request.url.includes('/dashboards') && !publicDashboardAsset) ||
            request.url.startsWith('/api/agent-settings')) &&
          url.host !== host
        )
          throw new Error('Agent controls require the same origin.');
      } catch {
        return reply
          .code(403)
          .send({ message: 'Cross-origin requests from remote websites are not allowed.' });
      }
    }
    reply.header('X-Content-Type-Options', 'nosniff');
  });
  app.setErrorHandler<FastifyError>((error, request, reply) => {
    if (error instanceof StoreError)
      return reply.code(error.statusCode).send({ message: error.message });
    if (error.validation) return reply.code(400).send({ message: error.message });
    const status =
      error.statusCode && error.statusCode >= 400 && error.statusCode < 500
        ? error.statusCode
        : 500;
    if (status === 500) request.log.error(error);
    return reply
      .code(status)
      .send({ message: status === 500 ? 'The request could not be completed.' : error.message });
  });

  await app.register(swagger, {
    openapi: { info: { title: 'Congruence local API', version: '0.1.0' } },
  });
  app.get(
    '/api/health',
    {
      schema: {
        operationId: 'getHealth',
        response: { 200: Type.Object({ status: Type.Literal('ok') }) },
      },
    },
    async () => ({ status: 'ok' as const }),
  );
  registerWorkspaceRoutes(app, store);
  registerActivityRoutes(app, store);
  registerEventRoutes(app, store);
  registerDashboardRoutes(app, dashboards, dashboardCommands);
  registerAgentRoutes(
    app,
    agents,
    store,
    fileURLToPath(new URL('../../../', import.meta.url)),
    settings,
    options.codexHome,
    options.claudeConfigPath,
    options.claudeSettingsPath,
  );
  app.get('/api/openapi.json', { schema: { hide: true } }, async () => app.swagger());

  if (options.mcp !== false) {
    const { registerMcp } = await import('./mcp/index.js');
    await registerMcp(app, store, settings, agents, {
      runtime: dashboards,
      commands: dashboardCommands,
    });
  }
  if (options.serveWeb !== false && existsSync(webRoot)) {
    await app.register(fastifyStatic, { root: webRoot });
    app.setNotFoundHandler(async (request, reply) => {
      if (
        request.method === 'GET' &&
        !request.url.startsWith('/api/') &&
        !request.url.startsWith('/mcp')
      ) {
        return reply.sendFile('index.html');
      }
      return reply.code(404).send({ message: 'Not found.' });
    });
  }
  return app;
}
