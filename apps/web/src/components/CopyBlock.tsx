import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { Button } from './ui/button';

export function CopyBlock({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setError(false);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError(true);
    }
  }
  return (
    <>
      <div className="copy-block">
        <code>{value}</code>
        <Button
          variant="ghost"
          size="icon"
          aria-label={copied ? 'Copied' : `Copy ${label}`}
          onClick={copy}
        >
          {copied ? <Check size={17} /> : <Copy size={17} />}
        </Button>
      </div>
      {error && (
        <p className="field-hint" role="status">
          Select and copy the text above. Clipboard access is unavailable.
        </p>
      )}
    </>
  );
}
