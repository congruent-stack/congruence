import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Info } from 'lucide-react';
import {
  decideAgentSettingsRequest,
  deleteAgentSettingsRequest,
  getAgentSettingsReview,
  reapplyAgentSettingsRequest,
} from '@congruence/api-client';
import type { AgentSettings, AgentSettingsRequest, Workspace } from '@congruence/contracts';
import { Button } from '../components/ui/button';

const hostNames = {
  'codex-desktop': 'Codex Desktop app',
  'codex-cli': 'Codex CLI',
};
const fieldNames: Record<keyof AgentSettings, string> = {
  codexCommand: 'Codex executable',
  codexUrl: 'Shared App Server URL',
  codexSocket: 'Control socket',
};

export type AgentProvider = 'codex-desktop' | 'codex';
export function requestProvider(request: AgentSettingsRequest): AgentProvider {
  return request.host === 'codex-desktop' ? 'codex-desktop' : 'codex';
}

/** What needs the human in Agent settings: pending Codex Desktop requests and sessions without the mod. */
export function settingsAttention(review?: Awaited<ReturnType<typeof getAgentSettingsReview>>) {
  const codexDesktop =
    review?.requests.filter(
      (request) => request.status === 'pending' && requestProvider(request) === 'codex-desktop',
    ).length ?? 0;
  const missingMod = review?.claudeDesktopNotices?.length ?? 0;
  return {
    codexDesktop,
    claudeDesktop: missingMod,
    requests: codexDesktop,
    missingMod,
    total: codexDesktop + missingMod,
  };
}
export const missingModText = (count: number) =>
  `${count} Claude Desktop ${count === 1 ? 'session needs' : 'sessions need'} the Congruence mod`;

export function useAgentSettingsReview() {
  const [review, setReview] = useState<Awaited<ReturnType<typeof getAgentSettingsReview>>>();
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision((value) => value + 1), []);
  useEffect(() => {
    const controller = new AbortController();
    let busy = false;
    let again = false;
    async function sync() {
      again = true;
      if (busy) return;
      busy = true;
      try {
        while (again && !controller.signal.aborted) {
          again = false;
          const next = await getAgentSettingsReview({ signal: controller.signal });
          if (!controller.signal.aborted) {
            setReview(next);
            setError('');
          }
        }
      } catch (cause) {
        if (!controller.signal.aborted)
          setError(
            cause instanceof Error ? cause.message : 'Settings requests could not be loaded.',
          );
      } finally {
        busy = false;
      }
    }
    const events = new EventSource('/api/events');
    events.onopen = () => void sync();
    events.addEventListener('change', (event: MessageEvent<string>) => {
      try {
        if (JSON.parse(event.data).resource === 'agent-settings') void sync();
      } catch {
        /* Ignore malformed events. */
      }
    });
    events.onerror = () => setError('Connection lost. Reconnecting to load settings requests…');
    return () => {
      controller.abort();
      events.close();
    };
  }, [revision]);
  return { review, error, refresh };
}

