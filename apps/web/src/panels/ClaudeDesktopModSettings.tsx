import { useEffect, useState } from 'react';
import {
  getClaudeDesktopModSetup,
  installClaudeDesktopModSetup,
  removeClaudeDesktopModSetup,
} from '@congruence/api-client';
import type { ClaudeDesktopModSetup, ClaudeDesktopNotice } from '@congruence/contracts';
import { CopyBlock } from '../components/CopyBlock';
import { Button } from '../components/ui/button';

function connectionStatus(setup: ClaudeDesktopModSetup) {
  const sessions = `${setup.connectedSessions} connected session${setup.connectedSessions === 1 ? '' : 's'}`;
  return setup.installed ? `Installed · ${sessions}` : `Not installed · ${sessions}`;
}

// A session that reported work without the mod highlights Apply; applying clears those notices.
export function ClaudeDesktopModSettings({ notices }: { notices: ClaudeDesktopNotice[] }) {
  const [setup, setSetup] = useState<ClaudeDesktopModSetup>();
  const [error, setError] = useState('');
  const [result, setResult] = useState('');
  const [saving, setSaving] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setError('');
    void getClaudeDesktopModSetup({ signal: controller.signal })
      .then(setSetup)
      .catch((cause) => {
        if (!controller.signal.aborted) setError(cause.message);
      });
    return () => controller.abort();
    // A notice clears when its session connects, so the connected count changes with it.
  }, [revision, notices.length]);
  async function update(action: 'install' | 'remove') {
    if (saving) return;
    setSaving(true);
    setError('');
    setResult('');
    try {
      setSetup(
        await (action === 'remove'
          ? removeClaudeDesktopModSetup()
          : installClaudeDesktopModSetup()),
      );
      setResult(
        action === 'remove'
          ? 'Configuration removed. Restart Claude Desktop to apply the change.'
          : 'Configuration saved. Restart Claude Desktop to load the mod.',
      );
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'The Claude Code settings were not changed.',
      );
    } finally {
      setSaving(false);
    }
  }
  return (
    <div className="agent-connection-settings">
      {setup ? (
        <>
          <p role="status">
            <strong>{connectionStatus(setup)}</strong>
          </p>
          <p>Configuration file on this computer:</p>
          <CopyBlock value={setup.settingsPath} label="Claude Code settings file path" />
          <p>Configuration to add or update:</p>
          <CopyBlock
            value={JSON.stringify(
              { env: { CLAUDE_CODE_PLUGIN_DIRS: setup.pluginDir, CONGRUENCE_URL: setup.url } },
              null,
              2,
            )}
            label="Claude Code settings configuration"
          />
          <div className="connection-settings-actions" aria-busy={saving}>
            <Button
              variant={notices.length ? 'default' : 'secondary'}
              className={notices.length ? 'button-attention' : undefined}
              disabled={saving}
              onClick={() => void update('install')}
            >
              Apply
            </Button>
            <Button variant="ghost" disabled={saving} onClick={() => void update('remove')}>
              Remove from config file
            </Button>
            <Button
              variant="ghost"
              disabled={saving}
              onClick={() => setRevision((value) => value + 1)}
            >
              Refresh
            </Button>
          </div>
        </>
      ) : (
        !error && <p role="status">Loading configuration…</p>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {result && (
        <p className="field-hint" role="status">
          {result}
        </p>
      )}
    </div>
  );
}
