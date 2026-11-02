import type { On } from 'claude-code';
import { expect, mock, test } from 'claude-code/testing';

const messageId = 'msg012ab';
const prompt = `[Congruence message ${messageId}]\nUse this existing Congruence item.\n\nPlease continue.`;

interface Request {
  path: string;
  body: Record<string, unknown>;
  authorization?: string;
}

// Stands for the Congruence server: each poll answers with the next entry, then with no messages.
function congruence(on: On, polls: Array<{ status: number; messages?: unknown[] }>) {
  const requests: Request[] = [];
  let registrations = 0;
  on('http.fetch', (_, e) => {
    const url = new URL(e.url);
    requests.push({
      path: url.origin + url.pathname,
      body: JSON.parse(e.init?.body ?? '{}'),
      authorization: e.init?.headers?.Authorization,
    });
    let status = 200;
    let body: unknown = {};
    if (url.pathname.endsWith('/register')) body = { token: `token-${++registrations}` };
    else if (url.pathname.endsWith('/poll')) {
      const next = polls.shift() ?? { status: 200 };
      status = next.status;
      body = { messages: next.messages ?? [] };
    }
    return { value: { status, ok: status < 300, headers: {}, text: JSON.stringify(body) } };
  });
  return requests;
}

function engine(on: On) {
  on('session.start', (_, e) => ({ cwd: e.cwd }));
  on('turn.start', (_, e) => ({ turnId: e.turnId }));
  on('turn.complete', () => ({ text: '' }));
}

test('stays idle outside Claude Desktop', async ($, on) => {
  const clock = mock.clock(on);
  mock.env(on, {});
  const requests = congruence(on, []);
  engine(on);

  await $.session.start({ cwd: 'D:/project', surface: 'terminal', isInteractive: true });
  await clock.advance(10000);

  expect(requests).toEqual([]);
});

for (const url of [
  'https://127.0.0.1:4310',
  'http://congruence.example',
  'http://127.0.0.1.example',
  'http://127.0.0.1:4310/api',
])
  test(`stays off when CONGRUENCE_URL is ${url}`, async ($, on) => {
    const clock = mock.clock(on);
    mock.env(on, { CLAUDE_CODE_HOST_SESSION_ID: 'local_desktop-3', CONGRUENCE_URL: url });
    const logs: string[] = [];
    on('ui.log', (_, e) => {
      logs.push(e.text);
      return { value: undefined };
    });
    const requests = congruence(on, []);
    engine(on);

    await $.session.start({ cwd: 'D:/project', surface: null, isInteractive: false });
    await clock.advance(10000);

    expect(requests).toEqual([]);
    expect(logs).toHaveLength(1);
  });

test('delivers a dashboard message as the user and reports the reply', async ($, on) => {
  const clock = mock.clock(on);
  mock.env(on, {
    CLAUDE_CODE_HOST_SESSION_ID: 'local_desktop-1',
    CONGRUENCE_URL: 'http://127.0.0.1:4999/',
  });
  const requests = congruence(on, [{ status: 200, messages: [{ id: messageId, text: prompt }] }]);
  const submitted: Array<{ text: string; asUser?: boolean }> = [];
  on('prompt.submit', (_, e) => {
    submitted.push({ text: e.text, asUser: e.origin.kind === 'plugin' ? e.origin.asUser : false });
    return { text: e.text };
  });
  engine(on);

  await $.session.start({ cwd: 'D:/project', surface: null, isInteractive: false });
  await clock.advance(2000);

  const base = 'http://127.0.0.1:4999/api/agents/claude-desktop';
  expect(requests).toEqual([
    {
      path: `${base}/register`,
      body: { sessionId: 'local_desktop-1', cwd: 'D:/project' },
      authorization: undefined,
    },
    { path: `${base}/local_desktop-1/poll`, body: {}, authorization: 'Bearer token-1' },
    {
      path: `${base}/local_desktop-1/receipts`,
      body: { messageId, outcome: 'started' },
      authorization: 'Bearer token-1',
    },
  ]);
  expect(submitted).toEqual([{ text: prompt, asUser: true }]);

  // An unrelated turn and a marker the mod did not submit report nothing.
  const typed = '[Congruence message 0b8f8f3e-1c2d-4e5f-8a9b-0c1d2e3f4a5b]\nTyped.';
  for (const { turnId, text } of [
    { turnId: 'other-turn', text: 'Something else' },
    { turnId: 'typed-turn', text: typed },
    { turnId: 'typed-short-turn', text: '[Congruence message other123]\nTyped.' },
  ]) {
    await $.turn.start({ text, turnId });
    await $.turn.complete({
      answer: 'Unrelated.',
      durationMs: 5,
      isAborted: false,
      turnId,
      reason: 'answer',
    });
  }
  // The marker maps the turn wherever it stands in the text the turn starts with.
  await $.turn.start({ text: `Context first. ${prompt}`, turnId: 'message-turn' });
  await $.turn.complete({
    answer: 'Continued the work.',
    durationMs: 10,
    isAborted: false,
    turnId: 'message-turn',
    reason: 'answer',
  });
  await clock.settle();

  expect(requests.slice(3)).toEqual([
    {
      path: `${base}/local_desktop-1/receipts`,
      body: { messageId, outcome: 'replied', reply: 'Continued the work.' },
      authorization: 'Bearer token-1',
    },
  ]);
  // The message is answered: a later turn with its marker reports nothing more.
  await $.turn.start({ text: prompt, turnId: 'repeat-turn' });
  await $.turn.complete({
    answer: 'Again.',
    durationMs: 5,
    isAborted: false,
    turnId: 'repeat-turn',
    reason: 'answer',
  });
  await clock.settle();
  expect(requests).toHaveLength(4);
  await clock.advance(4000);
  expect(submitted).toHaveLength(1);
});

