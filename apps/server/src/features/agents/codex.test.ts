import { describe, expect, it } from 'vitest';
import { CodexClient, DeliveryError, type CodexTransport } from './codex.js';

function runtime(options: { stale?: boolean; disconnectOnSend?: boolean } = {}) {
  const calls: Array<{ id: number; method: string; params: Record<string, any> }> = [];
  const transport: CodexTransport = {
    onMessage: () => {},
    onClose: () => {},
    close: () => {},
    send(message) {
      calls.push(message as (typeof calls)[number]);
      if (message.id === undefined) return;
      queueMicrotask(() => {
        let result: unknown = {};
        if (message.method === 'thread/loaded/list')
          result = { data: ['active', 'idle'], nextCursor: null };
        if (['thread/read', 'thread/resume'].includes(message.method))
          result = {
            thread: {
              id: message.params.threadId,
              name: message.params.threadId,
              cwd: 'D:/project',
              status: { type: message.params.threadId === 'active' ? 'active' : 'idle' },
            },
          };
        if (message.method === 'thread/turns/list')
          result = { data: options.stale ? [] : [{ id: 'turn-active', status: 'inProgress' }] };
        if (message.method === 'turn/steer' || message.method === 'turn/start') {
          if (options.disconnectOnSend) {
            transport.onClose(new Error('Disconnected after write'));
            return;
          }
          result =
            message.method === 'turn/steer'
              ? { turnId: 'turn-active' }
              : { turn: { id: 'turn-new' } };
        }
        transport.onMessage({ id: message.id, result });
      });
    },
  };
  return { calls, transport, client: new CodexClient(async () => transport, 1000) };
}

describe('Codex session routing', () => {
  it('discovers loaded chats, steers active turns, and starts idle turns without policy overrides', async () => {
    const { client, calls } = runtime();
    try {
      expect((await client.listSessions()).map((session) => session.state)).toEqual([
        'active',
        'idle',
      ]);
      expect((await client.send('active', 'Focus on the tests')).turnId).toBe('turn-active');
      expect((await client.send('idle', 'Continue')).turnId).toBe('turn-new');
      expect(calls.filter((call) => call.method === 'initialize')).toHaveLength(1);
      expect(calls.find((call) => call.method === 'turn/steer')?.params).toEqual({
        threadId: 'active',
        expectedTurnId: 'turn-active',
        input: [{ type: 'text', text: 'Focus on the tests' }],
      });
      expect(calls.find((call) => call.method === 'turn/start')?.params).toEqual({
        threadId: 'idle',
        input: [{ type: 'text', text: 'Continue' }],
      });
    } finally {
      client.close();
    }
  });
  it('does not resume a chat owned by another runtime or retry a racing turn', async () => {
    const { client, calls } = runtime({ stale: true });
    try {
      await expect(client.send('not-loaded', 'Hello')).rejects.toThrow('not open');
      await expect(client.send('active', 'Hello')).rejects.toThrow('active turn changed');
      expect(
        calls.filter(
          (call) => call.method.startsWith('turn/') && call.method !== 'thread/turns/list',
        ),
      ).toEqual([]);
    } finally {
      client.close();
    }
  });
  it('reports uncertain delivery after a connection drops without replaying the message', async () => {
    const { client, calls } = runtime({ disconnectOnSend: true });
    try {
      await expect(client.send('idle', 'Hello')).rejects.toMatchObject({ uncertain: true });
      expect(calls.filter((call) => call.method === 'turn/start')).toHaveLength(1);
    } finally {
      client.close();
    }
    expect(new DeliveryError('Rejected').uncertain).toBe(false);
  });
});