export function AgentSettingsReview({
  state,
  workspaces,
  onApplied,
  provider,
  showHistory = true,
  children,
}: {
  state: ReturnType<typeof useAgentSettingsReview>;
  workspaces: Workspace[];
  onApplied: () => void;
  provider: AgentProvider;
  showHistory?: boolean;
  children: ReactNode;
}) {
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [deleting, setDeleting] = useState('');
  const historyRef = useRef<HTMLDetailsElement>(null);
  const scopeHintId = useId();
  const requests = (state.review?.requests ?? [])
    .filter((request) => requestProvider(request) === provider)
    .sort(
      (a, b) =>
        Number(b.status === 'pending') - Number(a.status === 'pending') ||
        (b.decidedAt ?? b.createdAt).localeCompare(a.decidedAt ?? a.createdAt),
    );
  async function act(
    id: string,
    operation: () => Promise<unknown>,
    success: string,
    appliesSettings = false,
  ) {
    if (busy) return;
    setBusy(id);
    setError('');
    setMessage('');
    try {
      await operation();
      if (appliesSettings) onApplied();
      state.refresh();
      setDeleting('');
      setMessage(success);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The change could not be saved.');
      state.refresh();
    } finally {
      setBusy('');
    }
  }
  function decide(request: AgentSettingsRequest, decision: 'approve' | 'reject') {
    return act(
      request.id,
      () => decideAgentSettingsRequest(request.id, { decision }),
      decision === 'approve'
        ? 'Approved. Connection settings have been applied.'
        : 'Rejected. Connection settings were not changed.',
      decision === 'approve',
    );
  }
  function reapply(request: AgentSettingsRequest) {
    if (!state.review) return;
    const input = { id: crypto.randomUUID(), expectedSettings: state.review.settings };
    return act(
      request.id,
      () => reapplyAgentSettingsRequest(request.id, input),
      'Saved settings applied.',
      true,
    );
  }
  function remove(request: AgentSettingsRequest) {
    return act(
      request.id,
      async () => {
        await deleteAgentSettingsRequest(request.id);
        historyRef.current?.querySelector('summary')?.focus();
      },
      'Request deleted.',
    );
  }
  const pending = requests.filter((request) => request.status === 'pending');
  const history = requests.filter((request) => request.status !== 'pending');
  function renderRequest(request: AgentSettingsRequest) {
    const keys = Object.keys(request.changes) as Array<keyof AgentSettings>;
    const past = request.status !== 'pending';
    const inUse = keys.every((key) => state.review?.settings[key] === request.changes[key]);
    const stale =
      request.status === 'pending' &&
      keys.some((key) => state.review?.settings[key] !== request.baseSettings[key]);
    return (
      <section
        className="settings-request"
        key={request.id}
        aria-label={`Settings request from ${hostNames[request.host]}`}
      >
        <div className="settings-request-heading">
          <h3>{hostNames[request.host]}</h3>
          <span className="settings-request-status">
            {request.status === 'pending'
              ? (workspaces.find((workspace) => workspace.id === request.workspaceId)?.name ??
                request.workspaceId)
              : request.reappliedFrom
                ? 'Reapplied'
                : request.status === 'approved'
                  ? 'Approved'
                  : 'Rejected'}
          </span>
        </div>
        <p>{request.reason}</p>
        {request.decidedAt && (
          <p className="field-hint">
            <time dateTime={request.decidedAt}>{new Date(request.decidedAt).toLocaleString()}</time>
          </p>
        )}
        <dl className="settings-diff">
          {keys.map((key) => (
            <div key={key}>
              <dt>{fieldNames[key]}</dt>
              <dd>
                <span>{past ? 'Current' : 'Before'}</span>
                <code>
                  {(past ? state.review?.settings[key] : request.baseSettings[key]) || 'Not set'}
                </code>
              </dd>
              <dd>
                <span>{past ? 'Saved' : 'Proposed'}</span>
                <code>{request.changes[key] || 'Not set'}</code>
              </dd>
              {stale && state.review?.settings[key] !== request.baseSettings[key] && (
                <dd>
                  <span>Current</span>
                  <code>{state.review?.settings[key] || 'Not set'}</code>
                </dd>
              )}
            </div>
          ))}
        </dl>
        <details>
          <summary>Details</summary>
          <p className="settings-evidence">{request.evidence}</p>
          <p className="field-hint">
            Workspace:{' '}
            {workspaces.find((workspace) => workspace.id === request.workspaceId)?.name ??
              request.workspaceId}
          </p>
          {request.sessionId && <p className="field-hint">Session: {request.sessionId}</p>}
          {past && (
            <dl className="settings-diff">
              {keys.map((key) => (
                <div key={key}>
                  <dt>{fieldNames[key]} before this request</dt>
                  <dd>
                    <span>Original</span>
                    <code>{request.baseSettings[key] || 'Not set'}</code>
                  </dd>
                </div>
              ))}
            </dl>
          )}
        </details>
        {stale && (
          <p className="form-error">
            These settings have changed since the request was made. Reject it and ask the agent for
            an updated proposal.
          </p>
        )}
        {request.status === 'pending' && (
          <div className="settings-request-actions">
            <Button
              variant="ghost"
              disabled={Boolean(busy)}
              onClick={() => void decide(request, 'reject')}
            >
              Reject
            </Button>
            <Button
              disabled={Boolean(busy) || stale || Boolean(state.error)}
              onClick={() => void decide(request, 'approve')}
            >
              {busy === request.id ? 'Saving…' : 'Approve and apply'}
            </Button>
          </div>
        )}
        {past &&
          (deleting === request.id ? (
            <div className="settings-delete-confirmation">
              <p>Delete this request? Current settings stay unchanged.</p>
              <div className="settings-request-actions">
                <Button variant="ghost" disabled={Boolean(busy)} onClick={() => setDeleting('')}>
                  Cancel
                </Button>
                <Button
                  variant="secondary"
                  disabled={Boolean(busy)}
                  onClick={() => void remove(request)}
                >
                  {busy === request.id ? 'Deleting…' : 'Delete request'}
                </Button>
              </div>
            </div>
          ) : (
            <div className="settings-request-actions">
              <Button
                variant="ghost"
                disabled={Boolean(busy)}
                onClick={() => setDeleting(request.id)}
              >
                Delete
              </Button>
              <Button
                variant="secondary"
                disabled={Boolean(busy) || Boolean(state.error) || inUse}
                onClick={() => void reapply(request)}
              >
                {busy === request.id ? 'Applying…' : inUse ? 'In use' : 'Reapply'}
              </Button>
            </div>
          ))}
      </section>
    );
  }
  return (
    <>
      <p className="field-hint settings-guidance">
        <span className="settings-info">
          <button
            type="button"
            className="settings-info-trigger"
            aria-label="Settings scope"
            aria-describedby={scopeHintId}
          >
            <Info size={16} aria-hidden="true" />
          </button>
          <span role="tooltip" id={scopeHintId}>
            Changes apply to all workspaces.
          </span>
        </span>
        <span>
          Agents can propose these settings through Congruence MCP. Review and approve them here.
        </span>
      </p>
      {(error || state.error) && (
        <p className="form-error" role="alert">
          {error || state.error}
        </p>
      )}
      {message && (
        <p role="status" className="field-hint">
          {message}
        </p>
      )}
      {!state.review && !state.error && <p role="status">Loading settings requests…</p>}
      {pending.length > 0 && (
        <section className="settings-approvals" aria-label="Needs approval">
          <h3>Needs approval</h3>
          {pending.map(renderRequest)}
        </section>
      )}
      {children}
      {showHistory && (
        <details className="settings-history" ref={historyRef} aria-label="Past requests">
          <summary>
            Past requests <span className="count-badge">{history.length}</span>
          </summary>
          {history.map(renderRequest)}
          {state.review && history.length === 0 && (
            <div className="settings-history-empty">
              <p>No past requests</p>
              <p className="field-hint">
                Approved and rejected requests for this agent will appear here.
              </p>
            </div>
          )}
        </details>
      )}
    </>
  );
}
