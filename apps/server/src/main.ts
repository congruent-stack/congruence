import { buildApp } from './app.js';

const port = Number(process.env.PORT ?? 4310);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error('PORT must be an integer from 1 to 65535.');
// `pnpm dev` passes --no-web: Vite serves the dashboard then, and an older build here would mislead.
const serveWeb = !process.argv.includes('--no-web');
const app = await buildApp({ logger: true, serveWeb });
if (!serveWeb)
  app.get('/', { schema: { hide: true } }, async (_request, reply) =>
    reply
      .type('text/plain; charset=utf-8')
      .send(
        'This is the Congruence API server. While pnpm dev runs, open the dashboard at http://127.0.0.1:5173.',
      ),
  );
let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  await app.close();
}
process.once('SIGINT', () => {
  void shutdown();
});
process.once('SIGTERM', () => {
  void shutdown();
});
await app.listen({ port, host: '127.0.0.1' });
