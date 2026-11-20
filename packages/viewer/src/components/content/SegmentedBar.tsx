// SegmentedBar (design 5.3): part-to-whole in one 16 px bar, segments separated by 2 px surface gaps, with a legend
// beneath (swatch, label, percentage). Segments under 2% and those past the eighth ink merge into "other".
// Colours come from the kit (D6): a category keeps its session ink, the others take the free inks in order, and
// only the merged remainder is grey, so two different categories are never the same colour side by side.
// Clicking a segment or a legend entry selects it; the legend is one tab stop with roving focus.
import type {EntityRef, Field, FieldKind, Roles, Rows} from '@glimpse/catalog';
import type * as C from '@glimpse/catalog';
import {useMemo} from 'react';
import {DataGate, Empty, Redline, catVar, fmtCell, fmtNum, isOtherKey, toNumber, useCatSlots, useDataset, useTooltip, type GlView} from '../../kit/index.ts';
import {cellEntity, cellText, fileEntity, isRecord, shapeMessage} from './shared/data.ts';
import {useEntityRows} from './shared/entityRow.ts';
import {useRoving} from './shared/roving.ts';
import styles from './SegmentedBar.module.css';

/** Categorical inks are never cycled: a ninth category is "other" (design 8.3). */
const MAX_INKS = 8;
const MIN_SHARE = 0.02;
const NUMERIC: ReadonlySet<FieldKind> = new Set(['num', 'bytes', 'pct', 'duration', 'bar', 'heat']);
type SlotKind = 'lang' | 'module' | 'author';
const isSlotKind = (value: unknown): value is SlotKind => value === 'lang' || value === 'module' || value === 'author';

interface Segment {
  label: string;
  value: number;
  share: number;
  /** What a click selects; the merged "other" segment selects nothing. */
  entity?: EntityRef;
  /** Number of categories merged into this segment. */
  merged?: number;
}

interface Model {
  segments: Segment[];
  total: number;
  /** Rows left out: no label, or a value that is not a positive number. */
  dropped: number;
  valueField?: Field;
  /** The session's slot table the labels belong to, when they are languages, modules or authors. */
  slotKind?: SlotKind;
  error?: string;
}

function sniff(row: Record<string, unknown>): Field[] {
  return Object.entries(row).flatMap(([key, value]): Field[] =>
    typeof value === 'number' ? [{key, kind: 'num'}] : typeof value === 'string' ? [{key, kind: isSlotKind(key) ? key : 'text'}] : [],
  );
}

function build(rows: Rows, given: Field[] | undefined, roles: Roles | undefined, labelProp: string | undefined, valueProp: string | undefined): Model {
  const first = rows.find(isRecord);
  if (!first) return {segments: [], total: 0, dropped: rows.length, error: shapeMessage('rows (a list of objects)', rows[0])};
  const fields = given && given.length > 0 ? given : sniff(first);
  const byKey = new Map(fields.map(field => [field.key, field]));
  const labelKey = labelProp || roles?.label || fields.find(field => !NUMERIC.has(field.kind ?? 'text'))?.key || Object.keys(first).find(key => typeof first[key] === 'string');
  const valueKey = valueProp || roles?.value || fields.find(field => field.key !== labelKey && NUMERIC.has(field.kind ?? 'text'))?.key;
  if (!labelKey) return {segments: [], total: 0, dropped: 0, error: 'no label field: name one with label='};

  // One segment per label, in order of first appearance. Without a value field every row counts as one.
  const sums = new Map<string, number>();
  let dropped = 0;
  for (const row of rows) {
    const label = isRecord(row) ? cellText(row[labelKey]).trim() : '';
    const value = !isRecord(row) ? undefined : valueKey ? toNumber(row[valueKey]) : 1;
    if (!label || value === undefined || value <= 0) dropped++;
    else sums.set(label, (sums.get(label) ?? 0) + value);
  }
  let total = 0;
  for (const value of sums.values()) total += value;
  if (total <= 0) return {segments: [], total: 0, dropped};

  const labelKind = byKey.get(labelKey)?.kind;
  const slotKind: SlotKind | undefined = isSlotKind(labelKind) ? labelKind : isSlotKind(labelKey) ? labelKey : undefined;
  const entityOf = (label: string): EntityRef =>
    labelKind === 'path' ? fileEntity(label) : (cellEntity(labelKind ?? (slotKind === 'lang' ? undefined : slotKind), label) ?? {type: 'row', id: label, label});

  const kept: Segment[] = [];
  const rest: Segment[] = [];
  for (const [label, value] of sums) {
    const share = value / total;
    const segment: Segment = {label, value, share, entity: entityOf(label)};
    // A category that is itself a remainder ("Other") belongs with the rest, so there is one grey segment at most.
    if (share < MIN_SHARE || kept.length >= MAX_INKS || isOtherKey(label)) rest.push(segment);
    else kept.push(segment);
  }
  if (rest.length === 1) kept.push(rest[0]!);
  else if (rest.length > 1) {
    const value = rest.reduce((sum, segment) => sum + segment.value, 0);
    kept.push({label: `other (${rest.length})`, value, share: value / total, merged: rest.length});
  }
  return {segments: kept, total, dropped, slotKind, valueField: valueKey ? (byKey.get(valueKey) ?? {key: valueKey, kind: 'num'}) : undefined};
}

