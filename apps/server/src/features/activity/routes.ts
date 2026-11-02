import type { FastifyInstance } from 'fastify';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import Type from 'typebox';
import { ActivitySchema, ErrorSchema, PublishActivitySchema } from '@congruence/contracts';
import type { Store } from '../../storage/store.js';
import { WorkspaceParamsSchema } from '../workspaces/routes.js';

export function registerActivityRoutes(server: FastifyInstance, store: Store): void {
  const app = server.withTypeProvider<TypeBoxTypeProvider>();
  app.get(
    '/api/workspaces/:workspaceId/activity',
    {
      schema: {
        operationId: 'listActivity',
        tags: ['activity'],
        params: WorkspaceParamsSchema,
        response: { 200: Type.Array(ActivitySchema), 404: ErrorSchema },
      },
    },
    async (request) => store.listActivity(request.params.workspaceId),
  );

  app.get(
    '/api/workspaces/:workspaceId/activity/:activityId/versions',
    {
      schema: {
        operationId: 'listActivityVersions',
        tags: ['activity'],
        params: Type.Object({
          ...WorkspaceParamsSchema.properties,
          activityId: Type.String({ minLength: 1, maxLength: 200 }),
        }),
        response: { 200: Type.Array(ActivitySchema), 404: ErrorSchema },
      },
    },
    async (request) =>
      store.listActivityVersions(request.params.workspaceId, request.params.activityId),
  );

  app.post(
    '/api/activity',
    {
      schema: {
        operationId: 'publishActivity',
        tags: ['activity'],
        body: PublishActivitySchema,
        response: { 200: ActivitySchema, 400: ErrorSchema, 404: ErrorSchema, 409: ErrorSchema },
      },
    },
    async (request) => store.publishActivity(request.body),
  );
}
