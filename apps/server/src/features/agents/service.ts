import { randomUUID, timingSafeEqual } from 'node:crypto';
import type {
  Activity,
  AgentMessage,
  AgentRequest,
  AgentSession,
  ClaudeDesktopNotice,
  SendAgentMessage,
  Workspace,
} from '@congruence/contracts';
import { StoreError, type Store } from '../../storage/store.js';
import { CodexClient, DeliveryError, type CodexAdapter } from './codex.js';
import {
  CodexDesktop,
  desktopMessageMarker,
  localRoots,
  pathKey,
  type DesktopAdapter,
} from './desktop.js';

interface ClaudeDesktopSession {
  sessionId: string;
  cwd: string;
  token: string;
  lastSeen: number;
}
export type ClaudeDesktopOutcome = {
  messageId: string;
  outcome: 'started' | 'replied' | 'stopped' | 'dropped';
  reply?: string;
  reason?: string;
};

// The Congruence mod polls every two seconds. A session that stops polling is offline.
const claudeDesktopTimeout = 10000;
const stopReasons: Record<string, string> = {
  aborted: 'the turn was stopped',
  error: 'an error ended the turn',
  refusal: 'Claude declined to answer',
};

function sameToken(expected: string, supplied?: string) {
  const value = Buffer.from(supplied ?? '');
  return (
    value.length === Buffer.byteLength(expected) && timingSafeEqual(value, Buffer.from(expected))
  );
}
function folderName(path: string) {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}
function messageContext(item: Activity, workspace: Workspace, text: string) {
  return [
    '---',
    text,
    '',
    '---',
    `Activity: ${item.title}`,
    `Work ID: ${item.workId}`,
    `Workspace ID: ${workspace.shortId}`,
  ].join('\n');
}
interface PendingRequest {
  display: AgentRequest;
  wireId: number | string;
  method: string;
  workspaceId: string;
}

