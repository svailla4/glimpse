// List (design 5.3): ranked dense rows. Rank, title (an entity when the row names one), dim subtitle, and a trailing
// value over a 2 px bar proportional to it. Takes ListItem[] as given, or any rows dataset: the mapping from rows is
// the one documented above `List` in @glimpse/catalog (roles first, then field kinds, then the first row's cells).
import {List as ListDef, type EntityRef, type Field, type FieldKind, type Roles} from '@glimpse/catalog';
import type * as C from '@glimpse/catalog';
import {useMemo, useState} from 'react';
import {DASH, Empty, PathText, Redline, fmtCell, fmtNum, toNumber, useDataset, useTooltip, type GlView} from '../../kit/index.ts';
import {cellEntity, cellText, fileEntity, isRecord, looksLikePath, shapeHint, shapeMessage, toneMark} from './shared/data.ts';
import {useEntityRows} from './shared/entityRow.ts';
import {textOf} from './shared/inline.tsx';
import {DataPlate} from './shared/Plate.tsx';
import {useRoving} from './shared/roving.ts';
import styles from './List.module.css';

const DEFAULT_LIMIT = 10;
/** The catalog's upper bound for `limit`; "Show all" never draws more rows than this. */
const MAX_ROWS = 200;
/** A subtitle this short (a tag, a status, a language) is never cut: 'TODO' and not 'TO…'. */
const SHORT_SUB = 12;

interface Item {
  title: string;
  sub: string;
  /** Text of the trailing value; '' when the row has none. */
  value: string;
  /** The value as a number, when it is one: drives the bar. */
  amount?: number;
  file?: string;
  entity?: EntityRef;
  tone?: unknown;
}

const TITLE_KINDS: ReadonlySet<FieldKind> = new Set(['text', 'path', 'symbol', 'module']);
const VALUE_KINDS: ReadonlySet<FieldKind> = new Set(['num', 'bytes', 'pct', 'duration', 'bar', 'heat']);
const SUB_KINDS: ReadonlySet<FieldKind> = new Set(['chip', 'lang', 'author']);

/** Fields of rows that came without any: one per cell of the first row, kind from its value. */
function sniff(row: Record<string, unknown>): Field[] {
  const fields: Field[] = [];
  for (const [key, value] of Object.entries(row)) {
    if (typeof value === 'number') fields.push({key, kind: 'num'});
    else if (typeof value === 'string') fields.push({key, kind: key === 'path' || key === 'file' || looksLikePath(value) ? 'path' : toNumber(value) !== undefined ? 'num' : 'text'});
  }
  return fields;
}

function fileOf(row: Record<string, unknown>): string | undefined {
  const file = typeof row.file === 'string' && row.file.trim() ? row.file : typeof row.path === 'string' && row.path.trim() ? row.path : undefined;
  return file?.trim();
}

function fromListItems(rows: readonly unknown[]): Item[] {
  const items: Item[] = [];
  for (const row of rows) {
    if (!isRecord(row)) {
      const title = cellText(row).trim();
      if (title) items.push({title, sub: '', value: ''});
      continue;
    }
    const file = typeof row.file === 'string' && row.file.trim() ? row.file.trim() : undefined;
    const title = cellText(row.title).trim() || file || '';
    if (!title) continue;
    const amount = toNumber(row.value);
    items.push({
      title,
      sub: cellText(row.sub).trim(),
      value: amount !== undefined ? fmtNum(amount) : cellText(row.value, 40).trim(),
      amount,
      file,
      entity: file ? fileEntity(file) : undefined,
      tone: row.tone,
    });
  }
  return items;
}

function fromRows(rows: readonly unknown[], givenFields: Field[] | undefined, roles: Roles | undefined): Item[] {
  const first = rows.find(isRecord);
  if (!first) return fromListItems(rows);
  const fields = givenFields && givenFields.length > 0 ? givenFields : sniff(first);
  const byKey = new Map(fields.map(field => [field.key, field]));
  const has = (key: string | undefined): key is string => key !== undefined && (byKey.has(key) || key in first);
  const titleKey = has(roles?.label)
    ? roles.label
    : (fields.find(field => field.kind !== undefined && TITLE_KINDS.has(field.kind))?.key ?? Object.keys(first).find(key => typeof first[key] === 'string'));
  const valueKey = has(roles?.value) ? roles.value : fields.find(field => field.key !== titleKey && field.kind !== undefined && VALUE_KINDS.has(field.kind))?.key;
  const subKey = fields.find(field => field.key !== titleKey && field.key !== valueKey && field.kind !== undefined && SUB_KINDS.has(field.kind))?.key;
  const titleKind = titleKey ? byKey.get(titleKey)?.kind : undefined;
  const valueField: Field | undefined = valueKey ? (byKey.get(valueKey) ?? {key: valueKey}) : undefined;
  // A bar or heat column is still a number here: the list draws its own bar.
  const valueFormat: Field | undefined = valueField && (valueField.kind === 'bar' || valueField.kind === 'heat' || valueField.kind === undefined) ? {...valueField, kind: 'num'} : valueField;

  const items: Item[] = [];
  for (const row of rows) {
    if (!isRecord(row)) continue;
    const file = fileOf(row);
    const title = (titleKey ? cellText(row[titleKey]).trim() : '') || file || '';
    if (!title) continue;
    const raw = valueKey ? row[valueKey] : undefined;
    const value = raw === null || raw === undefined || raw === '' || !valueFormat ? '' : fmtCell(raw, valueFormat);
    items.push({
      title,
      sub: subKey ? cellText(row[subKey]).trim() : '',
      value: value === DASH ? '' : value,
      amount: toNumber(raw),
      file,
      entity: file ? fileEntity(file) : cellEntity(titleKind, title),
    });
  }
  return items;
}

