import { useEffect, useMemo, useState } from 'react';
import { listActivityVersions } from '@congruence/api-client';
import type { Activity } from '@congruence/contracts';
import { RefreshCw } from 'lucide-react';
import { Dialog } from '../../components/Dialog';
import { Button } from '../../components/ui/button';
import { VersionTimeline } from './VersionTimeline';
import { alignText, type DiffLine } from './content-diff';
import { ActivityMarkdown } from './ActivityMarkdown';

const fields: { label: string; value: (item: Activity) => string }[] = [
  { label: 'Subtitle', value: (item) => item.subtitle },
  { label: 'Summary', value: (item) => item.summary },
  {
    label: 'Status',
    value: (item) =>
      ({ in_progress: 'In progress', blocked: 'Blocked', done: 'Done' })[item.status],
  },
  { label: 'Source', value: (item) => item.source },
  { label: 'Source link', value: (item) => item.sourceUrl ?? '' },
  {
    label: 'Agent session',
    value: (item) =>
      item.agentTarget ? `${item.agentTarget.provider} / ${item.agentTarget.sessionId}` : '',
  },
  {
    label: 'Desktop session',
    value: (item) =>
      item.desktopSession
        ? `${item.desktopSession.provider} / ${item.desktopSession.sessionId}`
        : '',
  },
];

function DifferenceCell({
  label,
  side,
  line,
}: {
  label: string;
  side: 'before' | 'after';
  line: DiffLine | null;
}) {
  const Change = side === 'before' ? 'del' : 'ins';
  return (
    <td
      className={`history-diff-cell history-${side}`}
      aria-label={`${label} ${side} ${line ? `line ${line.lineNumber}` : 'spacer'}`}
      data-empty={line === null ? true : undefined}
    >
      {line ? (
        <div className="history-diff-line">
          <span className="history-line-number" aria-hidden="true">
            {line.lineNumber}
          </span>
          <p className="history-line-text">
            {line.text
              ? line.fragments.map((part, index) =>
                  part.changed ? (
                    <Change key={index}>{part.text}</Change>
                  ) : (
                    <span key={index}>{part.text}</span>
                  ),
                )
              : '\u00a0'}
          </p>
        </div>
      ) : (
        <div className="history-diff-spacer" aria-hidden="true" />
      )}
    </td>
  );
}

function DifferenceField({
  label,
  before,
  after,
}: {
  label: string;
  before: string;
  after: string;
}) {
  const [renderMarkdown, setRenderMarkdown] = useState(false);
  const rows = useMemo(() => alignText(before, after), [before, after]);
  return (
    <section
      className={`history-field ${before === after ? 'history-unchanged' : ''}`}
      aria-label={label}
    >
      <h3>
        {label}
        {before === after && <span>Unchanged</span>}
        {label === 'Summary' && (
          <label className="history-markdown-toggle">
            <input
              type="checkbox"
              checked={renderMarkdown}
              onChange={(event) => setRenderMarkdown(event.target.checked)}
            />
            Render Markdown
          </label>
        )}
      </h3>
      {label === 'Summary' && renderMarkdown ? (
        <div className="history-summary-previews">
          <section className="history-summary-preview" aria-label="Summary before preview">
            <h4>Before</h4>
            {before.trim() ? (
              <ActivityMarkdown>{before}</ActivityMarkdown>
            ) : (
              <p className="history-not-set">Not set</p>
            )}
          </section>
          <section className="history-summary-preview" aria-label="Summary after preview">
            <h4>After</h4>
            {after.trim() ? (
              <ActivityMarkdown>{after}</ActivityMarkdown>
            ) : (
              <p className="history-not-set">Not set</p>
            )}
          </section>
        </div>
      ) : (
        <table className="history-diff-columns" aria-label={`${label} comparison`}>
          <thead>
            <tr>
              <th scope="col">
                Before{!before && <span className="history-not-set"> · Not set</span>}
              </th>
              <th scope="col">
                After{!after && <span className="history-not-set"> · Not set</span>}
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr className="history-diff-row" key={index}>
                <DifferenceCell label={label} side="before" line={row.before} />
                <DifferenceCell label={label} side="after" line={row.after} />
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

export function ActivityHistory({ item, onClose }: { item: Activity; onClose: () => void }) {
  const [versions, setVersions] = useState<Activity[]>([]);
  const [fromRevision, setFromRevision] = useState<number>();
  const [toRevision, setToRevision] = useState<number>();
  const [showUnchanged, setShowUnchanged] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    void listActivityVersions(item.workspaceId, item.id, { signal: controller.signal })
      .then((result) => {
        if (controller.signal.aborted) return;
        const ordered = [...result].sort((a, b) => a.revision - b.revision);
        setVersions(ordered);
        // Wait for a comparison pair so a live v1 → v2 update selects both versions.
        if (ordered.length >= 2) {
          setFromRevision((current) => current ?? ordered.at(-2)!.revision);
          setToRevision((current) => current ?? ordered.at(-1)!.revision);
        }
      })
      .catch((cause) => {
        if (!controller.signal.aborted)
          setError(cause instanceof Error ? cause.message : 'Version history could not be loaded.');
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [item.workspaceId, item.id, item.revision, attempt]);
  const before = versions.find((version) => version.revision === fromRevision);
  const after = versions.find((version) => version.revision === toRevision);
  const changed =
    before && after ? fields.filter((field) => field.value(before) !== field.value(after)) : [];
  return (
    <Dialog
      title="Version history"
      onClose={onClose}
      wide
      className="activity-history-dialog"
      headingContent={
        <div className="history-item-heading">
          <p>{item.title}</p>
          <span>
            <code>{item.workId}</code> · {versions.length || item.revision} versions
          </span>
        </div>
      }
    >
      {loading && versions.length === 0 ? (
        <p className="history-notice" role="status">
          Loading version history…
        </p>
      ) : error ? (
        <div className="history-notice" role="alert">
          <p>{error}</p>
          <Button variant="secondary" size="small" onClick={() => setAttempt((value) => value + 1)}>
            <RefreshCw size={14} aria-hidden="true" /> Retry
          </Button>
        </div>
      ) : versions.length < 2 ? (
        <p className="history-notice">
          No earlier versions yet. Changes to this activity will appear here.
        </p>
      ) : (
        <>
          {before && after && (
            <VersionTimeline
              versions={versions}
              fromRevision={before.revision}
              toRevision={after.revision}
              onFromChange={setFromRevision}
              onToChange={setToRevision}
            />
          )}
          <div className="history-diff-toolbar">
            <p role="status">
              {changed.length} {changed.length === 1 ? 'field' : 'fields'} changed
            </p>
            <label>
              <input
                type="checkbox"
                checked={showUnchanged}
                onChange={(event) => setShowUnchanged(event.target.checked)}
              />
              Show unchanged
            </label>
          </div>
          {before && after && (
            <div className="history-diff">
              {changed.length === 0 && !showUnchanged && (
                <p className="history-notice">These versions have the same content.</p>
              )}
              {(showUnchanged ? fields : changed).map((field) => (
                <DifferenceField
                  key={field.label}
                  label={field.label}
                  before={field.value(before)}
                  after={field.value(after)}
                />
              ))}
            </div>
          )}
          <p className="history-legend">
            <span>− Removed</span>
            <span>+ Added</span>
          </p>
        </>
      )}
    </Dialog>
  );
}
