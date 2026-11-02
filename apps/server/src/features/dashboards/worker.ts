// Kept as plain JavaScript so the worker works from both tsx and the bundled server.
export const dashboardWorkerSource = String.raw`
const { parentPort, workerData } = require('node:worker_threads');
const { appendFile } = require('node:fs/promises');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');
let backend;
let cleanup;
const lifecycle = new AbortController();
const context = {
  workspaceId: workerData.workspaceId,
  dashboardId: workerData.dashboardId,
  dataDir: workerData.dataDir,
  signal: lifecycle.signal,
  log: (...values) => appendFile(join(workerData.dataDir, 'backend.log'),
    new Date().toISOString() + ' ' + values.map(value => typeof value === 'string' ? value : JSON.stringify(value)).join(' ') + '\n').catch(() => {}),
};
function freeze(value) {
  if (value && typeof value === 'object') {
    Object.freeze(value);
    for (const item of Object.values(value)) freeze(item);
  }
  return value;
}
parentPort.on('message', async ({ id, method, args }) => {
  try {
    let result;
    if (method === 'retire') {
      lifecycle.abort();
    } else if (method === 'stop') {
      const stop = cleanup;
      cleanup = undefined;
      if (stop) await stop();
    } else if (method === 'prepare' && typeof backend.prepare !== 'function') {
      result = { input: args[1] };
    } else {
      if (typeof backend[method] !== 'function') throw new Error('Dashboard backend does not export ' + method + '.');
      result = await backend[method](...args.map(freeze), context);
    }
    parentPort.postMessage({ id, result });
  } catch (error) {
    parentPort.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  }
});
(async () => {
  backend = await import(pathToFileURL(workerData.backendPath).href);
  if (backend.default && typeof backend.default === 'object') backend = backend.default;
  if (typeof backend.start === 'function') {
    cleanup = await backend.start(context);
    if (cleanup !== undefined && typeof cleanup !== 'function') throw new Error('Dashboard start() must return a cleanup function or undefined.');
  }
  parentPort.postMessage({ ready: true });
})().catch(error => parentPort.postMessage({ ready: false, error: error instanceof Error ? error.message : String(error) }));
`;
