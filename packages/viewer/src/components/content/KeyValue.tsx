// KeyValue (design 5.3): a definition grid. Values format themselves: paths become file links, lists chips,
// booleans a tick or a dash, numbers tabular, http(s) URLs links.
import {KeyValue as KeyValueDef, type KeyValueData} from '@glimpse/catalog';
import type * as C from '@glimpse/catalog';
import {useMemo, type ReactNode} from 'react';
import {DASH, Empty, Icon, Redline, fmtNum, useDataset, type GlView} from '../../kit/index.ts';
import {Chip} from './shared/Chip.tsx';
import {cellText, isRecord, looksLikePath, shapeMessage} from './shared/data.ts';
import {FileLink} from './shared/FileLink.tsx';
import {textOf} from './shared/inline.tsx';
import {DataPlate} from './shared/Plate.tsx';
import styles from './KeyValue.module.css';

/** Pairs beyond this are counted, not drawn. */
const MAX_PAIRS = 200;
const MAX_LIST = 24;

interface Pair { key: string; value: unknown }

/** An object's entries, [{k, v}] items, or [key, value] tuples; undefined for anything else. */
function pairsOf(data: unknown): Pair[] | undefined {
  if (Array.isArray(data)) {
    const out: Pair[] = [];
    for (const item of data) {
      if (isRecord(item) && ('k' in item || 'key' in item)) out.push({key: cellText(item.k ?? item.key), value: item.v ?? item.value});
      else if (Array.isArray(item) && item.length === 2) out.push({key: cellText(item[0]), value: item[1]});
    }
    return out;
  }
  if (isRecord(data)) return Object.entries(data).map(([key, value]) => ({key, value}));
  return undefined;
}

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
  const pairs = useMemo(() => pairsOf(state.data), [state.data]);
  const cols = Math.min(3, Math.max(1, Math.round(Number(props.cols) || 1)));
  return (
    <DataPlate id={id} def={KeyValueDef} title={textOf(props.title).trim() || undefined} state={state}>
      {data => {
        if (!pairs) return <Redline code="E_SHAPE" id={`KeyValue#${id}`} message={shapeMessage('an object or [{k, v}]', data)} />;
        if (pairs.length === 0) return <Empty message="no pairs to show" />;
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
