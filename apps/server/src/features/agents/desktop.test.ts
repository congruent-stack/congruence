import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentMessage } from '@congruence/contracts';
import type { CodexTransport } from './codex.js';
import {
  CodexDesktop,
  CodexDesktopHistory,
  desktopMessageMarker,
  runCodexQueue,
  type DesktopHistory,
  type HistoryItem,
} from './desktop.js';

const { execute } = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  execFile: execute,
}));
afterEach(() => {
  vi.unstubAllEnvs();
  execute.mockReset();
});

const message: AgentMessage = {
  id: '11234567-89ab-4def-8123-456789abcdef',
  shortId: 'msg012ab',
  workspaceId: 'workspace',
  activityId: 'activity',
  target: { provider: 'codex-desktop', sessionId: 'desktop' },
  text: 'Continue',
  status: 'queued',
  detail: 'Queued',
  createdAt: '2026-10-31T14:00:00.000Z',
  updatedAt: '2026-10-31T14:00:00.000Z',
};
const input: HistoryItem = {
  turnId: 'matching-turn',
  item: {
    type: 'userMessage',
    content: [{ type: 'text', text: desktopMessageMarker(message.shortId) + 'Continue' }],
  },
};
const final = (turnId: string, text: string): HistoryItem => ({
  turnId,
  item: { type: 'agentMessage', phase: 'final_answer', text },
});
function history() {
  return {
    list: vi.fn<DesktopHistory['list']>().mockResolvedValue([]),
    items: vi.fn<DesktopHistory['items']>().mockResolvedValue({ data: [] }),
    close: vi.fn(),
  };
}

