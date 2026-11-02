import { useEffect, useId, useState, type FormEvent } from 'react';
import type {
  Activity,
  DashboardCommand,
  DashboardDestination,
  DashboardPreview,
  DashboardPreviewInput,
  DashboardRun,
  DashboardSummary,
  Workspace,
} from '@congruence/contracts';
import { Dialog } from '../../components/Dialog';
import { Button } from '../../components/ui/button';
import { dashboardApi, errorMessage } from './client';
import { DashboardRunDetails } from './DashboardRuns';

export type CommandRequest = Pick<
  DashboardPreviewInput,
  'version' | 'commandId' | 'input' | 'prompt'
>;

function isLocalPath(path: string) {
  return /^(?:[a-z]:[\\/]|\/|\\\\)/i.test(path);
}

export function DashboardReview({
  workspace,
  dashboard,
  command,
  request,
  activities,
  latestRun,
  onRun,
  onClose,
}: {
  workspace: Workspace;
  dashboard: DashboardSummary;
  command: DashboardCommand;
  request: CommandRequest;
  activities: Activity[];
  latestRun?: DashboardRun;
  onRun: (run: DashboardRun) => void;
  onClose: () => void;
}) {
  const id = useId();
  const available = activities.filter(
    (activity) => activity.agentTarget || activity.desktopSession,
  );
  const folders = workspace.repositories.filter(isLocalPath);
  const [kind, setKind] = useState<'activity' | 'desktop'>(
    available.length ? 'activity' : 'desktop',
  );
  const [activityId, setActivityId] = useState(available[0]?.id ?? '');
  const [provider, setProvider] = useState<'codex-desktop' | 'claude-desktop'>('codex-desktop');
  const [folder, setFolder] = useState(folders[0] ?? '');
  const [title, setTitle] = useState(command.label);
  const [preview, setPreview] = useState<DashboardPreview>();
  const [run, setRun] = useState<DashboardRun>();
  const currentRun = run && latestRun?.id === run.id ? latestRun : run;
  const [busy, setBusy] = useState<'preview' | 'execute'>();
  const [error, setError] = useState('');
  const destination: DashboardDestination | undefined =
    command.type !== 'agent'
      ? undefined
      : kind === 'activity'
        ? { kind, activityId }
        : { kind, provider, folder: folder.trim(), title: title.trim() };
  const reviewedActivityId =
    preview?.destination?.kind === 'activity' ? preview.destination.activityId : undefined;

  // Backend commands already have all their routing information, so show their review directly.
  useEffect(() => {
    if (command.type !== 'backend') return;
    let cancelled = false;
    setBusy('preview');
    dashboardApi
      .preview(workspace.id, dashboard.id, request)
      .then(
        (value) => {
          if (!cancelled) setPreview(value);
        },
        (cause: unknown) => {
          if (!cancelled) setError(errorMessage(cause));
        },
      )
      .finally(() => {
        if (!cancelled) setBusy(undefined);
      });
    return () => {
      cancelled = true;
    };
  }, [command.type, workspace.id, dashboard.id, request]);

  async function prepare(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setError('');
    setBusy('preview');
    try {
      setPreview(
        await dashboardApi.preview(workspace.id, dashboard.id, { ...request, destination }),
      );
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(undefined);
    }
  }

  async function execute() {
    if (!preview || busy) return;
    setError('');
    setBusy('execute');
    try {
      const result = await dashboardApi.execute(workspace.id, dashboard.id, {
        previewId: preview.id,
        destination: preview.destination,
      });
      setRun(result);
      onRun(result);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(undefined);
    }
  }

  return (
    <Dialog
      title={
        currentRun
          ? currentRun.status === 'prepared'
            ? 'Open your prepared session'
            : 'Command submitted'
          : 'Review command'
      }
      wide
      className="dashboard-review"
      onClose={() => {
        if (busy !== 'execute') onClose();
      }}
    >
      <p className="dialog-intro">
        {dashboard.name} · {command.label}
      </p>
      {currentRun ? (
        <>
          <DashboardRunDetails run={currentRun} />
          <div className="dialog-footer">
            <Button onClick={onClose}>Done</Button>
          </div>
        </>
      ) : preview ? (
        <>
          <div className="dashboard-review-content">
            <p>{preview.summary}</p>
            {preview.destination?.kind === 'activity' && (
              <p className="dashboard-destination-summary">
                Send to activity:{' '}
                <strong>
                  {activities.find((item) => item.id === reviewedActivityId)?.title ??
                    reviewedActivityId}
                </strong>
              </p>
            )}
            {preview.destination?.kind === 'desktop' && (
              <div className="dashboard-destination-summary">
                <p>
                  Prepare a new{' '}
                  {preview.destination.provider === 'codex-desktop' ? 'Codex' : 'Claude'} Desktop
                  session
                </p>
                <p>
                  Activity: <strong>{preview.destination.title}</strong>
                </p>
                <p>
                  Folder: <code>{preview.destination.folder || 'Choose in Desktop'}</code>
                </p>
              </div>
            )}
            {preview.prompt !== undefined && (
              <section aria-labelledby={`${id}-prompt`}>
                <h3 id={`${id}-prompt`}>Assembled prompt</h3>
                <pre className="dashboard-json dashboard-prompt">{preview.prompt}</pre>
              </section>
            )}
            <section aria-labelledby={`${id}-inputs`}>
              <h3 id={`${id}-inputs`}>Resolved inputs</h3>
              <pre className="dashboard-json">{JSON.stringify(preview.input, null, 2)}</pre>
            </section>
            <p className="field-hint">
              {preview.destination?.kind === 'desktop'
                ? 'You will open the prepared prompt, choose model and effort in Desktop, and press Send there.'
                : 'Confirming runs this command with the inputs shown above.'}
            </p>
          </div>
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <div className="dialog-footer">
            {command.type === 'agent' && (
              <Button
                variant="ghost"
                disabled={Boolean(busy)}
                onClick={() => {
                  setPreview(undefined);
                  setError('');
                }}
              >
                Change destination
              </Button>
            )}
            <Button variant="secondary" disabled={busy === 'execute'} onClick={onClose}>
              Cancel
            </Button>
            <Button onClick={() => void execute()} disabled={Boolean(busy)}>
              {busy === 'execute'
                ? 'Submitting…'
                : preview.destination?.kind === 'desktop'
                  ? 'Prepare session'
                  : 'Run command'}
            </Button>
          </div>
        </>
      ) : (
        <form onSubmit={(event) => void prepare(event)} className="dashboard-command-form">
          {command.type === 'agent' && (
            <fieldset disabled={Boolean(busy)}>
              <legend>Where should this prompt go?</legend>
              <label htmlFor={`${id}-destination`}>Destination</label>
              <select
                id={`${id}-destination`}
                value={kind}
                onChange={(event) => setKind(event.target.value as 'activity' | 'desktop')}
              >
                <option value="activity" disabled={!available.length}>
                  Existing activity{!available.length ? ' — none linked' : ''}
                </option>
                <option value="desktop">New Desktop session</option>
              </select>
              {kind === 'activity' ? (
                <>
                  <label htmlFor={`${id}-activity`}>Activity</label>
                  <select
                    id={`${id}-activity`}
                    value={activityId}
                    required
                    onChange={(event) => setActivityId(event.target.value)}
                  >
                    <option value="" disabled>
                      Choose an activity
                    </option>
                    {available.map((activity) => (
                      <option key={activity.id} value={activity.id}>
                        {activity.title}
                        {activity.subtitle ? ` · ${activity.subtitle}` : ''}
                      </option>
                    ))}
                  </select>
                  <p className="field-hint">
                    The prompt goes to this activity’s linked agent session.
                  </p>
                </>
              ) : (
                <>
                  <label htmlFor={`${id}-provider`}>Desktop app</label>
                  <select
                    id={`${id}-provider`}
                    value={provider}
                    onChange={(event) => setProvider(event.target.value as typeof provider)}
                  >
                    <option value="codex-desktop">Codex</option>
                    <option value="claude-desktop">Claude</option>
                  </select>
                  <label htmlFor={`${id}-title`}>New activity title</label>
                  <input
                    id={`${id}-title`}
                    value={title}
                    onChange={(event) => setTitle(event.target.value)}
                    maxLength={120}
                    required
                    pattern=".*\S.*"
                  />
                  <label htmlFor={`${id}-folder`}>
                    Project folder <span className="optional">optional</span>
                  </label>
                  <input
                    id={`${id}-folder`}
                    value={folder}
                    onChange={(event) => setFolder(event.target.value)}
                    list={`${id}-folders`}
                    maxLength={2000}
                    placeholder="Absolute local folder"
                  />
                  <datalist id={`${id}-folders`}>
                    {folders.map((path) => (
                      <option key={path} value={path} />
                    ))}
                  </datalist>
                  <p className="field-hint">
                    Check the project or environment, model, and effort in Desktop before sending.
                    Leave the folder empty to choose it there.
                  </p>
                </>
              )}
            </fieldset>
          )}
          {busy === 'preview' && (
            <p className="field-hint" role="status">
              Preparing the command for review…
            </p>
          )}
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <div className="dialog-footer">
            <Button variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={Boolean(busy)}>
              {busy ? 'Preparing…' : command.type === 'backend' ? 'Retry review' : 'Review command'}
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}
