import { useState } from 'react';
import { createWorkspace, updateWorkspace } from '@congruence/api-client';
import type { Workspace, WorkspaceInput } from '@congruence/contracts';
import { LoaderCircle, PlugZap, Plus, RefreshCw, TriangleAlert, Workflow } from 'lucide-react';
import { Button } from '../components/ui/button';
import { ActivityFeed } from '../features/activity/ActivityFeed';
import { DashboardFrame } from '../features/dashboards/DashboardFrame';
import { useWorkspaceViews } from '../features/dashboards/useWorkspaceViews';
import { WorkspaceEditor } from '../features/workspaces/WorkspaceEditor';
import { WorkspaceSwitcher } from '../features/workspaces/WorkspaceSwitcher';
import { useDashboard } from '../features/workspaces/useDashboard';
import { AgentConnections } from '../panels/AgentConnections';
import { WorkspacePanels } from '../panels/WorkspacePanels';
import {
  missingModText,
  settingsAttention,
  useAgentSettingsReview,
} from '../panels/AgentSettingsReview';

export function App() {
  const dashboard = useDashboard();
  const { workspace, workspaces, activity, error, loaded } = dashboard;
  const views = useWorkspaceViews(workspace?.id);
  const [editor, setEditor] = useState<'new' | Workspace>();
  const [setup, setSetup] = useState(false);
  const settingsReview = useAgentSettingsReview();
  const attention = settingsAttention(settingsReview.review);
  const pendingSettings = attention.total;
  const attentionSummary = [
    attention.requests > 0 &&
      `${attention.requests} connection ${attention.requests === 1 ? 'change needs' : 'changes need'} approval`,
    attention.missingMod > 0 && missingModText(attention.missingMod),
  ]
    .filter(Boolean)
    .join('; ');

  async function saveWorkspace(input: WorkspaceInput, original?: Workspace) {
    const saved = original
      ? await updateWorkspace(original.id, input)
      : await createWorkspace(input);
    dashboard.setActiveId(saved.id);
    dashboard.refresh();
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="topbar-inner">
          <a className="brand" href="/" aria-label="Congruence home">
            <Workflow size={20} />
            <span>congruence</span>
          </a>
          {loaded && (
            <WorkspaceSwitcher
              workspace={workspace}
              workspaces={workspaces}
              views={views}
              onSelect={dashboard.setActiveId}
              onSave={saveWorkspace}
            />
          )}
          <div className="local-status" role="status">
            <span className={`connection-dot ${error ? 'offline' : !loaded ? 'pending' : ''}`} />
            <span>{error ? 'Offline' : loaded ? 'Local' : 'Connecting'}</span>
          </div>
          <Button
            variant="secondary"
            className="agents-button"
            aria-label="Agents"
            aria-describedby={pendingSettings ? 'agent-approval-summary' : undefined}
            onClick={() => {
              settingsReview.refresh();
              setSetup(true);
            }}
          >
            <PlugZap size={16} />
            Agents
            {pendingSettings > 0 && (
              <span className="approval-count" aria-hidden="true">
                {pendingSettings}
              </span>
            )}
          </Button>
        </div>
      </header>
      <span id="agent-approval-summary" className="sr-only" role="status">
        {attentionSummary}
      </span>
      <main className="main-content">
        {error && (
          <div className="connection-error" role="alert">
            <TriangleAlert size={18} />
            <div>
              <strong>We can’t reach the local server.</strong>
              <span>
                {loaded
                  ? 'Showing the last available updates.'
                  : 'Check that Congruence is running.'}
              </span>
            </div>
            <Button variant="secondary" size="small" onClick={dashboard.refresh}>
              <RefreshCw size={14} />
              Retry
            </Button>
          </div>
        )}
        {!loaded ? (
          <div className="page-loading" role="status">
            <LoaderCircle size={22} className="spin" />
            <p>{error ? 'Waiting for the local server' : 'Loading…'}</p>
          </div>
        ) : workspace ? (
          <>
            <h1 className="sr-only">{workspace.name}</h1>
            {views.error && (
              <div className="dashboard-list-error" role="alert">
                <p>Dashboards could not be loaded. {views.error}</p>
                <Button
                  size="small"
                  variant="secondary"
                  disabled={views.refreshing}
                  onClick={views.refresh}
                >
                  Retry dashboards
                </Button>
              </div>
            )}
            {views.selected ? (
              <section className="custom-dashboard" aria-label={views.selected.name}>
                <DashboardFrame
                  key={`${workspace.id}:${views.selected.id}:${views.selected.version}:${views.revision}`}
                  workspace={workspace}
                  dashboard={views.selected}
                  activities={activity}
                />
              </section>
            ) : (
              <div className="dashboard-grid">
                <ActivityFeed
                  key={workspace.id}
                  items={activity}
                  loading={dashboard.activityLoading}
                  agentSettings={settingsReview.review?.settings}
                  agentSettingsError={settingsReview.error}
                />
                <WorkspacePanels workspace={workspace} onEdit={() => setEditor(workspace)} />
              </div>
            )}
          </>
        ) : (
          <div className="welcome">
            <h1>Your workspaces</h1>
            <p>Keep related work and agent updates together.</p>
            <Button onClick={() => setEditor('new')}>
              <Plus size={17} />
              Create your first workspace
            </Button>
          </div>
        )}
      </main>
      {editor && (
        <WorkspaceEditor
          workspace={editor === 'new' ? undefined : editor}
          onSave={async (input) => {
            await saveWorkspace(input, editor === 'new' ? undefined : editor);
            setEditor(undefined);
          }}
          onClose={() => setEditor(undefined)}
        />
      )}
      {setup && (
        <AgentConnections
          workspace={workspace}
          workspaces={workspaces}
          review={settingsReview}
          onClose={() => setSetup(false)}
        />
      )}
    </div>
  );
}