describe('Codex Desktop discovery and delivery', () => {
  it('uses only saved metadata/history APIs, following cursors without resuming chats', async () => {
    const calls: Array<{ method: string; params?: Record<string, any> }> = [];
    const transport: CodexTransport = {
      onMessage: () => {},
      onClose: () => {},
      close: () => {},
      send(request) {
        calls.push(request as (typeof calls)[number]);
        if (request.id === undefined) return;
        let result = {};
        if (request.method === 'thread/list')
          result = {
            data: [{ id: request.params.cursor ? 'second' : 'first', cwd: 'D:/project' }],
            nextCursor: request.params.cursor ? null : 'next-page',
          };
        if (request.method === 'thread/items/list') result = { data: [input], nextCursor: null };
        queueMicrotask(() => transport.onMessage({ id: request.id, result }));
      },
    };
    const reader = new CodexDesktopHistory(async () => transport);
    try {
      expect((await reader.list(['D:/project'])).map((thread) => thread.id)).toEqual([
        'first',
        'second',
      ]);
      expect((await reader.items('desktop', 'cursor', 'matching-turn')).data).toEqual([input]);
      expect(calls.map((call) => call.method)).toEqual([
        'initialize',
        'initialized',
        'thread/list',
        'thread/list',
        'thread/items/list',
      ]);
      expect(calls[2].params).toMatchObject({
        cwd: ['D:/project'],
        archived: false,
        sourceKinds: ['cli', 'vscode'],
        useStateDbOnly: true,
      });
      expect(calls[4].params).toEqual({
        threadId: 'desktop',
        turnId: 'matching-turn',
        cursor: 'cursor',
        limit: 50,
        sortDirection: 'desc',
      });
    } finally {
      reader.close();
    }
  });

  it('scopes saved chats to local repository folders and revalidates before queueing', async () => {
    const reader = history();
    reader.list.mockResolvedValue([
      { id: 'desktop', cwd: '\\\\?\\D:\\Project', name: 'My chat' },
      { id: 'other', cwd: 'D:/different', name: 'Another project' },
    ]);
    const queue = vi.fn().mockResolvedValue(undefined);
    const desktop = new CodexDesktop(reader, queue);
    const roots = ['d:/project/', 'https://github.com/org/project'];
    expect(await desktop.listSessions(roots)).toEqual([
      {
        provider: 'codex-desktop',
        sessionId: 'desktop',
        name: 'My chat',
        cwd: '\\\\?\\D:\\Project',
        state: 'saved',
      },
    ]);
    expect(reader.list).toHaveBeenLastCalledWith(['d:/project/']);
    await desktop.send('desktop', 'Continue', roots);
    expect(queue).toHaveBeenCalledExactlyOnceWith('desktop', 'Continue');
    await expect(desktop.send('other', 'Continue', roots)).rejects.toThrow('no longer available');
    reader.list.mockResolvedValue([]);
    await expect(desktop.send('desktop', 'Continue', roots)).rejects.toThrow('no longer available');
    expect(queue).toHaveBeenCalledTimes(1);
  });

  it('offers recent chats when a workspace has no local repository paths', async () => {
    const reader = history();
    reader.list.mockResolvedValue([{ id: 'desktop', cwd: 'D:/project', preview: 'Preview' }]);
    expect(await new CodexDesktop(reader).listSessions(['org/project'])).toHaveLength(1);
    expect(reader.list).toHaveBeenCalledWith([]);
  });

  it('correlates a reply with the exact outgoing input across history pages', async () => {
    const reader = history();
    reader.items
      .mockResolvedValueOnce({
        data: [final('unrelated', 'Wrong reply'), final('matching-turn', 'Correct reply')],
        nextCursor: 'next',
      })
      .mockResolvedValueOnce({ data: [input], nextCursor: null });
    const receipt = await new CodexDesktop(reader).receipt(message);
    expect(receipt).toMatchObject({
      status: 'replied',
      turnId: 'matching-turn',
      reply: 'Correct reply',
    });
    expect(reader.items).toHaveBeenNthCalledWith(2, 'desktop', 'next', undefined);
  });

  it('records receipt only after matching input and restricts later reads to that turn', async () => {
    const reader = history();
    const desktop = new CodexDesktop(reader);
    reader.items.mockResolvedValueOnce({ data: [final('unrelated', 'A different response')] });
    expect(await desktop.receipt(message)).toBeUndefined();
    reader.items.mockResolvedValueOnce({ data: [input] });
    expect(await desktop.receipt(message)).toMatchObject({
      status: 'accepted',
      turnId: 'matching-turn',
    });
    reader.items.mockResolvedValueOnce({ data: [final('matching-turn', 'Finished')] });
    expect(await desktop.receipt({ ...message, turnId: 'matching-turn' })).toMatchObject({
      status: 'replied',
      reply: 'Finished',
    });
    expect(reader.items).toHaveBeenLastCalledWith('desktop', undefined, 'matching-turn');
  });

  it('matches already-delivered UUID markers after assigning a short message ID', async () => {
    const reader = history();
    reader.items.mockResolvedValue({
      data: [
        final('matching-turn', 'Legacy reply'),
        {
          ...input,
          item: {
            type: 'userMessage',
            content: [{ type: 'text', text: desktopMessageMarker(message.id) + 'Continue' }],
          },
        },
      ],
    });
    expect(await new CodexDesktop(reader).receipt(message)).toMatchObject({
      status: 'replied',
      turnId: 'matching-turn',
      reply: 'Legacy reply',
    });
  });

  it('bounds receipt scans and stops at history older than the outgoing message', async () => {
    const reader = history();
    const desktop = new CodexDesktop(reader);
    reader.items.mockResolvedValue({ data: [], nextCursor: 'more' });
    expect(await desktop.receipt(message)).toBeUndefined();
    expect(reader.items).toHaveBeenCalledTimes(20);
    reader.items.mockClear();
    reader.items.mockResolvedValue({
      data: [
        {
          ...input,
          startedAtMs: Date.parse(message.createdAt) - 6000,
          item: { type: 'reasoning' },
        },
      ],
      nextCursor: 'more',
    });
    expect(await desktop.receipt(message)).toBeUndefined();
    expect(reader.items).toHaveBeenCalledTimes(1);
  });

  it('passes the message literally to the queue executable without a shell or resume flag', async () => {
    vi.stubEnv('CONGRUENCE_CODEX_COMMAND', 'C:/Program Files/Codex/codex.exe');
    execute.mockImplementation((_file, _args, _options, callback) =>
      callback(null, 'Queued message id for thread desktop.'),
    );
    const text = 'Quotes " and `backticks` with $(commands)\nStay literal.';
    await runCodexQueue('desktop', text);
    expect(execute).toHaveBeenCalledWith(
      'C:/Program Files/Codex/codex.exe',
      ['queue', '--thread', 'desktop', '--message', text],
      { windowsHide: true, timeout: 15000, maxBuffer: 256 * 1024, encoding: 'utf8' },
      expect.any(Function),
    );
  });

  it('distinguishes a missing executable from uncertain queue outcomes without retrying', async () => {
    execute.mockImplementationOnce((_file, _args, _options, callback) =>
      callback(Object.assign(new Error(), { code: 'ENOENT' })),
    );
    await expect(runCodexQueue('desktop', 'Hello')).rejects.toMatchObject({ uncertain: false });
    execute.mockImplementationOnce((_file, _args, _options, callback) =>
      callback(Object.assign(new Error(), { code: 'ETIMEDOUT' })),
    );
    await expect(runCodexQueue('desktop', 'Hello')).rejects.toMatchObject({ uncertain: true });
    execute.mockImplementationOnce((_file, _args, _options, callback) =>
      callback(null, 'Unexpected response'),
    );
    await expect(runCodexQueue('desktop', 'Hello')).rejects.toMatchObject({ uncertain: true });
    expect(execute).toHaveBeenCalledTimes(3);
  });
});
