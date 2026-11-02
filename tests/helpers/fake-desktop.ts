import type { AgentMessage, AgentSession } from '../../packages/contracts/src/index.js';
import type {
  DesktopAdapter,
  DesktopReceipt,
} from '../../apps/server/src/features/agents/desktop.js';

export class FakeDesktop implements DesktopAdapter {
  sessions: AgentSession[] = [
    {
      provider: 'codex-desktop',
      sessionId: 'desktop-chat',
      name: 'Existing Desktop chat',
      cwd: 'D:/test-project',
      state: 'saved',
    },
  ];
  sent: Array<{ sessionId: string; text: string; repositories: string[] }> = [];
  receipts = new Map<string, DesktopReceipt>();
  checks = 0;
  failure?: Error;
  async listSessions() {
    return this.sessions;
  }
  async send(sessionId: string, text: string, repositories: string[]) {
    this.sent.push({ sessionId, text, repositories });
    if (this.failure) throw this.failure;
  }
  async receipt(message: AgentMessage) {
    this.checks++;
    return this.receipts.get(message.id);
  }
  close() {}
}
