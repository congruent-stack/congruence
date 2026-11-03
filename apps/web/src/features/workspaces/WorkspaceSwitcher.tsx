import { useEffect, useId, useRef, useState } from 'react';
import type { DashboardSummary, Workspace, WorkspaceInput } from '@congruence/contracts';
import { ChevronDown, ChevronRight, Pencil, Plus, RefreshCw } from 'lucide-react';
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
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [editor, setEditor] = useState<'new' | Workspace>();
  const viewName = views.selected ? viewLabel(views.selected) : 'Activity';
  const title = editor
    ? editor === 'new'
      ? 'New workspace'
      : 'Edit workspace'
    : 'Workspace and view';

  function close() {
    panel.current?.hidePopover();
    trigger.current?.focus({ preventScroll: true });
  }

  useEffect(() => {
    // Clicks in a sandboxed dashboard don't reach the parent document's popover dismissal.
    function dismissForFrame() {
      if (
        document.activeElement instanceof HTMLIFrameElement &&
        panel.current?.matches(':popover-open')
      ) {
        panel.current.hidePopover();
      }
    }
    window.addEventListener('blur', dismissForFrame);
    return () => window.removeEventListener('blur', dismissForFrame);
  }, []);

  return (
    <div className="workspace-switcher">
      <button
        type="button"
        className="switcher-trigger"
        ref={trigger}
        popoverTarget={id}
        aria-haspopup="dialog"
        aria-label={
          workspace
            ? `Switch workspace and view, ${workspace.name}, ${viewName}`
            : 'Switch workspace and view'
        }
      >
        <span className="switcher-path">
          <span className="switcher-workspace">{workspace?.name ?? 'Workspaces'}</span>
          {workspace && (
            <>
              <ChevronRight size={12} className="switcher-separator" />
              <span className="switcher-view">{viewName}</span>
            </>
          )}
        </span>
        <ChevronDown size={14} className="switcher-chevron" />
      </button>
      <div
        id={id}
        ref={panel}
        popover="auto"
        className="switcher-popover"
        role="dialog"
        aria-label={title}
        onToggle={(event) => {
          if (event.newState === 'closed') setEditor(undefined);
        }}
      >
        {editor ? (
          <WorkspaceEditor
            inline
            workspace={editor === 'new' ? undefined : editor}
            onClose={close}
            onSave={async (input) => {
              await onSave(input, editor === 'new' ? undefined : editor);
              close();
            }}
          />
        ) : (
          <>
            {workspace ? (
              <>
                <div className="switcher-field">
                  <div className="switcher-field-heading">
                    <label htmlFor={`${id}-workspace`}>Workspace</label>
                    <span className="workspace-id">
                      Workspace ID <code>{workspace.shortId}</code>
                    </span>
                  </div>
                  <div className="switcher-select">
                    <select
                      id={`${id}-workspace`}
                      aria-label="Current workspace"
                      value={workspace.id}
                      onChange={(event) => onSelect(event.target.value)}
                    >
                      {workspaces.map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.name}
                        </option>
                      ))}
                    </select>
                    <ChevronDown size={14} />
                  </div>
                  {workspace.description && <p>{workspace.description}</p>}
                </div>
                <div className="switcher-field">
                  <label htmlFor={`${id}-view`}>View</label>
                  <div className="switcher-view-row">
                    <div className="switcher-select">
                      <select
                        id={`${id}-view`}
                        value={views.selected?.id ?? 'activity'}
                        onChange={(event) => {
                          views.select(event.target.value);
                          close();
                        }}
                      >
                        <option value="activity">Activity</option>
                        {views.dashboards.map((item) => (
                          <option key={item.id} value={item.id}>
                            {viewLabel(item)}
                          </option>
                        ))}
                      </select>
                      <ChevronDown size={14} />
                    </div>
                    <Button
                      variant="secondary"
                      size="icon"
                      aria-label="Refresh dashboards"
                      title="Refresh dashboards"
                      disabled={views.refreshing}
                      onClick={views.refresh}
                    >
                      <RefreshCw size={15} className={views.refreshing ? 'spin' : ''} />
                    </Button>
                  </div>
                  {views.selected?.description && <p>{views.selected.description}</p>}
                </div>
              </>
            ) : (
              <p>No workspaces yet.</p>
            )}
            <div className="switcher-actions">
              {workspace && (
                <Button variant="ghost" size="small" onClick={() => setEditor(workspace)}>
                  <Pencil size={14} /> Edit workspace
                </Button>
              )}
              <Button variant="ghost" size="small" onClick={() => setEditor('new')}>
                <Plus size={15} /> New workspace
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
