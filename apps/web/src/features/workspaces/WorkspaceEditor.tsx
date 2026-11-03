import { useState, type FormEvent } from 'react';
import Schema from 'typebox/schema';
import { WorkspaceInputSchema, type Workspace, type WorkspaceInput } from '@congruence/contracts';
import { FolderGit2, LoaderCircle, Plus } from 'lucide-react';
import { Dialog } from '../../components/Dialog';
import { Button } from '../../components/ui/button';

const validator = Schema.Compile(WorkspaceInputSchema);

export function WorkspaceEditor({
  workspace,
  onSave,
  onClose,
  inline = false,
}: {
  workspace?: Workspace;
  onSave: (input: WorkspaceInput) => Promise<void>;
  onClose: () => void;
  inline?: boolean;
}) {
  const [name, setName] = useState(workspace?.name ?? '');
  const [description, setDescription] = useState(workspace?.description ?? '');
  const [repositories, setRepositories] = useState(workspace?.repositories.join('\n') ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function submit(event: FormEvent) {
    event.preventDefault();
    const input = {
      name: name.trim(),
      description: description.trim(),
      repositories: [
        ...new Set(
          repositories
            .split('\n')
            .map((value) => value.trim())
            .filter(Boolean),
        ),
      ],
    };
    if (!validator.Check(input)) {
      setError(
        'Use a name up to 120 characters, a description up to 1,000 characters, and at most 50 repository references of 2,000 characters each.',
      );
      return;
    }
    setSaving(true);
    setError('');
    try {
      await onSave(input);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Could not save this workspace. Please try again.',
      );
      setSaving(false);
    }
  }

  const title = workspace ? 'Edit workspace' : 'New workspace';
  const form = (
    <form onSubmit={submit} className="workspace-form">
      <label>
        Workspace name{' '}
        <input
          autoFocus
          required
          maxLength={120}
          placeholder="e.g. Personal projects"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      <label>
        Description <span className="optional">Optional</span>
        <textarea
          rows={2}
          maxLength={1000}
          placeholder="What belongs in this workspace?"
          value={description}
          onChange={(event) => setDescription(event.target.value)}
        />
      </label>
      <label>
        <span className="label-with-icon">
          <FolderGit2 size={16} />
          Repositories <span className="optional">Optional</span>
        </span>
        <textarea
          rows={3}
          className="mono"
          placeholder={'https://github.com/you/project\nD:\\dev\\another-project'}
          value={repositories}
          onChange={(event) => setRepositories(event.target.value)}
        />
      </label>
      <p className="field-hint">One URL or local path per line.</p>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="dialog-footer">
        <Button variant="secondary" onClick={onClose} disabled={saving}>
          Cancel
        </Button>
        <Button type="submit" disabled={saving}>
          {saving ? (
            <LoaderCircle className="spin" size={16} />
          ) : workspace ? null : (
            <Plus size={16} />
          )}
          {saving ? 'Saving…' : workspace ? 'Save changes' : 'Create workspace'}
        </Button>
      </div>
    </form>
  );
  return inline ? (
    <>
      <h2>{title}</h2>
      {form}
    </>
  ) : (
    <Dialog title={title} onClose={() => !saving && onClose()}>
      {form}
    </Dialog>
  );
}
