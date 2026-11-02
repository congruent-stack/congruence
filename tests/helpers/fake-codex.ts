import type { AgentSession } from '../../packages/contracts/src/index.js';
import type { CodexAdapter } from '../../apps/server/src/features/agents/codex.js';

export class FakeCodex implements CodexAdapter {
  sessions: AgentSession[] = [
    {
      provider: 'codex',
      sessionId: 'test-codex',
      name: 'Integration session',
      cwd: 'D:/test-project',
      state: 'idle',
    },
  ];
  sent: Array<{ sessionId: string; text: string }> = [];
  answered: Array<{ id: number | string; result: Record<string, any> }> = [];
  failure?: Error;
  onNotification: CodexAdapter['onNotification'] = () => {};
  onRequest: CodexAdapter['onRequest'] = () => {};
  onDisconnect = () => {};
  async listSessions() {
    return this.sessions;
  }
  async send(sessionId: string, text: string) {
    if (this.failure) throw this.failure;
    this.sent.push({ sessionId, text });
    return {
      turnId: 'test-turn',
      detail: 'Accepted by Codex; a new turn started in the same chat.',
    };
  }
  respond(id: number | string, result: Record<string, any>) {
    this.answered.push({ id, result });
  }
  close() {}
}
