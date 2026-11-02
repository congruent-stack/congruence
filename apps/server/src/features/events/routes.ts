import type { ServerResponse } from 'node:http';
import type { FastifyInstance } from 'fastify';
import type { Store } from '../../storage/store.js';

export function registerEventRoutes(app: FastifyInstance, store: Store): void {
  const clients = new Set<ServerResponse>();

  function send(client: ServerResponse, frame: string) {
    if (client.destroyed || client.writableEnded) return;
    // Reconnecting clients reload a snapshot, so a slow reader need not accumulate events.
    try {
      if (!client.write(frame)) client.destroy();
    } catch {
      client.destroy();
    }
  }

  const unsubscribe = store.subscribe((change) => {
    const frame = `event: change\ndata: ${JSON.stringify(change)}\n\n`;
    for (const client of clients) send(client, frame);
  });
  const heartbeat = setInterval(() => {
    for (const client of clients) send(client, ': keep-alive\n\n');
  }, 15000);
  heartbeat.unref();

  app.get('/api/events', { schema: { hide: true }, exposeHeadRoute: false }, (_request, reply) => {
    reply.hijack();
    const client = reply.raw;
    for (const [name, value] of Object.entries(reply.getHeaders())) {
      if (value !== undefined) client.setHeader(name, value);
    }
    client.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    clients.add(client);
    client.on('close', () => clients.delete(client));
    client.on('error', () => client.destroy());
    // Subscribe before the browser's open event triggers its initial/reconnect snapshot.
    send(client, ': connected\nretry: 1000\n\n');
  });

  // Close streams before Fastify waits for its active responses to finish.
  app.addHook('preClose', async () => {
    clearInterval(heartbeat);
    unsubscribe();
    for (const client of clients) client.end();
    clients.clear();
  });
}