/** ListItem[] is recognised by its `title` cell on rows that came with no fields and no roles. */
function itemsOf(rows: readonly unknown[], fields: Field[] | undefined, roles: Roles | undefined): Item[] {
  const first = rows.find(isRecord);
  const described = (fields && fields.length > 0) || (roles && Object.keys(roles).length > 0);
  return !described && (!first || 'title' in first) ? fromListItems(rows) : fromRows(rows, fields, roles);
}

export const ListView: GlView<typeof C.List> = ({id, props}) => {
  const state = useDataset(props.data);
  const items = useMemo(() => (Array.isArray(state.data) ? itemsOf(state.data, state.fields, state.roles) : []), [state.data, state.fields, state.roles]);
  const largest = useMemo(() => items.reduce((max, item) => Math.max(max, Math.abs(item.amount ?? 0)), 0), [items]);
  const [expanded, setExpanded] = useState(false);
  const limit = Math.min(MAX_ROWS, Math.max(1, Math.round(Number(props.limit) || DEFAULT_LIMIT)));
  const all = Math.min(items.length, MAX_ROWS);
  const shown = items.slice(0, expanded ? all : limit);
  const roving = useRoving<HTMLOListElement>(shown.length);
  const rows = useEntityRows(id);
  const tooltip = useTooltip();
  const rankWidth = `${String(shown.length).length + 1}ch`;

  return (
    <DataPlate id={id} def={ListDef} title={textOf(props.title).trim() || undefined} note={textOf(props.note).trim() || undefined} state={state}>
      {data => {
        if (!Array.isArray(data)) return <Redline code="E_SHAPE" id={`List#${id}`} message={shapeMessage('a list of {title, sub?, value?, file?} or rows', data)} />;
        if (items.length === 0) return <Empty message={`no rows to list: List takes [{title, sub?, value?, file?}] or rows with a text field, got ${shapeHint(data)}`} code="W_SHAPE" />;
        return (
          <div className={styles.wrap}>
            <ol className={styles.list} ref={roving.ref} onKeyDown={roving.onKeyDown} style={{'--list-rank': rankWidth}}>
              {shown.map((item, i) => {
                const tone = toneMark(item.tone);
                const share = largest > 0 && item.amount !== undefined ? Math.max(2, (Math.abs(item.amount) / largest) * 100) : 0;
                return (
                  <li
                    key={i}
                    className={styles.row}
                    data-entity={item.entity ? '' : undefined}
                    data-where={item.file && item.file !== item.title ? '' : undefined}
                    data-selected={rows.isMarked(item.entity) || undefined}
                    {...roving.item(i)}
                    onClick={event => rows.onClick(item.entity, event)}
                    onKeyDown={event => {
                      if (rows.onKeyDown(item.entity, event)) event.stopPropagation();
                    }}
                  >
                    <span className={styles.rank} aria-hidden="true">{i + 1}</span>
                    <span className={styles.title} title={item.file === item.title ? undefined : item.title}>
                      {tone ? <span className={styles.tone} style={{background: tone.color}} role="img" aria-label={tone.word} /> : null}
                      {item.file === item.title ? <PathText file={item.file} /> : <span className={styles.text}>{item.title}</span>}
                    </span>
                    {/* A row titled by its text (a TODO, a match) still says where it is: the location has its own box, which
                        keeps the file name and line whole while the text gives way (V039, paths-keep-file-name). */}
                    {item.file && item.file !== item.title ? (
                      <span className={styles.where} data-gl-list-where="">
                        <PathText file={item.file} />
                      </span>
                    ) : null}
                    {item.sub ? (
                      <span className={styles.sub} title={item.sub} data-short={item.sub.length <= SHORT_SUB || undefined}>
                        {item.sub}
                      </span>
                    ) : null}
                    {item.value ? (
                      <span
                        className={styles.value}
                        data-gl-list-value=""
                        onPointerMove={event =>
                          tooltip.show(
                            <span className={styles.tip}>
                              <span className={styles.tipTitle}>{item.title}</span>
                              <span className={styles.tipValue}>{item.value}</span>
                              {share > 0 && largest > 0 ? <span className={styles.tipShare}>{fmtNum((Math.abs(item.amount ?? 0) / largest) * 100, 'pct')} of the largest</span> : null}
                            </span>,
                            event.clientX,
                            event.clientY,
                          )
                        }
                        onPointerLeave={() => tooltip.hide()}
                      >
                        {item.value}
                        {share > 0 ? <span className={styles.bar} style={{width: `${share}%`}} aria-hidden="true" /> : null}
                      </span>
                    ) : null}
                  </li>
                );
              })}
            </ol>
            {items.length > limit ? (
              <button type="button" className={styles.more} onClick={() => setExpanded(open => !open)} aria-expanded={expanded}>
                {expanded
                  ? `Show top ${fmtNum(limit)}`
                  : all < items.length
                    ? `Show ${fmtNum(all)} of ${fmtNum(items.length)}`
                    : `Show all ${fmtNum(items.length)}`}
              </button>
            ) : null}
          </div>
        );
      }}
    </DataPlate>
  );
};
