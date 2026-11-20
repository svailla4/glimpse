// KeyValue (design 5.3): a definition grid. Values format themselves: paths become file links, lists chips,
// booleans a tick or a dash, numbers tabular, http(s) URLs links.
import {KeyValue as KeyValueDef, type KeyValueData, type Roles} from '@glimpse/catalog';
import type * as C from '@glimpse/catalog';
import {useMemo, type ReactNode} from 'react';
import {DASH, Empty, Icon, Redline, fmtNum, useDataset, type GlView} from '../../kit/index.ts';
import {Chip} from './shared/Chip.tsx';
import {cellText, isRecord, labelValueKeys, looksLikePath, shapeHint, shapeMessage} from './shared/data.ts';
import {FileLink} from './shared/FileLink.tsx';
import {textOf} from './shared/inline.tsx';
import {DataPlate} from './shared/Plate.tsx';
import styles from './KeyValue.module.css';

/** Pairs beyond this are counted, not drawn. */
const MAX_PAIRS = 200;
const MAX_LIST = 24;

interface Pair { key: string; value: unknown }

/**
 * An object's entries, or a list of items: {label, value} with the label in `label`, `name`, `key`, `k` or `title`
 * and the value in `value` or `v` (a dataset's roles first: Stats rows and KeyValue rows are one shape, V002), a
 * record of exactly two fields one of which is text (that one is the key), or a [key, value] tuple. Undefined for
 * anything else.
 */
export function pairsOf(data: unknown, roles?: Roles): Pair[] | undefined {
  if (Array.isArray(data)) {
    const out: Pair[] = [];
    for (const item of data) {
      if (isRecord(item)) {
        const {labelKey, valueKey} = labelValueKeys(item, roles);
        if (labelKey !== undefined) {
          out.push({key: cellText(item[labelKey]), value: valueKey === undefined ? undefined : item[valueKey]});
          continue;
        }
        const entries = Object.entries(item);
        const keyAt = entries.findIndex(([, value]) => typeof value === 'string');
        if (entries.length !== 2 || keyAt < 0) continue;
        out.push({key: cellText(entries[keyAt]![1]), value: entries[1 - keyAt]![1]});
      } else if (Array.isArray(item) && item.length === 2) out.push({key: cellText(item[0]), value: item[1]});
    }
    return out;
  }
  if (isRecord(data)) return Object.entries(data).map(([key, value]) => ({key, value}));
  return undefined;
}

/** True when there was something to draw but none of it was a pair. */
const hasItems = (data: unknown) => (Array.isArray(data) ? data.length > 0 : isRecord(data) && Object.keys(data).length > 0);

function Value(p: {value: unknown; componentId: string}): ReactNode {
  const {value, componentId} = p;
  if (value === null || value === undefined || value === '') return <span className={styles.none}>{DASH}</span>;
  if (typeof value === 'boolean') {
    return value ? (
      <span className={styles.tick} role="img" aria-label="yes"><Icon name="check" /></span>
    ) : (
      <span className={styles.none} role="img" aria-label="no">{DASH}</span>
    );
  }
  if (typeof value === 'number') return <span className={styles.num}>{fmtNum(value)}</span>;
  if (Array.isArray(value)) {
    if (value.length === 0) return <span className={styles.none}>{DASH}</span>;
    const shown = value.slice(0, MAX_LIST);
    return (
      <span className={styles.list}>
        {shown.map((item, i) => <Chip key={i} label={cellText(item, 48) || DASH} />)}
        {value.length > shown.length ? <Chip label={`+${value.length - shown.length}`} /> : null}
      </span>
    );
  }
  if (typeof value === 'string') {
    const text = value.trim();
    if (/^https?:\/\/\S+$/i.test(text)) return <a className={styles.url} href={text} target="_blank" rel="noopener noreferrer">{text}</a>;
    if (looksLikePath(text)) return <FileLink file={text} componentId={componentId} />;
    return <span className={styles.text}>{value}</span>;
  }
  return <code className={styles.json}>{cellText(value, 240)}</code>;
}

export const KeyValueView: GlView<typeof C.KeyValue> = ({id, props}) => {
  const state = useDataset<KeyValueData>(props.data);
  const pairs = useMemo(() => pairsOf(state.data, state.roles), [state.data, state.roles]);
  const cols = Math.min(3, Math.max(1, Math.round(Number(props.cols) || 1)));
  return (
    <DataPlate id={id} def={KeyValueDef} title={textOf(props.title).trim() || undefined} note={textOf(props.note).trim() || undefined} state={state}>
      {data => {
        if (!pairs) return <Redline code="E_SHAPE" id={`KeyValue#${id}`} message={shapeMessage('{Label: value} or [{label, value}]', data)} />;
        if (pairs.length === 0) {
          return hasItems(data)
            ? <Empty message={`no pairs: KeyValue takes {Label: value} or [{label, value}], got ${shapeHint(data)}`} code="W_SHAPE" />
            : <Empty message="no pairs to show" />;
        }
        const shown = pairs.slice(0, MAX_PAIRS);
        return (
          <div className={styles.wrap}>
            <dl className={styles.grid} data-cols={cols} style={{['--kv-cols' as never]: cols}}>
              {shown.map((pair, i) => (
                <div key={`${i}:${pair.key}`} className={styles.pair}>
                  <dt className={styles.key} title={pair.key.length > 14 ? pair.key : undefined}>{pair.key}</dt>
                  <dd className={styles.value}><Value value={pair.value} componentId={id} /></dd>
                </div>
              ))}
            </dl>
            {pairs.length > shown.length ? <p className={styles.more}>showing {fmtNum(shown.length)} of {fmtNum(pairs.length)}</p> : null}
          </div>
        );
      }}
    </DataPlate>
  );
};
