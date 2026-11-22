// Slider (decision what-if-as-a2ui-calls): a number the user sets. A number field, and a range beside it when min < max.
// A number is written to the $/path `value` binds through A2UI's own setter (`setValue`, from GenericBinder), so
// every call reading that path (div($/w/seats,60) in a Stat, a Stats row) is computed again in the tab at once,
// without the server.
// The number is committed on blur, Enter, range pointer-up or key-up, 600 ms after the last write, or unmount: it
// is then posted as gl_set {value}, and the server keeps it (a reload or a re-show keeps what the user set) and tells
// the agent what it computed. Nothing is posted per keystroke.
// The field keeps what is being typed until it is committed. While typing, only a number inside [min, max] is
// written; on commit what was typed is held to min and max. Text that is not a number is dropped on commit and the
// field shows the number again.
// Under the field: why the values computed from this number have none at it ('Not computed at this value: division
// by zero'). That is the user's own input, so it is told to the user here and to the agent in the `viewer: set` line,
// never as a report. A bound value that is not a number is the spec's problem: W_VALUE.
// Kept in the lazy `charts` chunk for the eager budget, although it is an input.
import type * as C from '@glimpse/catalog';
import {inputValue} from '@glimpse/catalog';
import {useEffect, useId, useRef, useState} from 'react';
import {useCalcNote} from '../../kit/calcNote.ts';
import {useHostActions, useReportState, type GlView} from '../../kit/index.ts';
import styles from './Slider.module.css';

/** Idle time after the last write before the number is committed. */
const IDLE_MS = 600;

const finite = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/** The number typed text spells, or undefined ('' is not 0). */
function parse(text: string): number | undefined {
  const trimmed = text.trim();
  return trimmed === '' ? undefined : finite(Number(trimmed));
}

/** A value for a message: JSON, at most 40 characters (as the server says it). */
function shown(v: unknown): string {
  let text: string;
  try {
    text = typeof v === 'number' ? String(v) : (JSON.stringify(v) ?? String(v));
  } catch {
    text = String(v);
  }
  return text.length > 40 ? `${text.slice(0, 39)}…` : text;
}

export const SliderView: GlView<typeof C.Slider> = ({id, props}) => {
  const host = useHostActions(id);
  // GenericBinder gives every bindable prop a setter that writes the path the spec bound it to.
  const setValue = (props as {setValue?: (value: number) => void}).setValue;
  const labelId = useId();
  const fieldId = useId();
  const label = typeof props.label === 'string' ? props.label.trim() : '';
  const unit = typeof props.unit === 'string' ? props.unit.trim() : '';
  const min = finite(props.min);
  const max = finite(props.max);
  const ranged = min !== undefined && max !== undefined && min < max;
  const written = finite(props.step);
  const step = written !== undefined && written > 0 ? written : ranged ? (max - min) / 100 : undefined;

  const raw: unknown = props.value;
  const current = finite(raw);
  const wrong = raw !== undefined && raw !== null && current === undefined;
  const wrongText = `value is ${shown(raw)}, not a number`;
  useReportState(wrong ? 'W_VALUE' : undefined, wrongText);
  const reason = useCalcNote(id);

  // What is being typed, until it is committed; undefined: the field shows the bound number.
  const [draft, setDraft] = useState<string>();
  // The number written and not posted yet.
  const pending = useRef<number>(undefined);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const commit = () => {
    clearTimeout(timer.current);
    timer.current = undefined;
    const value = pending.current;
    if (value === undefined) return;
    pending.current = undefined;
    host.set(value);
  };
  // The idle timer and the unmount clean-up call the commit of the latest render.
  const latest = useRef(commit);
  latest.current = commit;
  useEffect(() => () => latest.current(), []);

  const write = (n: number) => {
    const value = inputValue(n, {min, max});
    if (value === undefined || !setValue) return;
    setValue(value);
    pending.current = value;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => latest.current(), IDLE_MS);
  };
  // Blur or Enter: what was typed is held to min and max, written and committed.
  const settle = () => {
    if (draft !== undefined) {
      const typed = parse(draft);
      if (typed !== undefined) write(typed);
      setDraft(undefined);
    }
    commit();
  };

  const note = wrong ? wrongText : reason ? `Not computed at this value: ${reason}` : '';
  return (
    <div className={styles.slider}>
      {label ? (
        <label className={styles.label} id={labelId} htmlFor={fieldId}>
          {label}
        </label>
      ) : null}
      <div className={styles.controls}>
        {ranged ? (
          <input
            className={styles.range}
            type="range"
            min={min}
            max={max}
            step={step}
            value={current === undefined ? min : Math.min(max, Math.max(min, current))}
            aria-labelledby={label ? labelId : undefined}
            aria-label={label ? undefined : 'Value'}
            aria-valuetext={current === undefined ? undefined : unit ? `${current} ${unit}` : String(current)}
            onChange={event => {
              setDraft(undefined);
              const value = parse(event.target.value);
              if (value !== undefined) write(value);
            }}
            onPointerUp={commit}
            onKeyUp={commit}
          />
        ) : null}
        <span className={styles.field}>
          <input
            className={styles.input}
            id={fieldId}
            type="number"
            inputMode="decimal"
            min={min}
            max={max}
            step={step ?? 'any'}
            value={draft ?? (current === undefined ? '' : String(current))}
            aria-label={label ? undefined : 'Value'}
            onChange={event => {
              const text = event.target.value;
              setDraft(text);
              const typed = parse(text);
              // Only a number inside the limits while typing: '5' on the way to '5000' is not written as 1000.
              if (typed !== undefined && (min === undefined || typed >= min) && (max === undefined || typed <= max)) write(typed);
            }}
            onBlur={settle}
            onKeyDown={event => {
              if (event.key === 'Enter') settle();
            }}
          />
          {unit ? <span className={styles.unit}>{unit}</span> : null}
        </span>
      </div>
      <p className={styles.note} role="status">
        {note}
      </p>
    </div>
  );
};
