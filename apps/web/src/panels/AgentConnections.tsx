import { useEffect, useId, useState } from 'react';
import {
  getClaudeDesktopMcpSetup,
  installClaudeDesktopMcpSetup,
  removeClaudeDesktopMcpSetup,
  getCodexMcpSetup,
  installCodexMcpSetup,
  removeCodexMcpSetup,
} from '@congruence/api-client';
import type { Workspace } from '@congruence/contracts';
import { CopyBlock } from '../components/CopyBlock';
import { Dialog } from '../components/Dialog';
import { Button } from '../components/ui/button';
import { AgentConnectionSettings } from './AgentConnectionSettings';
import { ClaudeDesktopModSettings } from './ClaudeDesktopModSettings';
import {
  AgentSettingsReview,
  missingModText,
  requestProvider,
  settingsAttention,
  type useAgentSettingsReview,
} from './AgentSettingsReview';
import { Tabs } from '../components/ui/tabs';

const sections = [
  { value: 'setup', label: 'MCP setup' },
  { value: 'settings', label: 'Agent settings' },
] as const;
const providers = [
  { value: 'codex-desktop', label: 'Codex Desktop' },
  { value: 'claude-desktop', label: 'Claude Code Desktop' },
] as const;

const endpoint = import.meta.env.DEV
  ? 'http://127.0.0.1:4310/mcp'
  : `${window.location.origin}/mcp`;

type DesktopProvider = 'codex-desktop' | 'claude-desktop';

function DesktopMcpSetup({ provider }: { provider: DesktopProvider }) {
  const isClaude = provider === 'claude-desktop';
  const client = isClaude ? 'Claude Code Desktop' : 'Codex Desktop';
  const getSetup = isClaude ? getClaudeDesktopMcpSetup : getCodexMcpSetup;
  const installSetup = isClaude ? installClaudeDesktopMcpSetup : installCodexMcpSetup;
  const removeSetup = isClaude ? removeClaudeDesktopMcpSetup : removeCodexMcpSetup;
  const [config, setConfig] = useState<Awaited<ReturnType<typeof getCodexMcpSetup>>>();
  const [error, setError] = useState('');
  const [result, setResult] = useState('');
  const [method, setMethod] = useState<'automatic' | 'manual'>('automatic');
  const [saving, setSaving] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setError('');
    void getSetup({ signal: controller.signal })
      .then(setConfig)
      .catch((cause) => {
        if (!controller.signal.aborted) setError(cause.message);
      });
    return () => controller.abort();
  }, [revision, getSetup]);
  async function update(action: 'apply' | 'remove' = 'apply') {
    if (saving) return;
    setSaving(true);
    setError('');
    setResult('');
    try {
      const next = await (action === 'remove' ? removeSetup() : installSetup());
      setConfig(next);
      setResult(
        action === 'remove'
          ? `Congruence configuration removed. Restart ${client} to apply the change.`
          : `Configuration saved. Restart ${client} to load the connection.`,
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Configuration could not be saved.');
    } finally {
      setSaving(false);
    }
  }
  return (
    <div className="mcp-setup-options">
      <Tabs
        label="Setup method"
        variant="segmented"
        items={
          [
            { value: 'automatic', label: 'Config file' },
            ...(!isClaude ? ([{ value: 'manual', label: 'Manual setup' }] as const) : []),
          ] as const
        }
        value={method}
        onValueChange={setMethod}
      >
        {(value) =>
          value === 'automatic' ? (
            <section className="mcp-setup-option" aria-label="Automatic configuration">
              {config ? (
                <>
                  <p>Configuration file on this computer:</p>
                  <CopyBlock value={config.configPath} label="config file path" />
                  <p>Configuration to add or update:</p>
                  <CopyBlock
                    value={
                      isClaude
                        ? JSON.stringify(
                            { mcpServers: { congruence: { type: 'http', url: config.endpoint } } },
                            null,
                            2,
                          )
                        : `[mcp_servers.congruence]\nenabled = true\nurl = ${JSON.stringify(config.endpoint)}`
                    }
                    label="MCP configuration"
                  />
                  <div className="mcp-setup-actions" aria-busy={saving}>
                    <Button variant="secondary" disabled={saving} onClick={() => void update()}>
                      Apply
                    </Button>
                    <Button variant="ghost" disabled={saving} onClick={() => void update('remove')}>
                      Remove from config file
                    </Button>
                  </div>
                  {saving && <p role="status">Updating configuration…</p>}
                </>
              ) : !error ? (
                <p role="status">Loading configuration file location…</p>
              ) : (
                <Button variant="secondary" onClick={() => setRevision((value) => value + 1)}>
                  Retry
                </Button>
              )}
              {error && (
                <p className="form-error" role="alert">
                  {error}
                </p>
              )}
              {result && <p role="status">{result}</p>}
            </section>
          ) : (
            <section className="mcp-setup-option" aria-label="Manual configuration">
              <h4>Set up manually</h4>
              <p>
                In Codex Desktop, open Settings → Plugins → MCPs. Click Add and add an HTTP server
                named <code>congruence</code> with this URL:
              </p>
              <CopyBlock value={config?.endpoint ?? endpoint} label="MCP endpoint" />
            </section>
          )
        }
      </Tabs>
    </div>
  );
}

