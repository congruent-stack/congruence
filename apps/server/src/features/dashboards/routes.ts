import type { FastifyInstance } from 'fastify';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import Type from 'typebox';
import {
  DashboardCreateSchema,
  DashboardExecuteSchema,
  DashboardLocationSchema,
  DashboardPreviewInputSchema,
  DashboardPreviewSchema,
  DashboardReadSchema,
  DashboardRunSchema,
  DashboardSummarySchema,
  ErrorSchema,
} from '@congruence/contracts';
import { WorkspaceParamsSchema } from '../workspaces/routes.js';
import type { DashboardRuntime } from './runtime.js';
import type { DashboardCommands } from './commands.js';

const DashboardParamsSchema = Type.Object({
  ...WorkspaceParamsSchema.properties,
  dashboardId: Type.String({ minLength: 1, maxLength: 200 }),
});
const failures = { 400: ErrorSchema, 404: ErrorSchema, 409: ErrorSchema };
const base = '/api/workspaces/:workspaceId/dashboards';

export function registerDashboardRoutes(
  server: FastifyInstance,
  runtime: DashboardRuntime,
  commands: DashboardCommands,
): void {
  const app = server.withTypeProvider<TypeBoxTypeProvider>();
  app.get(
    base,
    {
      schema: {
        operationId: 'listDashboards',
        tags: ['dashboards'],
        params: WorkspaceParamsSchema,
        response: { 200: Type.Array(DashboardSummarySchema), ...failures },
      },
    },
    (request) => runtime.list(request.params.workspaceId),
  );
  app.post(
    base,
    {
      schema: {
        operationId: 'createDashboard',
        tags: ['dashboards'],
        params: WorkspaceParamsSchema,
        body: DashboardCreateSchema,
        response: { 200: DashboardLocationSchema, ...failures },
      },
    },
    (request) => runtime.create(request.params.workspaceId, request.body),
  );
  app.get(
    `${base}/:dashboardId/directory`,
    {
      schema: {
        operationId: 'getDashboardDirectory',
        tags: ['dashboards'],
        params: DashboardParamsSchema,
        response: { 200: DashboardLocationSchema, ...failures },
      },
    },
    (request) => runtime.location(request.params.workspaceId, request.params.dashboardId),
  );
  app.post(
    `${base}/:dashboardId/publish`,
    {
      schema: {
        operationId: 'publishDashboard',
        tags: ['dashboards'],
        params: DashboardParamsSchema,
        response: { 200: DashboardSummarySchema, ...failures },
      },
    },
    (request) => runtime.publish(request.params.workspaceId, request.params.dashboardId),
  );
  app.post(
    `${base}/:dashboardId/read`,
    {
      schema: {
        operationId: 'readDashboardData',
        tags: ['dashboards'],
        params: DashboardParamsSchema,
        body: DashboardReadSchema,
        response: { 200: Type.Object({ data: Type.Unknown() }), ...failures },
      },
    },
    async (request) => ({
      data: await runtime.read(
        request.params.workspaceId,
        request.params.dashboardId,
        request.body.version,
        request.body.query,
        request.body.input,
      ),
    }),
  );
  app.post(
    `${base}/:dashboardId/previews`,
    {
      schema: {
        operationId: 'previewDashboardCommand',
        tags: ['dashboards'],
        params: DashboardParamsSchema,
        body: DashboardPreviewInputSchema,
        response: { 200: DashboardPreviewSchema, ...failures },
      },
    },
    (request) =>
      commands.preview(request.params.workspaceId, request.params.dashboardId, request.body),
  );
  app.post(
    `${base}/:dashboardId/runs`,
    {
      schema: {
        operationId: 'executeDashboardCommand',
        tags: ['dashboards'],
        params: DashboardParamsSchema,
        body: DashboardExecuteSchema,
        response: { 200: DashboardRunSchema, ...failures },
      },
    },
    (request) =>
      commands.execute(request.params.workspaceId, request.params.dashboardId, request.body),
  );
  app.get(
    `${base}/:dashboardId/runs`,
    {
      schema: {
        operationId: 'listDashboardRuns',
        tags: ['dashboards'],
        params: DashboardParamsSchema,
        response: { 200: Type.Array(DashboardRunSchema), ...failures },
      },
    },
    (request) => commands.list(request.params.workspaceId, request.params.dashboardId),
  );
  app.get(
    `${base}/:dashboardId/versions/:version/assets/*`,
    { schema: { hide: true } },
    async (request, reply) => {
      const params = request.params as {
        workspaceId: string;
        dashboardId: string;
        version: string;
        '*': string;
      };
      const asset = await runtime.asset(
        params.workspaceId,
        params.dashboardId,
        params.version,
        params['*'],
      );
      reply.header('Cache-Control', 'public, max-age=31536000, immutable');
      // Published public assets can be read by the sandboxed frame's opaque origin.
      reply.header('Access-Control-Allow-Origin', '*');
      reply.header(
        'Content-Security-Policy',
        "sandbox allow-scripts; default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src http: https: data:; connect-src http: https:; font-src http: https: data:; frame-ancestors 'self'; base-uri 'none'; form-action 'none'",
      );
      return reply.type(asset.contentType).send(asset.body);
    },
  );
}
