import type { Workspace } from '@congruence/contracts';
import { ArrowUpRight, FolderGit2, Pencil } from 'lucide-react';
import { Button } from '../components/ui/button';
import { safeSourceUrl } from '../features/activity/ActivityFeed';
import { panels } from './registry';

export function WorkspacePanels({
  workspace,
  onEdit,
}: {
  workspace: Workspace;
  onEdit: () => void;
}) {
  return (
    <aside className="workspace-panels">
      <section className="panel repositories-panel" aria-labelledby="repositories-title">
        <div className="small-panel-heading">
          <h2 id="repositories-title">
            <FolderGit2 size={17} />
            {panels.repositories.title}{' '}
            <span className="count-badge">{workspace.repositories.length}</span>
          </h2>
          <Button variant="ghost" size="icon" aria-label="Edit repositories" onClick={onEdit}>
            <Pencil size={15} />
          </Button>
        </div>
        {workspace.repositories.length ? (
          <ul className="repository-list">
            {workspace.repositories.map((repository) => {
              const url = safeSourceUrl(repository);
              const shortName =
                repository
                  .replace(/[\\/]+$/, '')
                  .split(/[\\/]/)
                  .at(-1) || repository;
              const content = (
                <>
                  <span className="repo-icon">
                    <FolderGit2 size={17} />
                  </span>
                  <span>
                    <strong>{shortName}</strong>
                    <span className="repository-path" title={repository}>
                      {repository}
                    </span>
                  </span>
                  {url && <ArrowUpRight size={14} />}
                </>
              );
              return (
                <li key={repository}>
                  {url ? (
                    <a href={url} target="_blank" rel="noopener noreferrer">
                      {content}
                    </a>
                  ) : (
                    <div>{content}</div>
                  )}
                </li>
              );
            })}
          </ul>
        ) : (
          <div className="repositories-empty">
            <p>No repositories</p>
          </div>
        )}
      </section>
    </aside>
  );
}