export function AgentConnections({
  workspace,
  workspaces,
  review,
  onClose,
}: {
  workspace?: Workspace;
  workspaces: Workspace[];
  review: ReturnType<typeof useAgentSettingsReview>;
  onClose: () => void;
}) {
  const pending = (review.review?.requests ?? []).filter(
    (request) => request.status === 'pending' && requestProvider(request) === 'codex-desktop',
  );
  const attention = settingsAttention(review.review);
  // Open where something needs the human: Codex requests first, then the Claude tab.
  const [provider, setProvider] = useState<DesktopProvider>(() =>
    !attention.codexDesktop && attention.claudeDesktop ? 'claude-desktop' : 'codex-desktop',
  );
  const [section, setSection] = useState<'setup' | 'settings'>(() =>
    attention.total ? 'settings' : 'setup',
  );
  const attentionText = [
    attention.requests > 0 &&
      `${attention.requests} pending ${attention.requests === 1 ? 'request' : 'requests'}`,
    attention.missingMod > 0 && missingModText(attention.missingMod),
  ]
    .filter(Boolean)
    .join('; ');
  const sectionId = useId();
  const [connectionRevision, setConnectionRevision] = useState(0);
  return (
    <Dialog title="Agents" onClose={onClose} className="agents-dialog">
      <div className="agents-layout">
        <nav className="agents-navigation" aria-label="Agent sections">
          {sections.map((item) => (
            <button
              key={item.value}
              type="button"
              aria-label={item.label}
              aria-current={section === item.value ? 'page' : undefined}
              aria-controls={sectionId}
              aria-describedby={
                item.value === 'settings' && attention.total ? sectionId + '-pending' : undefined
              }
              onClick={() => setSection(item.value)}
            >
              {item.label}
              {item.value === 'settings' && attention.total > 0 && (
                <span className="approval-count" aria-hidden="true">
                  {attention.total}
                </span>
              )}
            </button>
          ))}
          <span className="sr-only" id={sectionId + '-pending'} role="status">
            {attentionText}
          </span>
        </nav>
        <section className="agents-content" id={sectionId} aria-labelledby={sectionId + '-heading'}>
          <h3 id={sectionId + '-heading'}>
            {sections.find((item) => item.value === section)?.label}
          </h3>
          <Tabs<DesktopProvider>
            key={section}
            label="Agent provider"
            items={providers.map((item) => ({
              ...item,
              badge:
                item.value === 'codex-desktop' ? attention.codexDesktop : attention.claudeDesktop,
            }))}
            value={provider}
            onValueChange={setProvider}
          >
            {() => (
              <div key={section} className="agents-pane">
                {section === 'setup' ? (
                  <DesktopMcpSetup key={provider} provider={provider} />
                ) : provider === 'codex-desktop' ? (
                  <AgentSettingsReview
                    state={review}
                    workspaces={workspaces}
                    provider={provider}
                    onApplied={() => {
                      setConnectionRevision((value) => value + 1);
                    }}
                  >
                    <div
                      className={
                        pending.some((request) => requestProvider(request) === provider)
                          ? 'agents-current-settings'
                          : ''
                      }
                    >
                      {pending.some((request) => requestProvider(request) === provider) && (
                        <h3>Current settings</h3>
                      )}
                      <AgentConnectionSettings
                        key={provider + ':' + connectionRevision}
                        workspaceId={workspace?.id}
                        showHeading={false}
                      />
                    </div>
                  </AgentSettingsReview>
                ) : (
                  <ClaudeDesktopModSettings notices={review.review?.claudeDesktopNotices ?? []} />
                )}
              </div>
            )}
          </Tabs>
        </section>
      </div>
    </Dialog>
  );
}
