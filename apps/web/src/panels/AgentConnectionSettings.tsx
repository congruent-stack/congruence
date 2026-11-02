import { useEffect, useState } from 'react';
import { getAgentSettings, updateAgentSettings, listAgentSessions } from '@congruence/api-client';
import type { AgentSettings } from '@congruence/contracts';
import { Button } from '../components/ui/button';

export function AgentConnectionSettings({
  workspaceId,
  showHeading = true,
  onSaved,
}: {
  workspaceId?: string;
  showHeading?: boolean;
  onSaved?: () => void;
}) {
  const [settings, setSettings] = useState<AgentSettings>();
  const [error, setError] = useState('');
  const [result, setResult] = useState('');
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    void getAgentSettings({ signal: controller.signal })
      .then(setSettings)
      .catch((cause) => {
        if (!controller.signal.aborted) setError(cause.message);
      });
    return () => controller.abort();
  }, []);
  async function save(clearCodex = false) {
    if (!settings || saving) return;
    setSaving(true);
    setError('');
    setResult('');
    try {
      setSettings(
        await updateAgentSettings(
          clearCodex
            ? { ...settings, codexCommand: '', codexUrl: 'ws://127.0.0.1:4500', codexSocket: '' }
            : settings,
        ),
      );
      onSaved?.();
      if (clearCodex) {
        setResult(
          'Codex settings cleared. Your agent can now propose its executable path for your approval.',
        );
      } else if (workspaceId) {
        const directory = await listAgentSessions(workspaceId);
        const failure = directory.desktopError;
        if (failure) setError(`Settings saved. ${failure}`);
        else {
          const count = directory.sessions.filter(
            (session) => session.provider === 'codex-desktop',
          ).length;
          setResult(
            `Settings saved. Connection working. Found ${count} Desktop chat${count === 1 ? '' : 's'} in this workspace.`,
          );
        }
      } else setResult('Settings saved.');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Connection could not be checked.');
    } finally {
      setSaving(false);
    }
  }
  return (
    <div className="agent-connection-settings">
      {showHeading && <h3>Agent settings</h3>}
      {settings ? (
        <>
          <label htmlFor="codex-command-desktop">Codex executable</label>
          <input
            id="codex-command-desktop"
            value={settings.codexCommand}
            disabled={saving}
            placeholder="Full path to codex.exe"
            onChange={(event) => setSettings({ ...settings, codexCommand: event.target.value })}
          />
          <p className="field-hint">
            Enter the executable path without quotes or command arguments.
          </p>
          <div className="connection-settings-actions">
            <Button
              variant="secondary"
              disabled={saving || !settings.codexCommand.trim()}
              onClick={() => void save()}
            >
              {saving ? 'Saving and testing…' : 'Save and test'}
            </Button>
            <Button variant="ghost" disabled={saving} onClick={() => void save(true)}>
              Clear Codex settings
            </Button>
          </div>
        </>
      ) : (
        !error && <p role="status">Loading connection settings…</p>
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
