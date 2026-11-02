import { useEffect, useRef, useState } from 'react';
import type { Activity, DashboardRun, DashboardSummary, Workspace } from '@congruence/contracts';
import { DashboardReview, type CommandRequest } from './DashboardReview';
import { DashboardRuns } from './DashboardRuns';
import { dashboardApi, errorMessage } from './client';

interface PendingCommand {
  requestId: string;
  request: CommandRequest;
  respond: (result?: DashboardRun, error?: string) => void;
  settled: boolean;
  runId?: string;
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function DashboardFrame({
  workspace,
  dashboard,
  activities,
}: {
  workspace: Workspace;
  dashboard: DashboardSummary;
  activities: Activity[];
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const pending = useRef<PendingCommand | undefined>(undefined);
  const [review, setReview] = useState<PendingCommand>();
  const [runs, setRuns] = useState<DashboardRun[]>([]);
  const [runsError, setRunsError] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [frameError, setFrameError] = useState('');

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const result = await dashboardApi.runs(workspace.id, dashboard.id, controller.signal);
        if (!cancelled) {
          setRuns(result);
          setRunsError('');
        }
      } catch (cause) {
        if (!cancelled) setRunsError(errorMessage(cause));
      } finally {
        if (!cancelled) timer = setTimeout(() => void poll(), 2500);
      }
    }
    void poll();
    return () => {
      cancelled = true;
      controller.abort();
      clearTimeout(timer);
    };
  }, [workspace.id, dashboard.id]);

  useEffect(() => {
    let disposed = false;
    function receive(event: MessageEvent<unknown>) {
      if (!frame.current?.contentWindow || event.source !== frame.current.contentWindow) return;
      const message = event.data;
      if (
        !record(message) ||
        message.source !== 'congruence-dashboard' ||
        typeof message.requestId !== 'string'
      )
        return;
      const target = frame.current.contentWindow;
      const respond = (result?: unknown, error?: string) => {
        if (!disposed)
          target.postMessage(
            { source: 'congruence-host', requestId: message.requestId, result, error },
            '*',
          );
      };
      if (message.version !== dashboard.version) {
        respond(
          undefined,
          'This dashboard version has changed. Refresh the dashboard and review again.',
        );
        return;
      }
      if (!record(message.input)) {
        respond(undefined, 'Command inputs must be an object.');
        return;
      }
      const input = message.input;
      const version = dashboard.version!;
      if (message.method === 'read' && typeof message.query === 'string') {
        void dashboardApi
          .read(workspace.id, dashboard.id, { version, query: message.query, input })
          .then(
            (result) => respond(result.data),
            (cause: unknown) => respond(undefined, errorMessage(cause)),
          );
      } else if (message.method === 'reviewCommand' && typeof message.commandId === 'string') {
        if (pending.current) {
          respond(undefined, 'Finish or close the current command review first.');
          return;
        }
        if (!dashboard.commands.some((command) => command.id === message.commandId)) {
          respond(undefined, 'This command is not declared by the dashboard.');
          return;
        }
        if (message.prompt !== undefined && typeof message.prompt !== 'string') {
          respond(undefined, 'The prompt must be text.');
          return;
        }
        const next: PendingCommand = {
          requestId: message.requestId,
          request: {
            version,
            commandId: message.commandId,
            input,
            ...(typeof message.prompt === 'string' ? { prompt: message.prompt } : {}),
          },
          respond,
          settled: false,
        };
        pending.current = next;
        setReview(next);
      } else {
        respond(undefined, 'This dashboard operation is not supported.');
      }
    }
    window.addEventListener('message', receive);
    return () => {
      pending.current?.respond(undefined, 'The dashboard was closed.');
      pending.current = undefined;
      disposed = true;
      window.removeEventListener('message', receive);
    };
  }, [workspace.id, dashboard.id, dashboard.version, dashboard.commands]);

  function closeReview() {
    if (pending.current && !pending.current.settled)
      pending.current.respond(undefined, 'Command review cancelled.');
    pending.current = undefined;
    setReview(undefined);
  }

  const command = review && dashboard.commands.find((item) => item.id === review.request.commandId);
  // Only this dashboard's versioned, same-origin asset route may be embedded.
  const assetRoot = `/api/workspaces/${encodeURIComponent(workspace.id)}/dashboards/${encodeURIComponent(dashboard.id)}/versions/${encodeURIComponent(dashboard.version ?? '')}/assets/`;
  const frameUrl = dashboard.frameUrl?.startsWith(assetRoot) ? dashboard.frameUrl : undefined;
  return (
    <>
      {dashboard.error && (
        <p className="dashboard-warning" role="alert">
          {dashboard.error}
          {dashboard.version ? ' Showing the last published version.' : ''}
        </p>
      )}
      {frameUrl ? (
        <div className="dashboard-frame-wrap">
          {!loaded && !frameError && (
            <p className="dashboard-frame-loading" role="status">
              Loading {dashboard.name}…
            </p>
          )}
          {frameError && (
            <p className="dashboard-warning" role="alert">
              {frameError}
            </p>
          )}
          <iframe
            ref={frame}
            src={frameUrl}
            title={`${dashboard.name} dashboard`}
            className="dashboard-frame"
            sandbox="allow-scripts"
            onLoad={() => setLoaded(true)}
            onError={() => setFrameError('This dashboard could not load. Refresh to try again.')}
          />
        </div>
      ) : (
        <div className="dashboard-unpublished">
          <h3>
            {dashboard.status === 'draft'
              ? 'This dashboard is still being built'
              : 'Dashboard unavailable'}
          </h3>
          <p>
            {dashboard.status === 'draft'
              ? 'Ask your agent to publish it, then refresh this page.'
              : 'Ask your agent to publish a working version, then refresh.'}
          </p>
        </div>
      )}
      <DashboardRuns runs={runs} error={runsError} />
      {review && command && (
        <DashboardReview
          key={review.requestId}
          workspace={workspace}
          dashboard={dashboard}
          command={command}
          request={review.request}
          activities={activities}
          latestRun={runs.find((item) => item.id === review.runId)}
          onClose={closeReview}
          onRun={(run) => {
            review.runId = run.id;
            setRuns((current) => [run, ...current.filter((item) => item.id !== run.id)]);
            if (!review.settled) {
              review.settled = true;
              review.respond(run);
            }
          }}
        />
      )}
    </>
  );
}
