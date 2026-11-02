import type { Activity } from '@congruence/contracts';

export function desktopSessionLink(item: Activity) {
  const session =
    item.agentTarget?.provider === 'codex-desktop'
      ? item.agentTarget
      : item.agentTarget?.provider === 'claude-desktop'
        ? { provider: 'claude' as const, sessionId: item.agentTarget.sessionId }
        : item.desktopSession;
  if (!session) return undefined;
  const id = session.sessionId;
  if (session.provider === 'codex-desktop' && /^(?!new$)[A-Za-z0-9_-]+$/.test(id))
    return { label: 'Open in Codex', href: `codex://threads/${encodeURIComponent(id)}` };
  // Verified in Claude Desktop 4.4212.0: this route selects an existing local Code session.
  if (session.provider === 'claude' && /^local_[A-Za-z0-9-]{1,64}$/.test(id))
    return {
      label: 'Open in Claude',
      href: `claude://code/continue?session=${encodeURIComponent(id)}`,
    };
  return undefined;
}
