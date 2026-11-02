import type { FastifyInstance } from 'fastify';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import Type from 'typebox';
import { ErrorSchema, WorkspaceInputSchema, WorkspaceSchema } from '@congruence/contracts';
import type { Store } from '../../storage/store.js';

export const WorkspaceParamsSchema = Type.Object({ workspaceId: Type.String({ minLength: 1 }) });

export function registerWorkspaceRoutes(server: FastifyInstance, store: Store): void {
  const app = server.withTypeProvider<TypeBoxTypeProvider>();
  app.get(
    '/api/workspaces',
    {
      schema: {
        operationId: 'listWorkspaces',
        tags: ['workspaces'],
        response: { 200: Type.Array(WorkspaceSchema) },
      },
    },
    async () => store.listWorkspaces(),
  );

  app.post(
    '/api/workspaces',
    {
      schema: {
        operationId: 'createWorkspace',
        tags: ['workspaces'],
        body: WorkspaceInputSchema,
        response: { 201: WorkspaceSchema, 400: ErrorSchema },
      },
    },
    async (request, reply) => reply.code(201).send(await store.createWorkspace(request.body)),
  );

  app.put(
    '/api/workspaces/:workspaceId',
    {
      schema: {
        operationId: 'updateWorkspace',
        tags: ['workspaces'],
        params: WorkspaceParamsSchema,
        body: WorkspaceInputSchema,
        response: { 200: WorkspaceSchema, 400: ErrorSchema, 404: ErrorSchema },
      },
    },
    async (request) => store.updateWorkspace(request.params.workspaceId, request.body),
  );
}
