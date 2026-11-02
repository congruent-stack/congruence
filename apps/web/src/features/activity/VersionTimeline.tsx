import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent, PointerEvent } from 'react';
import type { Activity } from '@congruence/contracts';

type Pin = 'from' | 'to';

export interface VersionTimelineProps {
  versions: Activity[];
  fromRevision: number;
  toRevision: number;
  onFromChange: (revision: number) => void;
  onToChange: (revision: number) => void;
}

export function VersionTimeline({
  versions,
  fromRevision,
  toRevision,
  onFromChange,
  onToChange,
}: VersionTimelineProps) {
  const ordered = [...versions].sort((left, right) => left.revision - right.revision);
  const fromIndex = Math.max(
    0,
    ordered.findIndex((version) => version.revision === fromRevision),
  );
  const toIndex = Math.max(
    fromIndex,
    ordered.findIndex((version) => version.revision === toRevision),
  );
  const scrollRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const fromRef = useRef<HTMLButtonElement>(null);
  const toRef = useRef<HTMLButtonElement>(null);
  const rangeRef = useRef({ from: fromIndex, to: toIndex });
  rangeRef.current = { from: fromIndex, to: toIndex };
  const dragRef = useRef<
    { pin: Pin; pointerId: number; clientX: number; offsetX: number } | undefined
  >(undefined);
  const frameRef = useRef<number | undefined>(undefined);
  const initialRevealRef = useRef(false);
  const [activePin, setActivePin] = useState<Pin>('to');
  const [dragging, setDragging] = useState<Pin>();
  const hintId = useId();
  const lastIndex = ordered.length - 1;
  const contentWidth = Math.max(0, lastIndex) * 56 + 56;
  const position = (index: number) => (lastIndex > 0 ? (index / lastIndex) * 100 : 0);

  function reveal(index: number) {
    const scroller = scrollRef.current;
    const track = trackRef.current;
    if (!scroller || !track) return;
    const center = track.offsetLeft + (track.clientWidth * position(index)) / 100;
    const padding = 28;
    if (center - padding < scroller.scrollLeft) scroller.scrollLeft = center - padding;
    else if (center + padding > scroller.scrollLeft + scroller.clientWidth)
      scroller.scrollLeft = center + padding - scroller.clientWidth;
  }

  function choose(pin: Pin, index: number, scroll = false) {
    const range = rangeRef.current;
    const next = Math.max(
      pin === 'to' ? range.from : 0,
      Math.min(index, pin === 'from' ? range.to : lastIndex),
    );
    if (range[pin] !== next) {
      rangeRef.current = { ...range, [pin]: next };
      (pin === 'from' ? onFromChange : onToChange)(ordered[next].revision);
    }
    if (scroll) reveal(next);
  }

  function moveDrag() {
    const drag = dragRef.current;
    const track = trackRef.current;
    if (!drag || !track) return;
    const bounds = track.getBoundingClientRect();
    if (!bounds.width) return;
    const fraction = (drag.clientX - drag.offsetX - bounds.left) / bounds.width;
    choose(drag.pin, Math.round(fraction * lastIndex));
  }
  const moveDragRef = useRef(moveDrag);
  moveDragRef.current = moveDrag;

  function stopDrag() {
    dragRef.current = undefined;
    if (frameRef.current !== undefined) cancelAnimationFrame(frameRef.current);
    frameRef.current = undefined;
    setDragging(undefined);
  }

  function startDrag(event: PointerEvent<HTMLButtonElement>, pin: Pin) {
    if (!event.isPrimary || event.button !== 0 || dragRef.current) return;
    event.preventDefault();
    event.currentTarget.focus({ preventScroll: true });
    event.currentTarget.setPointerCapture(event.pointerId);
    const bounds = event.currentTarget.getBoundingClientRect();
    dragRef.current = {
      pin,
      pointerId: event.pointerId,
      clientX: event.clientX,
      offsetX: event.clientX - bounds.left - bounds.width / 2,
    };
    setActivePin(pin);
    setDragging(pin);

    function advance() {
      const drag = dragRef.current;
      const scroller = scrollRef.current;
      if (!drag || !scroller) return;
      const bounds = scroller.getBoundingClientRect();
      const edge = 36;
      const direction =
        drag.clientX < bounds.left + edge
          ? -Math.min(1, (bounds.left + edge - drag.clientX) / edge)
          : drag.clientX > bounds.right - edge
            ? Math.min(1, (drag.clientX - bounds.right + edge) / edge)
            : 0;
      if (direction) {
        const previous = scroller.scrollLeft;
        scroller.scrollLeft += direction * 12;
        if (scroller.scrollLeft !== previous) moveDragRef.current();
      }
      frameRef.current = requestAnimationFrame(advance);
    }
    frameRef.current = requestAnimationFrame(advance);
  }

  function keyboard(event: KeyboardEvent<HTMLButtonElement>, pin: Pin) {
    const index = rangeRef.current[pin];
    const destinations: Record<string, number> = {
      ArrowLeft: index - 1,
      ArrowDown: index - 1,
      ArrowRight: index + 1,
      ArrowUp: index + 1,
      Home: 0,
      End: lastIndex,
      PageDown: index - 5,
      PageUp: index + 5,
    };
    const next = destinations[event.key];
    if (next === undefined) return;
    event.preventDefault();
    setActivePin(pin);
    choose(pin, next, true);
  }

  // Reveal the initial comparison without moving the user's viewport on live updates.
  useLayoutEffect(() => {
    if (!initialRevealRef.current && ordered.length) {
      reveal(toIndex);
      initialRevealRef.current = true;
    }
  }, [ordered.length]);
  useEffect(
    () => () => {
      dragRef.current = undefined;
      if (frameRef.current !== undefined) cancelAnimationFrame(frameRef.current);
    },
    [],
  );

  if (!ordered.length) return null;

  function pinButton(pin: Pin) {
    const index = pin === 'from' ? fromIndex : toIndex;
    const version = ordered[index];
    return (
      <button
        ref={pin === 'from' ? fromRef : toRef}
        type="button"
        role="slider"
        className={`history-timeline-pin history-timeline-pin-${pin}${dragging === pin ? ' dragging' : ''}`}
        style={{ left: `${position(index)}%` }}
        aria-label={pin === 'from' ? 'From version' : 'To version'}
        aria-describedby={hintId}
        aria-orientation="horizontal"
        aria-valuemin={ordered[pin === 'from' ? 0 : fromIndex].revision}
        aria-valuemax={ordered[pin === 'from' ? toIndex : lastIndex].revision}
        aria-valuenow={version.revision}
        aria-valuetext={`Version ${version.revision}, ${new Date(version.updatedAt).toLocaleString()}${index === lastIndex ? ', current' : ''}`}
        title={`${pin === 'from' ? 'From' : 'To'} v${version.revision} · ${new Date(version.updatedAt).toLocaleString()}${index === lastIndex ? ' · Current' : ''}`}
        onFocus={() => setActivePin(pin)}
        onKeyDown={(event) => keyboard(event, pin)}
        onPointerDown={(event) => startDrag(event, pin)}
        onPointerMove={(event) => {
          if (dragRef.current?.pointerId !== event.pointerId) return;
          dragRef.current.clientX = event.clientX;
          moveDrag();
        }}
        onPointerUp={(event) => {
          if (dragRef.current?.pointerId !== event.pointerId) return;
          dragRef.current.clientX = event.clientX;
          moveDrag();
          stopDrag();
          event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onPointerCancel={stopDrag}
        onLostPointerCapture={stopDrag}
      >
        <span className="history-timeline-pin-label" aria-hidden="true">
          {pin === 'from' ? 'From' : 'To'} v{version.revision}
        </span>
      </button>
    );
  }

  return (
    <section className="history-timeline" aria-label="Version comparison timeline">
      <div className="history-timeline-scroll" ref={scrollRef} style={{ width: contentWidth }}>
        <div className="history-timeline-content" style={{ width: contentWidth }}>
          <div className="history-timeline-track" ref={trackRef}>
            <div
              className="history-timeline-range"
              style={{
                left: `${position(fromIndex)}%`,
                width: `${position(toIndex) - position(fromIndex)}%`,
              }}
            />
            {pinButton('from')}
            {pinButton('to')}
            {ordered.map((version, index) => (
              <button
                key={version.revision}
                type="button"
                tabIndex={-1}
                className="history-timeline-node"
                style={{ left: `${position(index)}%` }}
                aria-label={`Version ${version.revision}`}
                aria-current={index === lastIndex ? 'true' : undefined}
                title={`v${version.revision} · ${new Date(version.updatedAt).toLocaleString()}${index === lastIndex ? ' · Current' : ''}`}
                data-selected={index >= fromIndex && index <= toIndex}
                onClick={() => {
                  const fromDistance = Math.abs(index - fromIndex);
                  const toDistance = Math.abs(index - toIndex);
                  const pin =
                    fromDistance === toDistance
                      ? activePin
                      : fromDistance < toDistance
                        ? 'from'
                        : 'to';
                  setActivePin(pin);
                  (pin === 'from' ? fromRef : toRef).current?.focus({ preventScroll: true });
                  choose(pin, index, true);
                }}
              >
                <span aria-hidden="true">{version.revision}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
      <p className="sr-only" id={hintId}>
        Drag the pins or use the arrow keys to compare versions.
      </p>
    </section>
  );
}