const pct = (share: number) => (share > 0 && share < 0.001 ? '<0.1%' : fmtNum(share * 100, 'pct'));

export const SegmentedBarView: GlView<typeof C.SegmentedBar> = ({id, props}) => {
  const state = useDataset<Rows>(props.data);
  const model = useMemo(
    () => (Array.isArray(state.data) ? build(state.data, state.fields, state.roles, props.label, props.value) : undefined),
    [state.data, state.fields, state.roles, props.label, props.value],
  );
  const segments = model?.segments ?? [];
  const named = useMemo(() => (model?.segments ?? []).filter(segment => !segment.merged).map(segment => segment.label), [model]);
  const cat = useCatSlots(model?.slotKind, named);
  const slotOf = (segment: Segment) => (segment.merged ? 0 : cat.slot(segment.label));
  const roving = useRoving<HTMLUListElement>(segments.length, 'horizontal');
  const rows = useEntityRows(id);
  const tooltip = useTooltip();
  const anyMarked = segments.some(segment => rows.isMarked(segment.entity));

  return (
    <DataGate state={state} id={`SegmentedBar#${id}`}>
      {data => {
        if (!model) return <Redline code="E_SHAPE" id={`SegmentedBar#${id}`} message={shapeMessage('rows (a list of objects)', data)} />;
        if (model.error) return <Redline code="E_SHAPE" id={`SegmentedBar#${id}`} message={model.error} />;
        if (segments.length === 0) return <Empty message="no positive values to show" />;
        const largest = segments.reduce((a, b) => (b.share > a.share ? b : a));
        const valueField: Field = model.valueField && model.valueField.kind !== 'bar' && model.valueField.kind !== 'heat' ? model.valueField : {key: 'value', kind: 'num'};
        return (
          <div className={styles.root}>
            <div className={styles.bar} role="img" aria-label={`Segmented bar, ${segments.length} ${segments.length === 1 ? 'segment' : 'segments'}, largest ${largest.label} ${pct(largest.share)}`}>
              {segments.map(segment => {
                const marked = rows.isMarked(segment.entity);
                return (
                  <span
                    key={segment.label}
                    className={styles.segment}
                    data-segment={segment.label}
                    data-other={slotOf(segment) === 0 || undefined}
                    data-slot={slotOf(segment)}
                    data-selected={marked || undefined}
                    data-dimmed={(anyMarked && !marked) || undefined}
                    data-entity={segment.entity ? '' : undefined}
                    style={{flexGrow: segment.value, background: catVar(slotOf(segment))}}
                    onClick={event => rows.onClick(segment.entity, event)}
                    onPointerMove={event =>
                      tooltip.show(
                        <span className={styles.tip}>
                          <span>{segment.label}</span>
                          <span className={styles.tipValue}>{fmtCell(segment.value, valueField)} · {pct(segment.share)}</span>
                        </span>,
                        event.clientX,
                        event.clientY,
                      )
                    }
                    onPointerLeave={() => tooltip.hide()}
                  />
                );
              })}
            </div>
            <ul className={styles.legend} ref={roving.ref} onKeyDown={roving.onKeyDown}>
              {segments.map((segment, i) => {
                const marked = rows.isMarked(segment.entity);
                return (
                  <li key={segment.label} className={styles.entry}>
                    <button
                      type="button"
                      className={styles.key}
                      data-selected={marked || undefined}
                      data-dimmed={(anyMarked && !marked) || undefined}
                      aria-pressed={segment.entity ? marked : undefined}
                      {...roving.item(i)}
                      onClick={event => rows.onClick(segment.entity, event)}
                      onKeyDown={event => {
                        if (rows.onKeyDown(segment.entity, event)) event.stopPropagation();
                      }}
                    >
                      <span className={styles.swatch} data-other={slotOf(segment) === 0 || undefined} style={{background: catVar(slotOf(segment))}} aria-hidden="true" />
                      <span className={styles.label}>{segment.label}</span>
                      <span className={styles.share}>{pct(segment.share)}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
            {model.dropped > 0 ? <p className={styles.dropped}>{fmtNum(model.dropped)} {model.dropped === 1 ? 'row' : 'rows'} without a positive value left out</p> : null}
          </div>
        );
      }}
    </DataGate>
  );
};
