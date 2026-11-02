import { useCallback, useEffect, useState } from 'react';
import { listWorkspaces, listActivity } from '@congruence/api-client';
import Schema from 'typebox/schema';
import { DashboardChangeSchema, type Activity, type Workspace } from '@congruence/contracts';

const selectionKey = 'congruence.workspace';
const changeValidator = Schema.Compile(DashboardChangeSchema);
function initialSelection() {
  try {
    return localStorage.getItem(selectionKey) ?? '';
  } catch {
    return '';
  }
}

export function useDashboard() {
  const [activeId, setActiveId] = useState(initialSelection);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [activityState, setActivityState] = useState<{ workspaceId: string; items: Activity[] }>();
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const [lastSynced, setLastSynced] = useState<Date>();
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision((value) => value + 1), []);

  useEffect(() => {
    try {
      localStorage.setItem(selectionKey, activeId);
    } catch {
      /* Selection remains usable without browser storage. */
    }
  }, [activeId]);
  useEffect(() => {
    let cancelled = false;
    let refreshing = false;
    let queued = false;
    const controller = new AbortController();
    const events = new EventSource('/api/events');

    async function sync() {
      queued = true;
      if (refreshing) return;
      refreshing = true;
      try {
        // A change arriving during a fetch must trigger another read after that fetch.
        while (queued && !cancelled) {
          queued = false;
          try {
            const next = await listWorkspaces({ signal: controller.signal });
            if (cancelled) return;
            setWorkspaces(next);
            setLoaded(true);
            const selected = next.find((workspace) => workspace.id === activeId) ?? next[0];
            if (selected && selected.id !== activeId) {
              setActiveId(selected.id);
              return;
            }
            if (selected) {
              const items = await listActivity(selected.id, { signal: controller.signal });
              if (cancelled) return;
              setActivityState({ workspaceId: selected.id, items });
            }
            if (events.readyState === EventSource.OPEN) setError('');
            setLastSynced(new Date());
          } catch (cause) {
            if (!cancelled)
              setError(cause instanceof Error ? cause.message : 'The local server is unavailable.');
          }
        }
      } finally {
        refreshing = false;
      }
    }

    // Also runs after automatic reconnection, recovering any changes missed while offline.
    events.onopen = () => void sync();
    events.addEventListener('change', (event: MessageEvent<string>) => {
      try {
        const change: unknown = JSON.parse(event.data);
        if (
          changeValidator.Check(change) &&
          (change.resource === 'workspaces' ||
            ('workspaceId' in change && change.workspaceId === activeId))
        ) {
          void sync();
        }
      } catch {
        // Ignore malformed notifications; the next connection still reloads current state.
      }
    });
    events.onerror = () => {
      if (!cancelled) setError('Live updates disconnected. Reconnecting…');
    };

    return () => {
      cancelled = true;
      events.close();
      controller.abort();
    };
  }, [activeId, revision]);

  return {
    activeId,
    setActiveId,
    workspaces,
    loaded,
    error,
    lastSynced,
    refresh,
    workspace: workspaces.find((workspace) => workspace.id === activeId),
    activity: activityState?.workspaceId === activeId ? activityState.items : [],
    activityLoading: Boolean(activeId) && activityState?.workspaceId !== activeId,
  };
}
