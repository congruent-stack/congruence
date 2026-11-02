import { useEffect, useRef, useState } from 'react';
import {
  answerAgentRequest,
  getAgentConversation,
  listAgentSessions,
  sendAgentMessage,
} from '@congruence/api-client';
import type {
  Activity,
  AgentMessage,
  AgentRequest,
  AgentSession,
  AgentTarget,
} from '@congruence/contracts';
import { RefreshCw, Send } from 'lucide-react';
import { Dialog } from '../../components/Dialog';
import { Button } from '../../components/ui/button';

const providerName = {
  codex: 'Codex',
  'codex-desktop': 'Codex Desktop',
  'claude-desktop': 'Claude Code Desktop',
};
const messageStatus = {
  sending: 'Sending',
  accepted: 'Accepted',
  queued: 'Queued',
  replied: 'Replied',
  failed: 'Not delivered',
  unknown: 'Delivery unconfirmed',
};
const sessionKey = (target: AgentTarget) => `${target.provider}:${target.sessionId}`;
// A Claude Desktop report links its native session, which is also the session's message address.
function linkedTarget(item: Activity): AgentTarget | undefined {
  if (item.agentTarget) return item.agentTarget;
  if (item.desktopSession?.provider === 'claude')
    return { provider: 'claude-desktop', sessionId: item.desktopSession.sessionId };
  return undefined;
}

