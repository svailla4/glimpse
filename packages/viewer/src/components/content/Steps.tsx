// Steps (design 5.3): a numbered plan on a vertical ink rail. Each step is a 20 px numeral box, a title, an optional
// note and file, and a status glyph drawn in line with its label. A header counts what is done over a segmented
// progress rule. Selecting a step selects its file. One tab stop; arrows, Home and End move between steps.
import {Steps as StepsDef, type EntityRef, type StepItem, type StepStatus} from '@glimpse/catalog';
import type * as C from '@glimpse/catalog';
import {useMemo, useState, type JSX} from 'react';
import {Empty, PathText, Redline, fmtNum, toNumber, useDataset, type GlView} from '../../kit/index.ts';
import {cellText, fileEntity, isRecord, shapeMessage} from './shared/data.ts';
import {useEntityRows} from './shared/entityRow.ts';
import {Inline, textOf} from './shared/inline.tsx';
import {DataPlate} from './shared/Plate.tsx';
import {useRoving} from './shared/roving.ts';
import styles from './Steps.module.css';

/** Steps drawn before "Show all" is pressed. */
const FOLD = 100;
/** Above this, the progress rule groups steps by status instead of drawing one segment per step. */
const MAX_SEGMENTS = 60;

const STATUS_LABEL: Record<StepStatus, string> = {todo: 'To do', doing: 'Doing', done: 'Done', blocked: 'Blocked', skipped: 'Skipped'};
const STATUS_ORDER: StepStatus[] = ['done', 'doing', 'blocked', 'skipped', 'todo'];
const isStatus = (value: unknown): value is StepStatus => typeof value === 'string' && Object.hasOwn(STATUS_LABEL, value);

interface Step { title: string; note: string; status?: StepStatus; file?: string; entity?: EntityRef }

function normalize(items: readonly unknown[]): Step[] {
  const steps: Step[] = [];
  for (const item of items as readonly (StepItem | unknown)[]) {
    if (isRecord(item)) {
      const file = typeof item.file === 'string' && item.file.trim() !== '' ? item.file.trim() : undefined;
      const title = cellText(item.title ?? item.name ?? item.label).trim() || file || '';
      if (!title) continue;
      steps.push({title, note: cellText(item.note).trim(), status: isStatus(item.status) ? item.status : undefined, file, entity: file ? fileEntity(file) : undefined});
    } else {
      const title = cellText(item).trim();
      if (title) steps.push({title, note: ''});
    }
  }
  return steps;
}

/** The status mark, drawn in line: empty, hatched (doing), ticked (done), crossed (blocked), dash (skipped). */
function Glyph(p: {status: StepStatus}): JSX.Element {
  return (
    <svg className={styles.glyph} width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" data-status={p.status}>
      <rect x="0.5" y="0.5" width="11" height="11" />
      {p.status === 'doing' ? <path d="M0.5 5L5 0.5M0.5 9.5L9.5 0.5M2.5 11.5L11.5 2.5M7 11.5L11.5 7" /> : null}
      {p.status === 'done' ? <path d="M3 6.2L5.2 8.4L9.2 3.8" /> : null}
      {p.status === 'blocked' ? <path d="M3.5 3.5L8.5 8.5M8.5 3.5L3.5 8.5" /> : null}
      {p.status === 'skipped' ? <path d="M3.5 6H8.5" /> : null}
    </svg>
  );
}

function Progress(p: {steps: Step[]}): JSX.Element {
  const counts = new Map<StepStatus, number>();
  for (const step of p.steps) counts.set(step.status ?? 'todo', (counts.get(step.status ?? 'todo') ?? 0) + 1);
  const spoken = STATUS_ORDER.filter(status => counts.has(status)).map(status => `${counts.get(status)} ${STATUS_LABEL[status].toLowerCase()}`).join(', ');
  const segments: Array<{status: StepStatus; weight: number}> =
    p.steps.length <= MAX_SEGMENTS
      ? p.steps.map(step => ({status: step.status ?? 'todo', weight: 1}))
      : STATUS_ORDER.filter(status => counts.has(status)).map(status => ({status, weight: counts.get(status) ?? 0}));
  return (
    <div className={styles.progress} role="img" aria-label={`Progress: ${spoken}`}>
      {segments.map((segment, i) => <span key={i} className={styles.segment} data-status={segment.status} style={{flexGrow: segment.weight}} />)}
    </div>
  );
}

export const StepsView: GlView<typeof C.Steps> = ({id, props}) => {
  const state = useDataset<StepItem[]>(props.data);
  const steps = useMemo(() => (Array.isArray(state.data) ? normalize(state.data) : []), [state.data]);
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? steps : steps.slice(0, FOLD);
  const roving = useRoving<HTMLOListElement>(shown.length);
  const rows = useEntityRows(id);
  const currentProp = toNumber(props.current);
  const current = currentProp !== undefined && Number.isInteger(currentProp) ? currentProp : -1;
  const tracked = steps.some(step => step.status !== undefined);
  const done = steps.filter(step => step.status === 'done').length;
  const count = tracked ? <span className={styles.count} data-gl-steps-count="">{fmtNum(done)} / {fmtNum(steps.length)} done</span> : undefined;

  return (
    <DataPlate id={id} def={StepsDef} title={textOf(props.title).trim() || undefined} state={state} aside={state.status === 'ready' ? count : undefined}>
      {data => {
        if (!Array.isArray(data)) return <Redline code="E_SHAPE" id={`Steps#${id}`} message={shapeMessage('a list of {title, note?, status?, file?}', data)} />;
        if (steps.length === 0) return <Empty message="no steps to show" />;
        return (
          <div className={styles.steps}>
            {tracked ? <Progress steps={steps} /> : null}
            <ol className={styles.list} ref={roving.ref} onKeyDown={roving.onKeyDown}>
              {shown.map((step, i) => (
                <li
                  key={i}
                  className={styles.step}
                  data-status={step.status}
                  data-current={i === current || undefined}
                  aria-current={i === current ? 'step' : undefined}
                  data-entity={step.entity ? '' : undefined}
                  data-selected={rows.isMarked(step.entity) || undefined}
                  {...roving.item(i)}
                  onClick={event => rows.onClick(step.entity, event)}
                  onKeyDown={event => {
                    if (event.target === event.currentTarget && rows.onKeyDown(step.entity, event)) event.stopPropagation();
                  }}
                >
                  <span className={styles.num} aria-hidden="true">{i + 1}</span>
                  <div className={styles.main}>
                    <div className={styles.head}>
                      <span className={styles.title}>{step.title}</span>
                      {step.status ? (
                        <span className={styles.status}>
                          <Glyph status={step.status} />
                          {STATUS_LABEL[step.status]}
                        </span>
                      ) : null}
                    </div>
                    {step.note ? <p className={styles.note}><Inline text={step.note} componentId={id} /></p> : null}
                    {step.file ? <div className={styles.file}><PathText file={step.file} /></div> : null}
                  </div>
                </li>
              ))}
            </ol>
            {steps.length > FOLD ? (
              <button type="button" className={styles.more} onClick={() => setExpanded(open => !open)} aria-expanded={expanded}>
                {expanded ? `Show first ${FOLD}` : `Show all ${fmtNum(steps.length)}`}
              </button>
            ) : null}
          </div>
        );
      }}
    </DataPlate>
  );
};
