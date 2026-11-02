import { useId, useRef, type ReactNode } from 'react';

export function Tabs<Value extends string>({
  label,
  items,
  value,
  onValueChange,
  children,
  variant = 'underline',
}: {
  label: string;
  items: ReadonlyArray<{ value: Value; label: string; badge?: number }>;
  value: Value;
  onValueChange: (value: Value) => void;
  children: (value: Value) => ReactNode;
  variant?: 'underline' | 'segmented';
}) {
  const id = useId();
  const buttons = useRef<Array<HTMLButtonElement | null>>([]);
  return (
    <div className={variant === 'segmented' ? 'tabs tabs-segmented' : 'tabs'}>
      <div className="tabs-list" role="tablist" aria-label={label}>
        {items.map((item, index) => (
          <button
            key={item.value}
            ref={(element) => {
              buttons.current[index] = element;
            }}
            type="button"
            role="tab"
            id={`${id}-tab-${item.value}`}
            aria-controls={`${id}-panel-${item.value}`}
            aria-selected={item.value === value}
            aria-label={item.label}
            aria-describedby={item.badge ? `${id}-badge-${item.value}` : undefined}
            tabIndex={item.value === value ? 0 : -1}
            onClick={() => onValueChange(item.value)}
            onKeyDown={(event) => {
              let next: number;
              switch (event.key) {
                case 'ArrowRight':
                  next = (index + 1) % items.length;
                  break;
                case 'ArrowLeft':
                  next = (index - 1 + items.length) % items.length;
                  break;
                case 'Home':
                  next = 0;
                  break;
                case 'End':
                  next = items.length - 1;
                  break;
                default:
                  return;
              }
              event.preventDefault();
              onValueChange(items[next].value);
              buttons.current[next]?.focus();
            }}
          >
            {item.label}
            {Boolean(item.badge) && (
              <>
                <span className="approval-count" aria-hidden="true">
                  {item.badge}
                </span>
                <span className="sr-only" id={`${id}-badge-${item.value}`}>
                  {item.badge} pending {item.badge === 1 ? 'request' : 'requests'}
                </span>
              </>
            )}
          </button>
        ))}
      </div>
      {items.map((item) => (
        <div
          key={item.value}
          role="tabpanel"
          className="tabs-panel"
          id={`${id}-panel-${item.value}`}
          aria-labelledby={`${id}-tab-${item.value}`}
          hidden={item.value !== value}
          tabIndex={0}
        >
          {item.value === value && children(item.value)}
        </div>
      ))}
    </div>
  );
}
