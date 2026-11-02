import type {
  DashboardExecute,
  DashboardPreview,
  DashboardPreviewInput,
  DashboardRead,
  DashboardRun,
  DashboardSummary,
} from '@congruence/contracts';

async function request<T>(url: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
  const result = await response.json();
  if (!response.ok)
    throw new Error(typeof result.message === 'string' ? result.message : 'The request failed.');
  return result as T;
}

function root(workspaceId: string) {
  return `/api/workspaces/${encodeURIComponent(workspaceId)}/dashboards`;
}
function dashboard(workspaceId: string, dashboardId: string) {
  return `${root(workspaceId)}/${encodeURIComponent(dashboardId)}`;
}
export const dashboardApi = {
  list: (workspaceId: string, signal?: AbortSignal) =>
    request<DashboardSummary[]>(root(workspaceId), undefined, signal),
  read: (workspaceId: string, id: string, input: DashboardRead) =>
    request<{ data: unknown }>(`${dashboard(workspaceId, id)}/read`, input),
  preview: (workspaceId: string, id: string, input: DashboardPreviewInput) =>
    request<DashboardPreview>(`${dashboard(workspaceId, id)}/previews`, input),
  execute: (workspaceId: string, id: string, input: DashboardExecute) =>
    request<DashboardRun>(`${dashboard(workspaceId, id)}/runs`, input),
  runs: (workspaceId: string, id: string, signal?: AbortSignal) =>
    request<DashboardRun[]>(`${dashboard(workspaceId, id)}/runs`, undefined, signal),
};

export function errorMessage(cause: unknown) {
  return cause instanceof Error ? cause.message : 'The request could not be completed.';
}