export function AgentMessages({ item, onClose }: { item: Activity; onClose: () => void }) {
  const linked = linkedTarget(item);
  const [sessions, setSessions] = useState<AgentSession[]>([]);
  const [codexError, setCodexError] = useState('');
  const [desktopError, setDesktopError] = useState('');
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [requests, setRequests] = useState<AgentRequest[]>([]);
  const [selected, setSelected] = useState(linked ? sessionKey(linked) : '');
  const [editingSession, setEditingSession] = useState(!linked);
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [revision, setRevision] = useState(0);
  const attempt = useRef<{ id: string; key: string } | undefined>(undefined);
  const selectionChanged = useRef(false);
  const chosen = sessions.find((session) => sessionKey(session) === selected);
  const linkedKey = linked ? sessionKey(linked) : '';
  const showPicker = editingSession || !selected;

  useEffect(() => {
    if (!selectionChanged.current) {
      setSelected(linkedKey);
      setEditingSession(!linkedKey);
    }
  }, [linkedKey]);

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;
    let refreshing = false;
    let again = false;
    let awaitingDesktopReply = false;
    let receiptTimer: ReturnType<typeof setTimeout> | undefined;
    setLoading(true);
    void listAgentSessions(item.workspaceId, { signal: controller.signal })
      .then((directory) => {
        if (!cancelled) {
          setSessions(directory.sessions);
          setCodexError(directory.codexError ?? '');
          setDesktopError(directory.desktopError ?? '');
        }
      })
      .catch((cause) => {
        if (!cancelled) setError(String(cause.message ?? cause));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    async function refreshConversation() {
      clearTimeout(receiptTimer);
      again = true;
      if (refreshing) return;
      refreshing = true;
      try {
        while (again && !cancelled) {
          again = false;
          const conversation = await getAgentConversation(item.workspaceId, item.id, {
            signal: controller.signal,
          });
          if (!cancelled) {
            setMessages(conversation.messages);
            setRequests(conversation.requests);
            awaitingDesktopReply = conversation.messages.some(
              (message) =>
                message.target.provider === 'codex-desktop' &&
                ['queued', 'accepted', 'unknown'].includes(message.status),
            );
          }
        }
      } catch (cause) {
        if (!cancelled)
          setError(cause instanceof Error ? cause.message : 'Messages could not be loaded.');
      } finally {
        refreshing = false;
        if (!cancelled && awaitingDesktopReply)
          receiptTimer = setTimeout(() => void refreshConversation(), 2000);
      }
    }
    const events = new EventSource('/api/events');
    events.onopen = () => void refreshConversation();
    events.addEventListener('change', (event: MessageEvent<string>) => {
      try {
        const change = JSON.parse(event.data);
        if (change.resource === 'agent-settings') setRevision((value) => value + 1);
        if (change.resource === 'agents' && change.workspaceId === item.workspaceId)
          void refreshConversation();
      } catch {
        /* Ignore invalid events. */
      }
    });
    return () => {
      cancelled = true;
      clearTimeout(receiptTimer);
      controller.abort();
      events.close();
    };
  }, [item.id, item.workspaceId, revision]);

  async function send(event: React.FormEvent) {
    event.preventDefault();
    if (!chosen || !text.trim() || sending) return;
    const target = { provider: chosen.provider, sessionId: chosen.sessionId };
    const key = `${selected}\n${text.trim()}`;
    if (attempt.current?.key !== key) attempt.current = { id: crypto.randomUUID(), key };
    setSending(true);
    setError('');
    try {
      const receipt = await sendAgentMessage(item.workspaceId, item.id, {
        id: attempt.current.id,
        target,
        text: text.trim(),
      });
      setMessages((current) => [
        ...current.filter((message) => message.id !== receipt.id),
        receipt,
      ]);
      setRevision((value) => value + 1);
      if (receipt.status === 'failed') {
        setError(receipt.detail);
        attempt.current = undefined;
      } else {
        setText('');
        attempt.current = undefined;
      }
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Could not confirm delivery. Retrying this unchanged message will check its existing receipt.',
      );
    } finally {
      setSending(false);
    }
  }
  async function answer(id: string, approve: boolean) {
    setError('');
    try {
      await answerAgentRequest(item.workspaceId, item.id, id, { approve });
      setRevision((value) => value + 1);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not answer the request.');
    }
  }
  return (
    <Dialog title="Message agent" onClose={onClose} wide>
      <p className="dialog-intro">{item.title}</p>
      <form className="workspace-form agent-message-form" onSubmit={(event) => void send(event)}>
        <div className="session-label-row">
          {showPicker ? (
            <label htmlFor="agent-session">Agent session</label>
          ) : (
            <span>Agent session</span>
          )}
          {showPicker ? (
            <Button
              variant="ghost"
              size="small"
              disabled={loading}
              onClick={() => setRevision((value) => value + 1)}
            >
              <RefreshCw size={13} /> Refresh sessions
            </Button>
          ) : (
            <Button
              variant="ghost"
              size="small"
              onClick={() => {
                selectionChanged.current = true;
                setEditingSession(true);
                setRevision((value) => value + 1);
              }}
            >
              Change
            </Button>
          )}
        </div>
        {showPicker ? (
          <select
            id="agent-session"
            value={selected}
            disabled={loading || sessions.length === 0}
            onChange={(event) => {
              selectionChanged.current = true;
              setSelected(event.target.value);
              if (event.target.value) setEditingSession(false);
              setError('');
            }}
          >
            <option value="">
              {loading
                ? 'Loading sessions…'
                : sessions.length === 0
                  ? 'No sessions found'
                  : 'Select a session'}
            </option>
            {selected && !chosen && (
              <option value={selected}>Previously selected session · unavailable</option>
            )}
            {sessions.map((session) => (
              <option key={sessionKey(session)} value={sessionKey(session)}>
                {providerName[session.provider]} · {session.name} · {session.state}
              </option>
            ))}
          </select>
        ) : (
          <div className="linked-session" role="group" aria-label="Linked agent session">
            <strong>
              {chosen
                ? `${providerName[chosen.provider]} · ${chosen.name}`
                : loading
                  ? 'Loading linked chat…'
                  : 'Linked chat unavailable'}
            </strong>
            {!loading && !chosen && (
              <p className="field-hint">
                {selected.startsWith('claude-desktop:')
                  ? 'Not connected. Apply the mod in Agents → Agent settings.'
                  : 'Use Change to refresh the session list or choose another chat.'}
              </p>
            )}
          </div>
        )}
        {chosen && <p className="field-hint session-path">{chosen.cwd || chosen.sessionId}</p>}
        {codexError && (!selected || selected.startsWith('codex:')) && (
          <p className="field-hint">{codexError}</p>
        )}
        {desktopError && <p className="field-hint">{desktopError}</p>}
        {!loading && sessions.length === 0 && (
          <div className="session-empty" role="status">
            <strong>No agent sessions found</strong>
            <p>
              Open a Codex Desktop chat in one of this workspace’s repository folders, then refresh
              this list. Workspaces without local repository paths show recent local chats.
            </p>
            <p>
              You can also connect Codex CLI through a shared App Server, or Claude Code Desktop
              through the Congruence mod. Use Agents for setup instructions.
            </p>
          </div>
        )}
        {chosen?.provider === 'codex-desktop' && (
          <p className="field-hint">
            Keep this chat open in Codex Desktop. Busy chats process queued messages when ready.{' '}
            <a
              className="text-link"
              href={`codex://threads/${encodeURIComponent(chosen.sessionId)}`}
            >
              Open chat in Desktop
            </a>
          </p>
        )}
        {chosen?.provider === 'claude-desktop' && (
          <p className="field-hint">
            {chosen.state === 'offline' && 'Offline. Messages wait until the session reopens. '}
            <a
              className="text-link"
              href={`claude://code/continue?session=${encodeURIComponent(chosen.sessionId)}`}
            >
              Open session in Claude
            </a>
          </p>
        )}
        {chosen?.provider === 'codex' && (
          <p className="field-hint">
            Active chats receive steering input. Idle chats start a new turn in the same runtime.
          </p>
        )}
        <label htmlFor="agent-message">Message</label>
        <textarea
          id="agent-message"
          rows={4}
          maxLength={10000}
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder="Ask a question or give the agent its next instruction…"
          required
        />
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="message-actions">
          <Button
            type="submit"
            disabled={
              sending ||
              !text.trim() ||
              !chosen ||
              (chosen.state === 'offline' && chosen.provider !== 'claude-desktop') ||
              loading
            }
          >
            <Send size={14} />
            {sending
              ? 'Sending…'
              : chosen
                ? `Send to ${providerName[chosen.provider]}`
                : 'Send message'}
          </Button>
        </div>
      </form>
      {requests
        .filter((request) => chosen?.provider === 'codex' && request.sessionId === chosen.sessionId)
        .map((request) => (
          <div className="agent-request" key={request.id}>
            <strong>{request.title}</strong>
            <pre>{request.detail}</pre>
            <div className="message-actions">
              <Button
                variant="secondary"
                size="small"
                onClick={() => void answer(request.id, false)}
              >
                Decline
              </Button>
              {request.canApprove && (
                <Button size="small" onClick={() => void answer(request.id, true)}>
                  Approve once
                </Button>
              )}
            </div>
          </div>
        ))}
      {messages.length > 0 && (
        <section className="message-history" aria-label="Message history">
          <h3>Messages from Congruence</h3>
          {messages.map((message) => (
            <article key={message.id} className="agent-message">
              <div className="message-heading">
                <span>{providerName[message.target.provider]}</span>
                <span className={`delivery-${message.status}`}>
                  {messageStatus[message.status]}
                </span>
              </div>
              <p>{message.text}</p>
              <small>{message.detail}</small>
              {message.reply && (
                <div className="agent-reply">
                  <strong>Agent reply</strong>
                  <p>{message.reply}</p>
                </div>
              )}
              <time dateTime={message.createdAt}>
                {new Date(message.createdAt).toLocaleString()}
              </time>
            </article>
          ))}
        </section>
      )}
    </Dialog>
  );
}
