import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { AgentSession, AgentSettings } from '@congruence/contracts';

type Json = Record<string, any>;
export interface CodexTransport {
  send(value: Json): void;
  close(): void;
  onMessage: (value: Json) => void;
  onClose: (error: Error) => void;
}
export class DeliveryError extends Error {
  constructor(
    message: string,
    public readonly uncertain = false,
  ) {
    super(message);
  }
}

export async function openCodexProcess(
  args: string[],
  command = process.env.CONGRUENCE_CODEX_COMMAND ?? 'codex',
): Promise<CodexTransport> {
  if (!command.trim())
    throw new Error(
      'Codex is not configured. Ask your agent to propose its executable path for approval, or open Agents.',
    );
  const child: ChildProcessWithoutNullStreams = spawn(command, args, {
    windowsHide: true,
    stdio: 'pipe',
  });
  const transport: CodexTransport = {
    send: (value) => {
      if (!child.stdin.writable) throw new Error('Codex disconnected.');
      child.stdin.write(`${JSON.stringify(value)}\n`);
    },
    close: () => {
      child.stdin.end();
      child.kill();
    },
    onMessage: () => {},
    onClose: () => {},
  };
  const lines = createInterface({ input: child.stdout });
  lines.on('line', (line) => {
    try {
      transport.onMessage(JSON.parse(line));
    } catch {
      /* Ignore non-protocol output. */
    }
  });
  // Do not expose stderr, which can contain user paths or provider credentials.
  child.stderr.resume();
  child.on('error', () =>
    transport.onClose(
      new Error('Could not start Codex. Open Agents and save the path to your Codex executable.'),
    ),
  );
  child.on('exit', () => transport.onClose(new Error('The Codex connection closed.')));
  child.stdin.on('error', () => transport.onClose(new Error('The Codex connection closed.')));
  return transport;
}

export async function openCodexTransport(settings?: AgentSettings): Promise<CodexTransport> {
  const socketPath = settings?.codexSocket ?? process.env.CONGRUENCE_CODEX_SOCKET;
  if (socketPath)
    return openCodexProcess(['app-server', 'proxy', '--sock', socketPath], settings?.codexCommand);
  const endpoint = settings?.codexUrl ?? process.env.CONGRUENCE_CODEX_URL ?? 'ws://127.0.0.1:4500';
  const url = new URL(endpoint);
  if (
    url.protocol !== 'ws:' ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
    url.username ||
    url.password
  )
    throw new Error('Shared server URL must be a local ws:// address. Check Agents.');
  const socket = new WebSocket(url);
  const transport: CodexTransport = {
    send: (value) => {
      if (socket.readyState !== WebSocket.OPEN) throw new Error('Codex disconnected.');
      socket.send(JSON.stringify(value));
    },
    close: () => socket.close(),
    onMessage: () => {},
    onClose: () => {},
  };
  socket.addEventListener('message', (event) => {
    try {
      transport.onMessage(JSON.parse(String(event.data)));
    } catch {
      /* Invalid protocol message. */
    }
  });
  socket.addEventListener('close', () =>
    transport.onClose(new Error('The Codex connection closed.')),
  );
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error('Codex App Server is unavailable. Open Agents for setup.'));
    }, 3000);
    socket.addEventListener(
      'open',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
    socket.addEventListener(
      'error',
      () => {
        clearTimeout(timer);
        reject(new Error('Codex App Server is unavailable. Open Agents for setup.'));
      },
      { once: true },
    );
  });
  return transport;
}

export interface CodexAdapter {
  listSessions(): Promise<AgentSession[]>;
  send(sessionId: string, text: string): Promise<{ turnId: string; detail: string }>;
  onNotification: (method: string, params: Json) => void;
  onRequest: (id: number | string, method: string, params: Json) => void;
  onDisconnect: () => void;
  respond(id: number | string, result: Json): void;
  close(): void;
}

/** A connection to an existing runtime, never a separate replacement agent process. */
export class CodexClient implements CodexAdapter {
  private transport?: CodexTransport;
  private connecting?: Promise<void>;
  private nextId = 1;
  private pending = new Map<
    number,
    {
      resolve: (value: Json) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
      mutation: boolean;
    }
  >();
  onNotification: CodexAdapter['onNotification'] = () => {};
  onRequest: CodexAdapter['onRequest'] = () => {};
  onDisconnect = () => {};
  constructor(
    private readonly connect = openCodexTransport,
    private readonly timeout = 15000,
  ) {}