export class AgentService {
  private readonly claudeDesktop = new Map<string, ClaudeDesktopSession>();
  private readonly claudeDesktopNotices = new Map<string, ClaudeDesktopNotice>();
  private readonly codexMessages = new Map<string, AgentMessage[]>();
  private readonly requests = new Map<string, PendingRequest>();
  private readonly codexItems = new Map<string, Record<string, unknown>>();
  private readonly inFlight = new Set<Promise<unknown>>();
  private readonly desktopChecks = new Map<string, Promise<void>>();
  constructor(
    private readonly store: Store,
    private readonly codex: CodexAdapter = new CodexClient(),
    private readonly logError: (error: unknown) => void = () => {},
    private readonly desktop: DesktopAdapter | false = new CodexDesktop(),
  ) {
    codex.onNotification = (method, params) => {
      const work = this.handleNotification(method, params).catch(logError);
      this.track(work);
    };
    codex.onDisconnect = () => {
      for (const request of this.requests.values()) store.notifyAgents(request.workspaceId);
      this.requests.clear();
      for (const messages of this.codexMessages.values())
        if (messages[0]) store.notifyAgents(messages[0].workspaceId);
    };
    codex.onRequest = (id, method, params) => {
      const messages = this.codexMessages.get(params.threadId);
      const context = messages?.at(-1);
      // Requests for other chats belong to their existing clients.
      if (!context) return;
      const requestId = randomUUID();
      const item = this.codexItems.get(params.itemId);
      const hasPreview =
        method === 'item/fileChange/requestApproval'
          ? Boolean(item?.changes)
          : Boolean(params.command);
      const canApprove =
        hasPreview &&
        !params.additionalPermissions &&
        !params.networkApprovalContext &&
        ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(
          method,
        ) &&
        (!params.availableDecisions || params.availableDecisions.includes('accept'));
      this.requests.set(requestId, {
        wireId: id,
        method,
        workspaceId: context.workspaceId,
        display: {
          id: requestId,
          sessionId: params.threadId,
          title: canApprove ? 'Codex needs approval' : 'Codex needs input in its own client',
          detail:
            String(params.reason ?? params.message ?? params.command ?? method) +
            (params.command && params.reason ? `\n${params.command}` : '') +
            (params.grantRoot ? `\nRequested path: ${params.grantRoot}` : '') +
            (item?.changes ? `\n${JSON.stringify(item.changes, null, 2)}` : '') +
            (!canApprove ? '\nRespond in the native Codex client, or decline here.' : ''),
          canApprove,
        },
      });
      store.notifyAgents(context.workspaceId);
    };
  }
  private track<T>(promise: Promise<T>): Promise<T> {
    this.inFlight.add(promise);
    void promise.finally(() => this.inFlight.delete(promise)).catch(() => {});
    return promise;
  }
  private decline(id: number | string, method: string) {
    const result =
      method === 'mcpServer/elicitation/request'
        ? { action: 'decline', content: null }
        : method === 'item/permissions/requestApproval'
          ? { permissions: {}, scope: 'turn' }
          : method.includes('requestUserInput')
            ? { answers: {} }
            : { decision: 'decline' };
    this.codex.respond(id, result);
  }
  private claudeDesktopState(session: ClaudeDesktopSession) {
    return Date.now() - session.lastSeen < claudeDesktopTimeout
      ? ('connected' as const)
      : ('offline' as const);
  }
  // Sessions in the workspace's folders, plus any session an activity of the workspace reported.
  private async claudeDesktopSessions(workspace: Workspace): Promise<AgentSession[]> {
    const roots = localRoots(workspace.repositories).map(pathKey);
    const linked = new Set(
      (await this.store.listActivity(workspace.id)).flatMap((item) => [
        ...(item.desktopSession?.provider === 'claude' ? [item.desktopSession.sessionId] : []),
        ...(item.agentTarget?.provider === 'claude-desktop' ? [item.agentTarget.sessionId] : []),
      ]),
    );
    return [...this.claudeDesktop.values()]
      .filter(
        (session) =>
          !roots.length || roots.includes(pathKey(session.cwd)) || linked.has(session.sessionId),
      )
      .map((session) => ({
        provider: 'claude-desktop' as const,
        sessionId: session.sessionId,
        name: `${folderName(session.cwd)} · ${session.sessionId.slice(6, 14)}`,
        cwd: session.cwd,
        state: this.claudeDesktopState(session),
      }));
  }
  connectedClaudeDesktopSessions() {
    return [...this.claudeDesktop.values()].filter(
      (session) => this.claudeDesktopState(session) === 'connected',
    ).length;
  }
  registerClaudeDesktop(input: { sessionId: string; cwd: string }) {
    const existing = this.claudeDesktop.get(input.sessionId);
    // A reloaded mod has lost its token. It takes over once the old registration stops polling.
    if (existing && this.claudeDesktopState(existing) === 'connected')
      throw new StoreError('This Claude Desktop session is already connected.', 409);
    const token = randomUUID() + randomUUID();
    this.claudeDesktop.set(input.sessionId, { ...input, token, lastSeen: Date.now() });
    if (this.claudeDesktopNotices.delete(input.sessionId)) this.store.notifyAgentSettings();
    return { token };
  }
  /**
   * Records a report from a Claude Desktop session. Returns false, and keeps a notice for the
   * dashboard, when the session does not run the mod and so cannot receive messages.
   */
  noteClaudeDesktopReport(sessionId: string, workspaceId: string, title: string) {
    const session = this.claudeDesktop.get(sessionId);
    if (session && this.claudeDesktopState(session) === 'connected') {
      if (this.claudeDesktopNotices.delete(sessionId)) this.store.notifyAgentSettings();
      return true;
    }
    const existing = this.claudeDesktopNotices.get(sessionId);
    this.claudeDesktopNotices.set(sessionId, {
      sessionId,
      workspaceId,
      title,
      reportedAt: new Date().toISOString(),
    });
    if (existing?.workspaceId !== workspaceId || existing.title !== title)
      this.store.notifyAgentSettings();
    return false;
  }
  claudeDesktopNoticeList() {
    return [...this.claudeDesktopNotices.values()].sort((a, b) =>
      b.reportedAt.localeCompare(a.reportedAt),
    );
  }
  /** Applying the mod configuration answers every notice; a session that reports again raises it again. */
  clearClaudeDesktopNotices() {
    if (!this.claudeDesktopNotices.size) return;
    this.claudeDesktopNotices.clear();
    this.store.notifyAgentSettings();
  }
  private authenticateClaudeDesktop(sessionId: string, token?: string) {
    const session = this.claudeDesktop.get(sessionId);
    if (!session || !sameToken(session.token, token))
      throw new StoreError('Invalid session credential.', 401);
    return session;
  }
  /** Hands each waiting message to the mod once, as the prompt it submits. */
  async pollClaudeDesktop(sessionId: string, token?: string) {
    const session = this.authenticateClaudeDesktop(sessionId, token);
    session.lastSeen = Date.now();
    const messages: Array<{ id: string; text: string }> = [];
    for (const waiting of await this.store.pendingAgentMessages({
      provider: 'claude-desktop',
      sessionId,
    })) {
      const item = await this.store
        .getActivity(waiting.workspaceId, waiting.activityId)
        .catch(() => undefined);
      const workspace = item ? await this.store.getWorkspace(item.workspaceId) : undefined;
      const claimed = await this.store.updatePendingAgentMessage(waiting.id, {
        status: 'queued',
        detail: 'Received by the session.',
      });
      if (claimed)
        messages.push({
          id: claimed.shortId,
          text:
            desktopMessageMarker(claimed.shortId) +
            (item && workspace ? messageContext(item, workspace, claimed.text) : claimed.text),
        });
    }
    return { messages };
  }
  async claudeDesktopReceipt(
    sessionId: string,
    token: string | undefined,
    input: ClaudeDesktopOutcome,
  ) {
    this.authenticateClaudeDesktop(sessionId, token);
    const message = await this.store.findAgentMessage(input.messageId);
    if (message.target.provider !== 'claude-desktop' || message.target.sessionId !== sessionId)
      throw new StoreError('Message does not belong to this session.', 403);
    if (message.status === 'sending')
      throw new StoreError('This message was not handed to the session.', 409);
    // A late receipt never replaces a final state.
    if (message.status === 'replied' || message.status === 'failed') return message;
    const reply = input.reply?.trim() ? input.reply : undefined;
    return this.store.updateAgentMessage(
      message.id,
      input.outcome === 'started'
        ? {
            status: 'accepted',
            detail: 'Claude started a turn.',
          }
        : input.outcome === 'replied'
          ? {
              status: 'replied',
              ...(reply ? { reply } : {}),
              detail: reply ? 'Claude replied.' : 'Claude finished without a text reply.',
            }
          : input.outcome === 'stopped'
            ? {
                status: 'accepted',
                detail: `No reply: ${stopReasons[input.reason ?? ''] ?? 'the turn ended'}.`,
              }
            : {
                status: 'failed',
                detail: `Not started: ${input.reason ?? 'refused'}. Type in the session, then send again.`,
              },
    );
  }
  async directory(workspaceId: string) {
    const workspace = await this.store.getWorkspace(workspaceId);
    const sessions: AgentSession[] = await this.claudeDesktopSessions(workspace);
    const [shared, desktop] = await Promise.allSettled([
      this.codex.listSessions(),
      this.desktop ? this.desktop.listSessions(workspace.repositories) : Promise.resolve([]),
    ]);
    if (shared.status === 'fulfilled') sessions.unshift(...shared.value);
    if (desktop.status === 'fulfilled')
      sessions.unshift(
        ...desktop.value.filter(
          (session) =>
            !sessions.some(
              (existing) =>
                existing.provider === 'codex' && existing.sessionId === session.sessionId,
            ),
        ),
      );
    return {
      sessions,
      ...(shared.status === 'rejected'
        ? {
            codexError: `Shared Codex server: ${shared.reason instanceof Error ? shared.reason.message : 'Unavailable.'}`,
          }
        : {}),
      ...(desktop.status === 'rejected'
        ? {
            desktopError: `Desktop chat discovery: ${desktop.reason instanceof Error ? desktop.reason.message : 'Unavailable.'}`,
          }
        : {}),
    };
  }
  private checkDesktopMessage(message: AgentMessage): Promise<void> {
    const existing = this.desktopChecks.get(message.id);
    if (existing) return existing;
    const desktop = this.desktop;
    if (!desktop) return Promise.resolve();
    const check = this.track(
      (async () => {
        const receipt = await desktop.receipt(message);
        if (!receipt) return;
        const current = await this.store.findAgentMessage(message.id);
        if (current.status === 'replied' || current.status === 'failed') return;
        if (
          Object.entries(receipt).some(
            ([key, value]) => current[key as keyof AgentMessage] !== value,
          )
        )
          await this.store.updateAgentMessage(message.id, receipt);
      })()
        .catch(this.logError)
        .finally(() => this.desktopChecks.delete(message.id)),
    );
    this.desktopChecks.set(message.id, check);
    return check;
  }
  async conversation(workspaceId: string, activityId: string) {
    const item = await this.store.getActivity(workspaceId, activityId);
    const messages = await this.store.listAgentMessages(workspaceId, activityId);
    await Promise.all(
      messages
        .filter(
          (message) =>
            message.target.provider === 'codex-desktop' &&
            ['queued', 'accepted', 'unknown'].includes(message.status),
        )
        .map((message) => this.checkDesktopMessage(message)),
    );
    return {
      messages: await this.store.listAgentMessages(workspaceId, activityId),
      requests: [...this.requests.values()]
        .filter(
          (request) =>
            request.workspaceId === item.workspaceId &&
            item.agentTarget?.provider === 'codex' &&
            request.display.sessionId === item.agentTarget.sessionId,
        )
        .map((request) => request.display),
    };
  }
  async send(workspaceId: string, activityId: string, input: SendAgentMessage) {
    const item = await this.store.getActivity(workspaceId, activityId);
    const workspace = await this.store.getWorkspace(item.workspaceId);
    // Check before saving: the mod could otherwise pick up a message for a session outside this workspace.
    let desktopSession: AgentSession | undefined;
    if (input.target.provider === 'claude-desktop') {
      desktopSession = (await this.claudeDesktopSessions(workspace)).find(
        (session) => session.sessionId === input.target.sessionId,
      );
      if (!desktopSession)
        throw new StoreError(
          'This Claude Desktop session is not connected. Apply the mod in Agents → Agent settings.',
          409,
        );
    }
    const { message, created } = await this.store.createAgentMessage(
      workspaceId,
      activityId,
      input,
    );
    if (!created) return message; // Retries are reads, never another side effect.
    return this.track(
      (async () => {
        try {
          const context = messageContext(item, workspace, message.text);
          if (desktopSession) {
            // The mod picks the message up on its next poll; offline sessions get it when they reopen.
            return (
              (await this.store.updatePendingAgentMessage(message.id, {
                status: 'sending',
                detail:
                  desktopSession.state === 'connected'
                    ? 'Waiting for the session.'
                    : 'Session offline. Waits until it reopens.',
              })) ?? (await this.store.findAgentMessage(message.id))
            );
          }
          if (input.target.provider === 'codex-desktop') {
            if (!this.desktop) throw new DeliveryError('Codex Desktop messaging is unavailable.');
            await this.desktop.send(
              input.target.sessionId,
              desktopMessageMarker(message.shortId) + context,
              workspace.repositories,
            );
            return this.store.updateAgentMessage(message.id, {
              status: 'queued',
              detail:
                'Saved to the Codex message queue. Keep the target chat open in Desktop; busy chats process it when ready.',
            });
          }
          const messages = this.codexMessages.get(input.target.sessionId) ?? [];
          messages.push(message);
          this.codexMessages.set(input.target.sessionId, messages);
          const accepted = await this.codex.send(input.target.sessionId, context);
          message.turnId = accepted.turnId;
          const current = await this.store.findAgentMessage(message.id);
          return await this.store.updateAgentMessage(message.id, {
            status: current.status === 'replied' ? 'replied' : 'accepted',
            turnId: accepted.turnId,
            detail: current.status === 'replied' ? current.detail : accepted.detail,
          });
        } catch (error) {
          return this.store.updateAgentMessage(message.id, {
            status: error instanceof DeliveryError && error.uncertain ? 'unknown' : 'failed',
            detail: error instanceof Error ? error.message : 'Message delivery failed.',
          });
        }
      })(),
    );
  }
  async answerRequest(workspaceId: string, activityId: string, id: string, approve: boolean) {
    const item = await this.store.getActivity(workspaceId, activityId);
    const request = this.requests.get(id);
    if (
      !request ||
      request.workspaceId !== item.workspaceId ||
      item.agentTarget?.provider !== 'codex' ||
      item.agentTarget.sessionId !== request.display.sessionId
    )
      throw new StoreError('This request is no longer pending for the selected session.', 404);
    if (approve && !request.display.canApprove)
      throw new StoreError('Answer this request in Codex.', 400);
    if (approve) this.codex.respond(request.wireId, { decision: 'accept' });
    else this.decline(request.wireId, request.method);
    this.requests.delete(id);
    this.store.notifyAgents(item.workspaceId);
  }
  private async handleNotification(method: string, params: Record<string, any>) {
    if (method === 'item/started' && params.item?.id && this.codexMessages.has(params.threadId))
      this.codexItems.set(params.item.id, params.item);
    if (method === 'item/completed' && params.item?.id) this.codexItems.delete(params.item.id);
    if (method === 'serverRequest/resolved') {
      for (const [id, request] of this.requests)
        if (request.wireId === params.requestId) {
          this.requests.delete(id);
          this.store.notifyAgents(request.workspaceId);
        }
    }
    const messages = this.codexMessages.get(params.threadId) ?? [];
    if (!messages.length) return;
    if (
      method === 'item/completed' &&
      params.item?.type === 'agentMessage' &&
      (params.item.phase === 'final_answer' || !params.item.phase)
    ) {
      for (const message of messages.filter(
        (message) => !message.turnId || message.turnId === params.turnId,
      )) {
        await this.store.updateAgentMessage(message.id, {
          status: 'replied',
          reply: String(params.item.text ?? '').slice(0, 50000),
          detail: 'Codex replied in the selected chat.',
        });
      }
    }
    if (method === 'turn/completed') {
      for (const [id, request] of this.requests)
        if (request.display.sessionId === params.threadId) this.requests.delete(id);
      this.codexMessages.set(
        params.threadId,
        messages.filter((message) => message.turnId && message.turnId !== params.turn?.id),
      );
    }
    this.store.notifyAgents(messages.at(-1)!.workspaceId);
  }
  reconnect() {
    this.codex.close();
    if (this.desktop) this.desktop.close();
  }
  async close() {
    this.codex.close();
    if (this.desktop) this.desktop.close();
    await Promise.allSettled([...this.inFlight]);
  }
}
