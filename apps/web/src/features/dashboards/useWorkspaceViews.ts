import { useEffect, useState } from 'react';
import type { DashboardSummary } from '@congruence/contracts';
import { dashboardApi, errorMessage } from './client';

interface WorkspaceViews {
  workspaceId: string;
  revision: number;
  dashboards: DashboardSummary[];
  selection: string;
  error: string;
}

export function useWorkspaceViews(workspaceId?: string) {
  const [list, setList] = useState<WorkspaceViews>();
  const [revision, setRevision] = useState(0);
  const current = list?.workspaceId === workspaceId ? list : undefined;
  const selection = current?.selection;

  useEffect(() => {
    if (!workspaceId) return;
    const controller = new AbortController();
    let remembered = 'activity';
    try {
      remembered = localStorage.getItem(`congruence.dashboard.${workspaceId}`) ?? 'activity';
    } catch {
      /* Selection remains usable without browser storage. */
    }
    const initial = { workspaceId, revision, dashboards: [], selection: remembered, error: '' };
    dashboardApi.list(workspaceId, controller.signal).then(
      (dashboards) => {
        if (controller.signal.aborted) return;
        setList((previous) => {
          const choice = previous?.workspaceId === workspaceId ? previous.selection : remembered;
          return {
            ...initial,
            dashboards,
            selection: dashboards.some((item) => item.id === choice) ? choice : 'activity',
          };
        });
      },
      (cause: unknown) => {
        if (controller.signal.aborted) return;
        setList((previous) => ({
          ...(previous?.workspaceId === workspaceId ? previous : initial),
          revision,
          error: errorMessage(cause),
        }));
      },
    );
    return () => controller.abort();
  }, [workspaceId, revision]);

  useEffect(() => {
    if (!workspaceId || !selection) return;
    try {
      localStorage.setItem(`congruence.dashboard.${workspaceId}`, selection);
    } catch {
      /* Selection remains usable without browser storage. */
    }
  }, [workspaceId, selection]);

  return {
    dashboards: current?.dashboards ?? [],
    selected: current?.dashboards.find((item) => item.id === selection),
    select: (id: string) =>
      setList((previous) =>
        previous && previous.workspaceId === workspaceId
          ? { ...previous, selection: id }
          : previous,
      ),
    error: current?.error,
    revision,
    refreshing: current?.revision !== revision,
    refresh: () => setRevision((value) => value + 1),
  };
}
