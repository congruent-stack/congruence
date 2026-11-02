import { once } from 'node:events';
import { createConnection } from 'node:net';
import Fastify from 'fastify';
import { expect, it } from 'vitest';
import { registerConnectionShutdown } from './shutdown.js';

it('closes unused browser preconnections while allowing an active HTTP request to finish', async () => {
  const app = Fastify();
  registerConnectionShutdown(app);
  let markStarted!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  app.get('/working', async () => {
    markStarted();
    await ready;
    return { completed: true };
  });
  const baseUrl = await app.listen({ host: '127.0.0.1', port: 0 });
  const socket = createConnection({ host: '127.0.0.1', port: Number(new URL(baseUrl).port) });
  let closed = false;
  try {
    await once(socket, 'connect');
    const response = fetch(`${baseUrl}/working`).then((value) => value.json());
    await started;
    const socketClosed = once(socket, 'close');
    const closing = app.close().then(() => {
      closed = true;
    });
    await socketClosed;
    expect(closed).toBe(false);
    release();
    expect(await response).toEqual({ completed: true });
    await closing;
    expect(app.server.listening).toBe(false);
  } finally {
    release();
    socket.destroy();
    await app.close();
  }
}, 5000);