test('keeps mapping legacy UUID message markers to receipts', async ($, on) => {
  const clock = mock.clock(on);
  mock.env(on, { CLAUDE_CODE_HOST_SESSION_ID: 'local_legacy' });
  const legacyId = '6f1c2b8e-0a4d-4c55-9f7e-2b1d3c4e5f60';
  const legacyPrompt = `[Congruence message ${legacyId}]\nPlease continue.`;
  const requests = congruence(on, [
    { status: 200, messages: [{ id: legacyId, text: legacyPrompt }] },
  ]);
  on('prompt.submit', (_, e) => ({ text: e.text }));
  engine(on);

  await $.session.start({ cwd: 'D:/project', surface: null, isInteractive: false });
  await clock.advance(2000);
  await $.turn.start({ text: legacyPrompt, turnId: 'legacy-turn' });
  await $.turn.complete({
    answer: 'Legacy reply.',
    durationMs: 5,
    isAborted: false,
    turnId: 'legacy-turn',
    reason: 'answer',
  });
  await clock.settle();

  expect(requests.at(-1)?.body).toEqual({
    messageId: legacyId,
    outcome: 'replied',
    reply: 'Legacy reply.',
  });
});

test('waits longer between polls while Congruence does not answer', async ($, on) => {
  const clock = mock.clock(on);
  mock.env(on, { CLAUDE_CODE_HOST_SESSION_ID: 'local_desktop-4' });
  let isDown = true;
  const times: number[] = [];
  on('http.fetch', (_, e) => {
    times.push(clock.now());
    if (isDown) return { value: { status: 503, ok: false, headers: {}, text: '{}' } };
    const body = e.url.endsWith('/register') ? { token: 'token-1' } : { messages: [] };
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(body) } };
  });
  engine(on);

  await $.session.start({ cwd: 'D:/project', surface: null, isInteractive: false });
  const start = clock.now();
  await clock.advance(90000);
  // The wait doubles from two seconds and stops at thirty.
  expect(times.map((time) => time - start)).toEqual([2000, 6000, 14000, 30000, 60000, 90000]);

  isDown = false;
  times.length = 0;
  await clock.advance(32000);
  // Once Congruence answers, the mod registers, polls, and polls every two seconds again.
  expect(times.map((time) => time - start)).toEqual([120000, 120000, 122000]);
});

test('registers again after the server forgets the session and reports a refused prompt', async ($, on) => {
  const clock = mock.clock(on);
  mock.env(on, { CLAUDE_CODE_HOST_SESSION_ID: 'local_desktop-2' });
  const requests = congruence(on, [
    { status: 401 },
    { status: 200, messages: [{ id: messageId, text: prompt }] },
  ]);
  on('prompt.submit', () => ({ drop: 'the session was stopped and nobody has sent input since' }));
  engine(on);

  await $.session.start({ cwd: 'D:/project', surface: null, isInteractive: false });
  await clock.advance(2000);
  await clock.advance(2000);

  const base = 'http://127.0.0.1:4310/api/agents/claude-desktop';
  expect(requests.map((request) => [request.path, request.authorization])).toEqual([
    [`${base}/register`, undefined],
    [`${base}/local_desktop-2/poll`, 'Bearer token-1'],
    [`${base}/register`, undefined],
    [`${base}/local_desktop-2/poll`, 'Bearer token-2'],
    [`${base}/local_desktop-2/receipts`, 'Bearer token-2'],
  ]);
  expect(requests.at(-1)?.body).toEqual({
    messageId,
    outcome: 'dropped',
    reason: 'the session was stopped and nobody has sent input since',
  });
});
