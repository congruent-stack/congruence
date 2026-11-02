import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import type { FastifyInstance } from 'fastify';

export function registerConnectionShutdown(app: FastifyInstance): void {
  // Browsers can open speculative TCP connections without sending an HTTP request.
  // Node's idle HTTP cleanup does not close these connections during server.close().
  const unused = new Set<Socket>();
  let closing = false;
  function connected(socket: Socket) {
    if (closing) {
      socket.destroy();
      return;
    }
    unused.add(socket);
    socket.once('close', () => unused.delete(socket));
  }
  function requested(request: IncomingMessage, response: ServerResponse) {
    // Once a request starts, Fastify and the route own its graceful shutdown.
    unused.delete(request.socket);
    response.once('finish', () => {
      // A response that finishes after server.close() can leave a new idle connection.
      // Reap only idle sockets after Node has completed its response bookkeeping.
      if (closing) setImmediate(() => app.server.closeIdleConnections());
    });
  }
  app.server.on('connection', connected);
  app.server.prependListener('request', requested);
  app.addHook('preClose', async () => {
    closing = true;
    for (const socket of unused) socket.destroy();
    unused.clear();
  });
  app.addHook('onClose', async () => {
    app.server.off('connection', connected);
    app.server.off('request', requested);
  });
}
