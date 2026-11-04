import { useState } from 'react';
import type { DashboardSummary, Workspace, WorkspaceInput } from '@congruence/contracts';
import { Pencil, Plus, RefreshCw } from 'lucide-react';
import { SearchableSelect } from '../../components/SearchableSelect';
import { Button } from '../../components/ui/button';
import type { useWorkspaceViews } from '../dashboards/useWorkspaceViews';
import { WorkspaceEditor } from './WorkspaceEditor';

function viewLabel(dashboard: DashboardSummary) {
  return dashboard.status === 'draft' ? `${dashboard.name} (draft)` : dashboard.name;
}

export function WorkspaceSwitcher({
  workspace,
  workspaces,
  views,
  onSelect,
  onSave,
}: {
  workspace?: Workspace;
  workspaces: Workspace[];
  views: ReturnType<typeof useWorkspaceViews>;
  onSelect: (id: string) => void;
  onSave: (input: WorkspaceInput, workspace?: Workspace) => Promise<void>;
}) {
  const [editor, setEditor] = useState<'new' | Workspace>();

  return (
    <div className="workspace-switcher">
      <SearchableSelect
        label="Workspace"
        searchLabel="Search workspaces"
        value={workspace?.id}
        options={workspaces.map((item) => ({
          value: item.id,
          label: item.name,
          description: item.description,
        }))}
        emptyMessage={workspaces.length ? 'No matching workspaces.' : 'No workspaces yet.'}
        onSelect={onSelect}
        footer={(close) => (
          <>
            {workspace && (
              <span className="workspace-id">
                Workspace ID <code>{workspace.shortId}</code>
              </span>
            )}
            <Button
              variant="ghost"
              size="small"
              onClick={() => {
                close();
                setEditor('new');
              }}
            >
              <Plus size={15} /> New workspace
            </Button>
          </>
        )}
      />
      <SearchableSelect
        key={workspace?.id ?? 'no-workspace'}
        label="View"
        searchLabel="Search views"
        value={views.selected?.id ?? 'activity'}
        options={[
          { value: 'activity', label: 'Activity' },
          ...views.dashboards.map((item) => ({
            value: item.id,
            label: viewLabel(item),
            description: item.description,
          })),
        ]}
        emptyMessage="No matching views."
        disabled={!workspace}
        onSelect={views.select}
        footer={() => (
          <Button variant="ghost" size="small" disabled={views.refreshing} onClick={views.refresh}>
            <RefreshCw size={14} className={views.refreshing ? 'spin' : ''} /> Refresh dashboards
          </Button>
        )}
      />
      <Button
        variant="ghost"
        size="icon"
        className="workspace-edit"
        aria-label="Edit workspace"
        title="Edit workspace"
        disabled={!workspace}
        onClick={() => setEditor(workspace)}
      >
        <Pencil size={16} />
      </Button>
      {editor && (
        <WorkspaceEditor
          workspace={editor === 'new' ? undefined : editor}
          onClose={() => setEditor(undefined)}
          onSave={async (input) => {
            await onSave(input, editor === 'new' ? undefined : editor);
            setEditor(undefined);
          }}
        />
      )}
    </div>
  );
}
