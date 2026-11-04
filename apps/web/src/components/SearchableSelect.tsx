import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Check, ChevronDown, Search } from 'lucide-react';

interface SelectOption {
  value: string;
  label: string;
  description?: string;
}

export function SearchableSelect({
  label,
  searchLabel,
  value,
  options,
  emptyMessage,
  disabled = false,
  onSelect,
  footer,
}: {
  label: string;
  searchLabel: string;
  value?: string;
  options: SelectOption[];
  emptyMessage: string;
  disabled?: boolean;
  onSelect: (value: string) => void;
  footer?: (close: () => void) => ReactNode;
}) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [highlighted, setHighlighted] = useState(value);
  const selected = options.find((option) => option.value === value);
  const filtered = options.filter((option) =>
    `${option.label} ${option.description ?? ''}`
      .toLocaleLowerCase()
      .includes(query.trim().toLocaleLowerCase()),
  );
  const activeIndex = Math.max(
    0,
    filtered.findIndex((option) => option.value === highlighted),
  );
  const active = filtered[activeIndex];

  function close() {
    panel.current?.hidePopover();
    trigger.current?.focus({ preventScroll: true });
  }

  function select(option: SelectOption) {
    close();
    onSelect(option.value);
  }

  function position() {
    const bounds = trigger.current?.getBoundingClientRect();
    if (!bounds || !panel.current) return;
    panel.current.style.setProperty('--picker-left', `${bounds.left}px`);
    panel.current.style.setProperty('--picker-top', `${Math.max(12, bounds.bottom + 7)}px`);
  }

  useEffect(() => {
    if (!open) return;
    input.current?.focus({ preventScroll: true });
    // Clicks in a sandboxed dashboard don't reach the parent document's light dismissal.
    function dismissForFrame() {
      if (document.activeElement instanceof HTMLIFrameElement) panel.current?.hidePopover();
    }
    window.addEventListener('blur', dismissForFrame);
    window.addEventListener('resize', position);
    window.addEventListener('scroll', position, true);
    return () => {
      window.removeEventListener('blur', dismissForFrame);
      window.removeEventListener('resize', position);
      window.removeEventListener('scroll', position, true);
    };
  }, [open]);

  useEffect(() => {
    if (open && active)
      document.getElementById(`${id}-option-${activeIndex}`)?.scrollIntoView({ block: 'nearest' });
  }, [open, active?.value, activeIndex, id]);

  return (
    <div
      className="header-picker"
      onBlur={(event) => {
        if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget))
          panel.current?.hidePopover();
      }}
    >
      <button
        type="button"
        className="picker-trigger"
        ref={trigger}
        popoverTarget={id}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={id}
        aria-label={`${label}: ${selected?.label ?? 'None'}`}
        title={selected?.label}
        disabled={disabled}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            panel.current?.showPopover();
          }
        }}
      >
        <span className="picker-value">
          <span className="picker-label">{label}</span>
          <span className="picker-name">{selected?.label ?? 'Select workspace'}</span>
        </span>
        <ChevronDown size={14} className="picker-chevron" />
      </button>
      <div
        id={id}
        ref={panel}
        popover="auto"
        className="picker-popover"
        role="dialog"
        aria-label={`Choose ${label.toLowerCase()}`}
        onBeforeToggle={(event) => {
          if (event.newState === 'open') {
            position();
            setQuery('');
            setHighlighted(value);
          }
        }}
        onToggle={(event) => setOpen(event.newState === 'open')}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            close();
          }
        }}
      >
        <div className="picker-search">
          <Search size={15} aria-hidden="true" />
          <input
            ref={input}
            role="combobox"
            aria-label={searchLabel}
            placeholder={`${searchLabel}…`}
            aria-autocomplete="list"
            aria-expanded={open}
            aria-controls={`${id}-options`}
            aria-activedescendant={active ? `${id}-option-${activeIndex}` : undefined}
            autoComplete="off"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setHighlighted(undefined);
            }}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault();
                const step = event.key === 'ArrowDown' ? 1 : -1;
                setHighlighted(
                  filtered[(activeIndex + step + filtered.length) % filtered.length]?.value,
                );
              } else if (event.key === 'Enter' && active) {
                event.preventDefault();
                select(active);
              }
            }}
          />
        </div>
        <div id={`${id}-options`} role="listbox" aria-label={label} className="picker-options">
          {filtered.map((option, index) => (
            <div
              id={`${id}-option-${index}`}
              key={option.value}
              role="option"
              aria-selected={option.value === value}
              aria-label={option.label}
              aria-describedby={option.description ? `${id}-description-${index}` : undefined}
              className={`picker-option ${index === activeIndex ? 'is-active' : ''}`}
              onPointerMove={() => setHighlighted(option.value)}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => select(option)}
            >
              <span className="picker-option-text">
                <span>{option.label}</span>
                {option.description && (
                  <small id={`${id}-description-${index}`}>{option.description}</small>
                )}
              </span>
              {option.value === value && <Check size={15} aria-hidden="true" />}
            </div>
          ))}
        </div>
        {!filtered.length && (
          <p className="picker-empty" role="status">
            {emptyMessage}
          </p>
        )}
        {footer && <div className="picker-footer">{footer(close)}</div>}
      </div>
    </div>
  );
}
