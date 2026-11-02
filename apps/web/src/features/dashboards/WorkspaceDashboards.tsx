import { useEffect, useState } from 'react';
import { ChevronDown, RefreshCw } from 'lucide-react';
import type { Activity, AgentSettings, DashboardSummary, Workspace } from '@congruence/contracts';
import { ActivityFeed } from '../activity/ActivityFeed';
import { WorkspacePanels } from '../../panels/WorkspacePanels';
import { Button } from '../../components/ui/button';
import { DashboardFrame } from './DashboardFrame';
import { dashboardApi, errorMessage } from './client';

function remembered(workspaceId: string) {
  try {
    return localStorage.getItem(`congruence.dashboard.${workspaceId}`) ?? 'activity';
  } catch {
    return 'activity';
  }
}

export function WorkspaceDashboards({
  workspace,
  activities,
  loading,
  agentSettings,
  agentSettingsError,
  onEdit,
}: {
  workspace: Workspace;
  activities: Activity[];
  loading: boolean;
  agentSettings?: AgentSettings;
  agentSettingsError?: string;
  onEdit: () => void;
}) {
  const [selection, setSelection] = useState(() => remembered(workspace.id));
  const [dashboards, setDashboards] = useState<DashboardSummary[]>([]);
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(true);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    setRefreshing(true);
    dashboardApi
      .list(workspace.id, controller.signal)
      .then(
        (items) => {
          if (cancelled) return;
          setDashboards(items);
          setSelection((current) =>
            current === 'activity' || items.some((item) => item.id === current)
              ? current
              : 'activity',
          );
          setError('');
        },
        (cause: unknown) => {
          if (!cancelled) setError(errorMessage(cause));
        },
      )
      .finally(() => {
        if (!cancelled) setRefreshing(false);
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [workspace.id, revision]);

  useEffect(() => {
    try {
      localStorage.setItem(`congruence.dashboard.${workspace.id}`, selection);
    } catch {
      /* Selection still works without browser storage. */
    }
  }, [workspace.id, selection]);

  const selected = dashboards.find((item) => item.id === selection);
  const selector = (
    <div className="dashboard-selector-wrap">
      <select
        id="activity-title"
        aria-label="Dashboard"
        value={selected?.id ?? 'activity'}
        onChange={(event) => setSelection(event.target.value)}
      >
        <option value="activity">Activity</option>
        {dashboards.map((item) => (
          <option key={item.id} value={item.id}>
            {item.name}
            {item.status === 'draft' ? ' (draft)' : ''}
          </option>
        ))}
      </select>
      <ChevronDown size={14} aria-hidden="true" />
    </div>
  );

  return (
    <>
      {error && (
        <div className="dashboard-list-error" role="alert">
          <p>Dashboards could not be loaded. {error}</p>
          <Button
            size="small"
            variant="secondary"
            onClick={() => setRevision((value) => value + 1)}
            disabled={refreshing}
          >
            Retry dashboards
          </Button>
        </div>
      )}
      {selected ? (
        <section className="custom-dashboard" aria-label={selected.name}>
          <div className="panel-heading custom-dashboard-heading">
            {selector}
            <Button
              variant="ghost"
              size="small"
              onClick={() => setRevision((value) => value + 1)}
              disabled={refreshing}
            >
              <RefreshCw size={14} className={refreshing ? 'spin' : ''} />
              Refresh dashboards
            </Button>
          </div>
          {selected.description && (
            <p className="custom-dashboard-description">{selected.description}</p>
          )}
          <DashboardFrame
            key={`${selected.id}:${selected.version}:${revision}`}
            workspace={workspace}
            dashboard={selected}
            activities={activities}
          />
        </section>
      ) : (
        <div className="dashboard-grid">
          <ActivityFeed
            items={activities}
            loading={loading}
            agentSettings={agentSettings}
            agentSettingsError={agentSettingsError}
            heading={selector}
          />
          <WorkspacePanels workspace={workspace} onEdit={onEdit} />
        </div>
      )}
    </>
  );
}