  private async ready() {
    if (!this.connecting) {
      this.connecting = (async () => {
        const transport = await this.connect();
        this.transport = transport;
        transport.onMessage = (message) => {
          if (message.method) {
            if (message.id !== undefined)
              this.onRequest(message.id, message.method, message.params ?? {});
            else this.onNotification(message.method, message.params ?? {});
          } else {
            const pending = this.pending.get(message.id);
            if (!pending) return;
            clearTimeout(pending.timer);
            this.pending.delete(message.id);
            if (message.error)
              pending.reject(
                new DeliveryError(String(message.error.message ?? 'Codex rejected the request.')),
              );
            else pending.resolve(message.result ?? {});
          }
        };
        transport.onClose = (error) => {
          if (this.transport !== transport) return;
          this.transport = undefined;
          this.connecting = undefined;
          for (const pending of this.pending.values()) {
            clearTimeout(pending.timer);
            pending.reject(new DeliveryError(error.message, pending.mutation));
          }
          this.pending.clear();
          this.onDisconnect();
        };
        await this.raw('initialize', {
          clientInfo: { name: 'congruence', title: 'Congruence', version: '0.1.0' },
        });
        transport.send({ method: 'initialized' });
      })().catch((error) => {
        this.close();
        throw error;
      });
    }
    await this.connecting;
  }
  private raw(method: string, params: Json, mutation = false): Promise<Json> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new DeliveryError(
            'Codex did not confirm the request in time. Check the session before trying again.',
            mutation,
          ),
        );
      }, this.timeout);
      this.pending.set(id, { resolve, reject, timer, mutation });
      try {
        if (!this.transport) throw new Error('Codex is not connected.');
        this.transport.send({ id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }
  protected async request(method: string, params: Json, mutation = false) {
    await this.ready();
    return this.raw(method, params, mutation);
  }
  private async loadedIds(): Promise<string[]> {
    const ids: string[] = [];
    let cursor: string | null = null;
    do {
      const page = await this.request('thread/loaded/list', {
        limit: 100,
        ...(cursor ? { cursor } : {}),
      });
      if (!Array.isArray(page.data) || page.data.some((id: unknown) => typeof id !== 'string'))
        throw new Error('Codex returned an invalid session list.');
      ids.push(...page.data);
      cursor = page.nextCursor ?? null;
    } while (cursor && ids.length < 1000);
    return ids;
  }
  async listSessions(): Promise<AgentSession[]> {
    const ids = await this.loadedIds();
    const sessions = await Promise.all(
      ids.map(async (id) => {
        const { thread } = await this.request('thread/read', { threadId: id });
        return {
          provider: 'codex' as const,
          sessionId: id,
          name: String(thread.name || thread.preview || id).slice(0, 200),
          cwd: String(thread.cwd ?? ''),
          state:
            thread.status?.type === 'active'
              ? ('active' as const)
              : thread.status?.type === 'idle'
                ? ('idle' as const)
                : ('offline' as const),
        };
      }),
    );
    return sessions;
  }
  async send(sessionId: string, text: string) {
    if (!(await this.loadedIds()).includes(sessionId))
      throw new DeliveryError(
        'This chat is not open in the connected Codex runtime. Open it in Codex and refresh the session list.',
      );
    // Resume an already-loaded thread to subscribe this client without creating a second session.
    const { thread } = await this.request('thread/resume', {
      threadId: sessionId,
      excludeTurns: true,
    });
    const input = [{ type: 'text', text }];
    if (thread.status?.type === 'active') {
      const turns = await this.request('thread/turns/list', {
        threadId: sessionId,
        limit: 10,
        sortDirection: 'desc',
        itemsView: 'notLoaded',
      });
      const active = turns.data?.find((turn: Json) => turn.status === 'inProgress');
      if (!active?.id)
        throw new DeliveryError('The active turn changed. Refresh the session and send again.');
      const result = await this.request(
        'turn/steer',
        { threadId: sessionId, expectedTurnId: active.id, input },
        true,
      );
      return { turnId: String(result.turnId), detail: 'Accepted into the active Codex turn.' };
    }
    if (thread.status?.type !== 'idle')
      throw new DeliveryError('This Codex session is not ready for input. Open it in Codex first.');
    const result = await this.request('turn/start', { threadId: sessionId, input }, true);
    return {
      turnId: String(result.turn.id),
      detail: 'Accepted by Codex; a new turn started in the same chat.',
    };
  }
  respond(id: number | string, result: Json) {
    if (!this.transport) throw new Error('Codex disconnected before the request was answered.');
    this.transport.send({ id, result });
  }
  close() {
    const transport = this.transport;
    this.transport = undefined;
    this.connecting = undefined;
    transport?.close();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new DeliveryError('Codex disconnected.', pending.mutation));
    }
    this.pending.clear();
  }
}
