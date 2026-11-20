// Chips (design 5.3): a wrapping row of mono chips. A dot carries the tone or the server-assigned slot colour.
import type {ChipItem} from '@glimpse/catalog';
import type * as C from '@glimpse/catalog';
import {useMemo} from 'react';
import {DataGate, Empty, Redline, useCatSlots, useDataset, type GlView} from '../../kit/index.ts';
import {Chip} from './shared/Chip.tsx';
import {cellText, isRecord, shapeHint, shapeMessage, toneMark} from './shared/data.ts';
import styles from './Chips.module.css';

/** More chips than this are folded into one "+N" chip. */
const MAX_CHIPS = 120;

const SLOT_TABLES = ['lang', 'module', 'author'] as const;

interface ChipModel { label: string; tone?: unknown; slotKey?: string }

function normalize(items: readonly unknown[]): ChipModel[] {
  const out: ChipModel[] = [];
  for (const item of items as readonly (ChipItem | unknown)[]) {
    if (isRecord(item)) {
      const label = cellText(item.label ?? item.name ?? item.title).trim();
      if (label) out.push({label, tone: item.tone, slotKey: typeof item.slotKey === 'string' ? item.slotKey : undefined});
    } else {
      const label = cellText(item).trim();
      if (label) out.push({label});
    }
  }
  return out;
}

export const ChipsView: GlView<typeof C.Chips> = ({id, props}) => {
  const state = useDataset(props.data);
  const chips = useMemo(() => (Array.isArray(state.data) ? normalize(state.data) : []), [state.data]);
  // A slot key the session knows wears its ink; the others take the free inks in order of appearance (D6).
  const keys = useMemo(() => chips.flatMap(chip => (chip.slotKey ? [chip.slotKey] : [])), [chips]);
  const cat = useCatSlots(SLOT_TABLES, keys);
  return (
    <DataGate state={state} id={`Chips#${id}`}>
      {data => {
        if (!Array.isArray(data)) return <Redline code="E_SHAPE" id={`Chips#${id}`} message={shapeMessage('a list of strings or {label, tone?}', data)} />;
        if (chips.length === 0) return <Empty message={`no chips: Chips takes strings or [{label, tone?}], got ${shapeHint(data)}`} code="W_SHAPE" />;
        const shown = chips.slice(0, MAX_CHIPS);
        return (
          <ul className={styles.chips}>
            {shown.map((chip, i) => {
              const tone = toneMark(chip.tone);
              const dot = tone?.color ?? (chip.slotKey ? cat.color(chip.slotKey) : undefined);
              return (
                <li key={`${i}:${chip.label}`} className={styles.item}>
                  <Chip label={chip.label} dot={dot} dotLabel={tone?.word} title={chip.label.length > 28 ? chip.label : undefined} />
                </li>
              );
            })}
            {chips.length > shown.length ? (
              <li className={styles.item}>
                <Chip label={`+${chips.length - shown.length} more`} />
              </li>
            ) : null}
          </ul>
        );
      }}
    </DataGate>
  );
};
