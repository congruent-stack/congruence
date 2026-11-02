import { execFile } from 'node:child_process';
import { isAbsolute, normalize, win32 } from 'node:path';
import type { AgentMessage, AgentSession } from '@congruence/contracts';
import { CodexClient, DeliveryError, openCodexProcess, type CodexTransport } from './codex.js';

interface SavedThread {
  id: string;
  name?: string | null;
  preview?: string;
  cwd: string;
}
export interface HistoryItem {
  turnId: string;
  startedAtMs?: number | null;
  item: {
    type: string;
    text?: string;
    phase?: string | null;
    content?: Array<{ type: string; text?: string }>;
  };
}
export interface DesktopHistory {
  list(roots: string[]): Promise<SavedThread[]>;
  items(
    threadId: string,
    cursor?: string,
    turnId?: string,
  ): Promise<{
    data: HistoryItem[];
    nextCursor?: string | null;
  }>;
  close(): void;
}
export type DesktopReceipt = Partial<Pick<AgentMessage, 'status' | 'detail' | 'reply' | 'turnId'>>;
export interface DesktopAdapter {
  listSessions(repositories: string[]): Promise<AgentSession[]>;
  send(sessionId: string, text: string, repositories: string[]): Promise<void>;
  receipt(message: AgentMessage): Promise<DesktopReceipt | undefined>;
  close(): void;
}

/** This process reads saved metadata/history only. It never resumes a chat or starts a turn. */
export class CodexDesktopHistory extends CodexClient implements DesktopHistory {
  constructor(
    connect: () => Promise<CodexTransport> = () =>
      openCodexProcess(['app-server', '--listen', 'stdio://']),
  ) {
    super(connect);
  }
  async list(roots: string[]): Promise<SavedThread[]> {
    const threads: SavedThread[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.request('thread/list', {
        limit: 100,
        sourceKinds: ['cli', 'vscode'],
        archived: false,
        sortKey: 'updated_at',
        useStateDbOnly: true,
        ...(roots.length ? { cwd: roots } : {}),
        ...(cursor ? { cursor } : {}),
      });
      if (!Array.isArray(page.data)) throw new Error('Codex returned an invalid chat list.');
      threads.push(...page.data);
      cursor = page.nextCursor ?? undefined;
    } while (cursor && threads.length < 1000);
    return threads;
  }
  async items(threadId: string, cursor?: string, turnId?: string) {
    const page = await this.request('thread/items/list', {
      threadId,
      limit: 50,
      sortDirection: 'desc',
      ...(cursor ? { cursor } : {}),
      ...(turnId ? { turnId } : {}),
    });
    if (!Array.isArray(page.data)) throw new Error('Codex returned invalid chat history.');
    return page as { data: HistoryItem[]; nextCursor?: string | null };
  }
}

export const desktopMessageMarker = (id: string) => `[Congruence message ${id}]\n`;

export function runCodexQueue(
  sessionId: string,
  text: string,
  command = process.env.CONGRUENCE_CODEX_COMMAND ?? 'codex',
): Promise<void> {
  if (!command.trim())
    return Promise.reject(
      new DeliveryError(
        'Codex is not configured. Ask your agent to propose its executable path for approval, or open Agents.',
      ),
    );
  return new Promise((resolve, reject) => {
    // Keep message text in a process argument, never a shell command. Do not use --resume:
    // Desktop consumes its shared queue and remains the owner of the actual chat.
    execFile(
      command,
      ['queue', '--thread', sessionId, '--message', text],
      { windowsHide: true, timeout: 15000, maxBuffer: 256 * 1024, encoding: 'utf8' },
      (error, stdout) => {
        if (error) {
          const missing = 'code' in error && error.code === 'ENOENT';
          reject(
            new DeliveryError(
              missing
                ? 'Codex could not be found. Open Agents and save the path to your Codex executable.'
                : 'Could not confirm the Codex queue write. Check the Desktop chat before sending again.',
              !missing,
            ),
          );
        } else if (!stdout.includes(`for thread ${sessionId}`)) {
          reject(
            new DeliveryError(
              'Codex did not confirm the queue write. Check the Desktop chat.',
              true,
            ),
          );
        } else resolve();
      },
    );
  });
}

export function localRoots(repositories: string[]): string[] {
  return repositories.filter((path) => isAbsolute(path) || win32.isAbsolute(path));
}
export function pathKey(path: string) {
  if (/^(?:[a-z]:[\\/]|\\\\)/i.test(path))
    return win32
      .normalize(path.replace(/^\\\\\?\\/, ''))
      .replace(/[\\/]+$/, '')
      .toLowerCase();
  return normalize(path).replace(/\/+$/, '') || '/';
}

export class CodexDesktop implements DesktopAdapter {
  constructor(
    private readonly history: DesktopHistory = new CodexDesktopHistory(),
    private readonly queue = runCodexQueue,
  ) {}
  async listSessions(repositories: string[]): Promise<AgentSession[]> {
    const roots = localRoots(repositories);
    return (await this.history.list(roots))
      .filter(
        (thread) => !roots.length || roots.some((root) => pathKey(root) === pathKey(thread.cwd)),
      )
      .map((thread) => ({
        provider: 'codex-desktop',
        sessionId: thread.id,
        name: (thread.name || thread.preview || thread.id).slice(0, 200),
        cwd: thread.cwd,
        state: 'saved',
      }));
  }
  async send(sessionId: string, text: string, repositories: string[]) {
    if (!(await this.listSessions(repositories)).some((session) => session.sessionId === sessionId))
      throw new DeliveryError(
        'This chat is no longer available in this workspace. Refresh sessions.',
      );
    await this.queue(sessionId, text);
  }
  async receipt(message: AgentMessage): Promise<DesktopReceipt | undefined> {
    let cursor: string | undefined;
    let turnId = message.turnId;
    // Older delivered prompts retain their UUID marker even after the record gains a short ID.
    const markers = [desktopMessageMarker(message.shortId), desktopMessageMarker(message.id)];
    const replies = new Map<string, string>();
    // Bound historical reads. Once the matching user input is found, retain its turn ID so
    // subsequent checks only read that turn, even after a long run or a dashboard restart.
    for (let pageIndex = 0; pageIndex < 20; pageIndex++) {
      const page = await this.history.items(message.target.sessionId, cursor, turnId);
      for (const entry of page.data) {
        const item = entry.item;
        if (
          item.type === 'agentMessage' &&
          item.phase === 'final_answer' &&
          !replies.has(entry.turnId)
        )
          replies.set(entry.turnId, String(item.text ?? '').slice(0, 50000));
        if (
          !turnId &&
          item.type === 'userMessage' &&
          item.content?.some(
            (content) =>
              content.type === 'text' && markers.some((marker) => content.text?.startsWith(marker)),
          )
        )
          turnId = entry.turnId;
        if (turnId && replies.has(turnId))
          return {
            status: 'replied',
            turnId,
            reply: replies.get(turnId),
            detail: 'Codex Desktop replied to this message in the selected chat.',
          };
        if (
          !turnId &&
          entry.startedAtMs &&
          entry.startedAtMs < Date.parse(message.createdAt) - 5000
        )
          return undefined;
      }
      if (turnId)
        return {
          status: 'accepted',
          turnId,
          detail:
            'The selected Codex chat received this message. Respond to any approvals in Desktop.',
        };
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    return undefined;
  }
  close() {
    this.history.close();
  }
}
