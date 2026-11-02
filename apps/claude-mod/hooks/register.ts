import { update, type EngineInterface, type Register } from 'claude-code';
import type { Submitted } from '../types';

// Claude Desktop names each local Code session; in other hosts the mod does nothing.
const desktopSession = /^local_[A-Za-z0-9-]{1,64}$/;
// The server puts this marker in every prompt it hands out, so a turn maps to its message.
const messageMarker = /\[Congruence message ([a-z0-9]{8}|[0-9a-f-]{36})\]/;
// Congruence listens on loopback only, so the mod sends nothing to any other host.
const loopbackOrigin = /^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d{1,5})?\/*$/i;
const pollInterval = 2000;
// While Congruence does not answer, the wait between polls doubles up to this limit.
const maxPollInterval = 30000;
const maxReply = 50000;
// Kept in $.state, so a reload while a message's turn runs still reports the reply.
const submitted = { plugin: 'congruence', key: 'submitted' } as const;

interface Connection {
  base: string;
  sessionId: string;
  cwd: string;
  token?: string;
}
interface Delivery {
  id: string;
  text: string;
}

// The connection starts over on a reload; the server then accepts a new registration.
let connection: Connection | undefined;

function post($: EngineInterface, current: Connection, path: string, body: unknown) {
  return $.http.fetch(`${current.base}/api/agents/claude-desktop/${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(current.token ? { Authorization: `Bearer ${current.token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

function report(
  $: EngineInterface,
  current: Connection,
  messageId: string,
  outcome: Record<string, string>,
) {
  return post($, current, `${encodeURIComponent(current.sessionId)}/receipts`, {
    messageId,
    ...outcome,
  }).catch(() => undefined);
}

function forget($: EngineInterface, messageId: string) {
  return update($, submitted, (all: Submitted = {}) =>
    Object.fromEntries(Object.entries(all).filter(([id]) => id !== messageId)),
  );
}

async function deliver($: EngineInterface, current: Connection, message: Delivery) {
  // An empty turn ID marks a message whose turn has not started yet.
  await update($, submitted, (all: Submitted = {}) => ({ ...all, [message.id]: '' }));
  const drop = (reason: string) =>
    forget($, message.id).then(() =>
      report($, current, message.id, { outcome: 'dropped', reason }),
    );
  // The server hands out each message once. A refused prompt is reported, never retried.
  // asUser leaves out the engine's plugin frame: the person wrote the message in the dashboard.
  void $.prompt.submit({ text: message.text, asUser: true }).then(
    (result) =>
      result.drop === undefined
        ? report($, current, message.id, { outcome: 'started' })
        : drop(result.drop),
    (error: unknown) =>
      drop(error instanceof Error ? error.message : 'Claude Code refused the prompt.'),
  );
}

// Resolves whether Congruence answered.
async function poll($: EngineInterface, current: Connection) {
  try {
    if (!current.token) {
      const registered = await post($, current, 'register', {
        sessionId: current.sessionId,
        cwd: current.cwd,
      });
      if (!registered.ok) return false;
      current.token = (JSON.parse(registered.text) as { token: string }).token;
    }
    const response = await post($, current, `${encodeURIComponent(current.sessionId)}/poll`, {});
    // The server forgot the session, as after a restart. The next poll registers again.
    if (response.status === 401) current.token = undefined;
    else if (!response.ok) return false;
    else {
      const { messages } = JSON.parse(response.text) as { messages: Delivery[] };
      for (const message of messages) await deliver($, current, message);
    }
    return true;
  } catch {
    // Congruence is stopped or unreachable.
    return false;
  }
}

function schedule($: EngineInterface, current: Connection, wait: number) {
  $.clock.after(wait, () => {
    void poll($, current).then((answered) => {
      if (connection === current)
        schedule($, current, answered ? pollInterval : Math.min(wait * 2, maxPollInterval));
    });
  });
}

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    connection = undefined;
    const sessionId = await $.env.get('CLAUDE_CODE_HOST_SESSION_ID');
    if (sessionId && desktopSession.test(sessionId)) {
      const base = (await $.env.get('CONGRUENCE_URL')) || 'http://127.0.0.1:4310';
      if (loopbackOrigin.test(base)) {
        connection = { base: base.replace(/\/+$/, ''), sessionId, cwd: e.cwd };
        schedule($, connection, pollInterval);
      } else
        $.ui.log(
          'Congruence: CONGRUENCE_URL must be a loopback http origin, such as http://127.0.0.1:4310. The mod stays off.',
        );
    }
    return next(e);
  });

  on('turn.start', async ($, e, next) => {
    const messageId = e.agentId === undefined ? messageMarker.exec(e.text)?.[1] : undefined;
    // Only a message this mod submitted maps its turn, never a marker typed or pasted.
    if (messageId)
      await update($, submitted, (all: Submitted = {}) =>
        all[messageId] === '' ? { ...all, [messageId]: e.turnId } : all,
      );
    return next(e);
  });

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined && connection) {
      const { value: all = {} } = await $.state.get(submitted);
      const messageId = Object.keys(all).find((id) => all[id] === e.turnId);
      if (messageId) {
        await forget($, messageId);
        void report(
          $,
          connection,
          messageId,
          e.reason === 'answer'
            ? { outcome: 'replied', reply: e.answer.slice(0, maxReply) }
            : { outcome: 'stopped', reason: e.reason },
        );
      }
    }
    return next(e);
  });
};
