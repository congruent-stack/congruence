import type { DashboardRun } from '@congruence/contracts';
import { ExternalLink } from 'lucide-react';
import { CopyBlock } from '../../components/CopyBlock';

const statusLabels: Record<DashboardRun['status'], string> = {
  prepared: 'Ready to open',
  running: 'Running',
  queued: 'Queued',
  succeeded: 'Completed',
  failed: 'Failed',
  interrupted: 'Interrupted',
  linked: 'Session linked',
};

function launchLink(run: DashboardRun) {
  if (run.status !== 'prepared' || !run.launchUrl || run.destination?.kind !== 'desktop')
    return undefined;
  try {
    const link = new URL(run.launchUrl);
    const codex = run.destination.provider === 'codex-desktop';
    return link.protocol === (codex ? 'codex:' : 'claude:') &&
      link.hostname === (codex ? 'threads' : 'code') &&
      link.pathname === '/new'
      ? link.href
      : undefined;
  } catch {
    return undefined;
  }
}

export function DashboardRunDetails({ run }: { run: DashboardRun }) {
  const href = launchLink(run);
  return (
    <div className="dashboard-run-detail">
      <p role="status">{run.detail}</p>
      {href && (
        <>
          <a className="button button-primary" href={href}>
            <ExternalLink size={15} aria-hidden="true" />
            Open in{' '}
            {run.destination?.kind === 'desktop' && run.destination.provider === 'codex-desktop'
              ? 'Codex'
              : 'Claude'}
          </a>
          <p className="field-hint">
            This fills a new Desktop composer. Check the project or environment, model, and effort,
            then press Send there. The activity appears after the agent links its actual session.
          </p>
        </>
      )}
      {run.prompt && (
        <details>
          <summary>Prepared prompt</summary>
          <CopyBlock value={run.prompt} label="prepared prompt" />
        </details>
      )}
      {run.result !== undefined && (
        <pre className="dashboard-json">{JSON.stringify(run.result, null, 2)}</pre>
      )}
    </div>
  );
}

export function DashboardRuns({ runs, error }: { runs: DashboardRun[]; error?: string }) {
  return (
    <details className="dashboard-runs">
      <summary>
        Command history <span>{runs.length}</span>
      </summary>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {!runs.length && !error && <p className="field-hint">Reviewed commands will appear here.</p>}
      {runs.map((run) => (
        <details className="dashboard-run" key={run.id}>
          <summary>
            <strong>{run.command.label}</strong>
            <span className={`dashboard-run-status dashboard-run-${run.status}`}>
              {statusLabels[run.status]}
            </span>
            <time dateTime={run.createdAt}>{new Date(run.createdAt).toLocaleString()}</time>
          </summary>
          <DashboardRunDetails run={run} />
        </details>
      ))}
    </details>
  );
}
