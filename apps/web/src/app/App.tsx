import { useState } from 'react';
import { createWorkspace, updateWorkspace } from '@congruence/api-client';
import type { Workspace, WorkspaceInput } from '@congruence/contracts';
import {
  ChevronDown,
  LoaderCircle,
  Pencil,
  PlugZap,
  Plus,
  RefreshCw,
  TriangleAlert,
  Workflow,
} from 'lucide-react';
import { Button } from '../components/ui/button';
import { WorkspaceEditor } from '../features/workspaces/WorkspaceEditor';
import { useDashboard } from '../features/workspaces/useDashboard';
import { WorkspaceDashboards } from '../features/dashboards/WorkspaceDashboards';
import { AgentConnections } from '../panels/AgentConnections';
import {
  missingModText,
  settingsAttention,
  useAgentSettingsReview,
} from '../panels/AgentSettingsReview';

export function App() {
  const dashboard = useDashboard();
  const { workspace, workspaces, activeId, activity, error, loaded } = dashboard;
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

  async function saveWorkspace(input: WorkspaceInput) {
    const saved =
      editor && editor !== 'new'
        ? await updateWorkspace(editor.id, input)
        : await createWorkspace(input);
    dashboard.setActiveId(saved.id);
    dashboard.refresh();
    setEditor(undefined);
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="topbar-inner">
          <a className="brand" href="/" aria-label="Congruence home">
            <Workflow size={20} />
            congruence
          </a>
          <div className="workspace-switcher">
            {workspaces.length > 0 && (
              <div className="workspace-select-wrap">
                <select
                  aria-label="Current workspace"
                  value={activeId}
                  onChange={(event) => dashboard.setActiveId(event.target.value)}
                >
                  {workspaces.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
                </select>
                <ChevronDown size={14} />
              </div>
            )}
            <Button
              variant="ghost"
              size="icon"
              aria-label="New workspace"
              title="New workspace"
              onClick={() => setEditor('new')}
            >
              <Plus size={18} />
            </Button>
          </div>
          <div className="local-status" role="status">
            <span className={`connection-dot ${error ? 'offline' : !loaded ? 'pending' : ''}`} />
            <span>{error ? 'Offline' : loaded ? 'Local' : 'Connecting'}</span>
          </div>
        </div>
      </header>
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
            <div className="page-heading">
              <div className="workspace-heading">
                <div className="workspace-title">
                  <h1>{workspace.name}</h1>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Edit workspace"
                    title="Edit workspace"
                    onClick={() => setEditor(workspace)}
                  >
                    <Pencil size={15} />
                  </Button>
                </div>
                {workspace.description && <p>{workspace.description}</p>}
                <div className="workspace-id">
                  Workspace ID <code>{workspace.shortId}</code>
                </div>
              </div>
              <Button
                variant="secondary"
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
            <span id="agent-approval-summary" className="sr-only" role="status">
              {attentionSummary}
            </span>
            <WorkspaceDashboards
              key={workspace.id}
              workspace={workspace}
              activities={activity}
              loading={dashboard.activityLoading}
              agentSettings={settingsReview.review?.settings}
              agentSettingsError={settingsReview.error}
              onEdit={() => setEditor(workspace)}
            />
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
          onSave={saveWorkspace}
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
