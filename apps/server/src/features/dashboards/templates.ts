export const dashboardApiTypes = `
export interface DashboardApi {
  read<T = unknown>(query: string, input?: Record<string, unknown>): Promise<T>;
  reviewCommand(commandId: string, options: { input: Record<string, unknown>; prompt?: string }): Promise<unknown>;
}
export interface DashboardContext {
  workspaceId: string;
  dashboardId: string;
  /** Persistent writable directory shared by this dashboard's releases. */
  dataDir: string;
  /** Aborts on retirement: stop polling, but keep resources needed by active commands open. */
  signal: AbortSignal;
  log(...values: unknown[]): void;
}
export interface PreparedCommand {
  input: Record<string, unknown>;
  prompt?: string;
  summary?: string;
}
`;

export const dashboardFrontend = `import type { DashboardApi } from './congruence';

export default function Dashboard({ api }: { api: DashboardApi }) {
  return <main style={{ padding: 24, fontFamily: 'system-ui' }}>
    <h1>Your dashboard</h1>
    <p>Edit src/frontend.tsx, then publish this dashboard with Congruence.</p>
  </main>;
}
`;

export function dashboardInstructions(workspaceId: string, dashboardId: string) {
  return `# Building this Congruence dashboard

Workspace: ${workspaceId}
Dashboard: ${dashboardId}

This directory is the editable source. Congruence publishes immutable releases; editing files alone does not change the dashboard. Call the publish_dashboard MCP tool after edits. Refresh Congruence to load the latest successful release. Failed builds leave the previous release available. Publishing bundles TypeScript with esbuild; it does not perform TypeScript type checking. Validate your dashboard before publishing.

## Frontend

Export a React component as default from src/frontend.tsx. It receives { api }; see src/congruence.ts for types. React and React DOM are supplied. Local CSS imports and relative imports are bundled. Additional npm dependencies can be installed in this directory. Browser code runs in a sandboxed iframe with no same-origin access to Congruence. Use the API for backend data and reviewed commands; browser HTTP requests still follow their server's CORS policy.

- await api.read('query-name', { filters: '...' }) calls backend read.
- await api.reviewCommand('command-id', { input: { ... }, prompt: 'Optional agent prompt' }) opens Congruence's human review. It resolves after confirmation and rejects on cancellation/failure. Display errors in your UI.
- Commands must be declared in manifest.json, with type "agent" or "backend". The host manages preview and confirmation. Never directly send agent commands from read, prepare, or start.

## Optional Node backend

Create src/backend.ts. Imports of Node builtins and bundled JavaScript dependencies are supported. Native addons and dependencies that dynamically locate package files are not supported by this bundling setup; prefer Node builtins (including node:sqlite), HTTP database APIs, or bundle-compatible JavaScript clients. Export any of:

    start(context): void | (() => void | Promise<void>) | Promise<void | (() => void | Promise<void>)>
    read(query, input, context): unknown | Promise<unknown>
    prepare(commandId, input, context): PreparedCommand | Promise<PreparedCommand>
    execute(commandId, input, context): unknown | Promise<unknown>

Context provides workspaceId, dashboardId, persistent dataDir, signal (an AbortSignal), and log(...values). Use dataDir for durable state and caches. Backend code is trusted local code with the permissions of Congruence, not a security sandbox. Keep secrets out of frontend files, manifests, prompts, and logs.

start runs in a dedicated Node worker thread when a release is activated or Congruence starts, even when no browser is open. Return cleanup to dispose database connections, clients, timers, and listeners. When a release retires, context.signal aborts first: listen to it to stop polling immediately, while keeping resources needed by active commands open. Already running commands drain before cleanup runs and the worker terminates. Timers stopped only by cleanup may overlap the new version until old commands finish. Do not use the retirement signal to cancel approved commands. A candidate backend starts before publication commits so startup failure can preserve the previous working release; background collectors should tolerate this brief overlap. Congruence must remain running for background work. Server shutdown gives workers two seconds to finish, then terminates them. Persist restartable state in dataDir yourself; interrupted executions are not automatically replayed.

read fetches live data from HTTP, files, or databases. prepare may fetch dynamic inputs and returns { input, prompt?, summary? } for human review. It must have no command side effects. The reviewed JSON input snapshot is passed unchanged to execute and frozen there. Do not re-read command arguments from external locations in execute: resolve them in prepare so the human sees the exact action. API values must be JSON serializable. Without prepare, the original input/prompt is reviewed.

execute is only for declared backend commands after human confirmation. Agent commands are routed by Congruence. A stale page or preview is rejected after a new version is published; refresh and review again. Pre-existing approved commands may finish on their original release.

Keep frontend and backend exports at these fixed paths. Do not edit release directories or Congruence's registry. An optional package.json is scaffolded; install extra dependencies here when needed.
`;
}

export function frontendEntry(frontendPath: string, version: string) {
  return `import React from 'react';
import { createRoot } from 'react-dom/client';
import Dashboard from ${JSON.stringify(frontendPath)};
const pending = new Map();
let sequence = 0;
function showError(message) {
  document.getElementById('dashboard-error').textContent = message;
}
window.addEventListener('message', event => {
  if (event.source !== window.parent || event.data?.source !== 'congruence-host') return;
  const entry = pending.get(event.data.requestId);
  if (!entry) return;
  pending.delete(event.data.requestId);
  if (event.data.error) {
    const message = typeof event.data.error === 'string' ? event.data.error : event.data.error.message || 'Dashboard request failed.';
    showError(message);
    entry.reject(new Error(message));
  } else entry.resolve(event.data.result);
});
function request(method, values) {
  return new Promise((resolve, reject) => {
    const requestId = String(++sequence);
    pending.set(requestId, { resolve, reject });
    window.parent.postMessage({ source: 'congruence-dashboard', requestId, method, version: ${JSON.stringify(version)}, ...values }, '*');
  });
}
const api = {
  read: (query, input = {}) => request('read', { query, input }),
  reviewCommand: (commandId, { input = {}, prompt } = {}) => request('reviewCommand', { commandId, input, prompt }),
};
class Boundary extends React.Component {
  state = { error: '' };
  static getDerivedStateFromError(error) { return { error: error.message || 'Dashboard failed to render.' }; }
  render() { return this.state.error ? React.createElement('p', { role: 'alert' }, this.state.error) : this.props.children; }
}
window.addEventListener('unhandledrejection', event => showError(event.reason?.message || 'Dashboard request failed.'));
createRoot(document.getElementById('dashboard-root')).render(React.createElement(Boundary, null, React.createElement(Dashboard, { api })));
`;
}

export function dashboardHtml(hasCss: boolean) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Congruence dashboard</title>${hasCss ? '<link rel="stylesheet" href="./dashboard.css">' : ''}<style>html,body{margin:0;font-family:system-ui;color:#e7e9ef;background:#151a23}#dashboard-error:empty{display:none}#dashboard-error{padding:12px;color:#ffb4b4;white-space:pre-wrap}</style></head><body><div id="dashboard-error" role="alert"></div><div id="dashboard-root"></div><script src="./dashboard.js"></script></body></html>`;
}
