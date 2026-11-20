// Chips (design 5.3): a wrapping row of mono chips. A dot carries the tone or the server-assigned slot colour.
import {PATHS, type ChipItem, type SurfaceMeta} from '@glimpse/catalog';
import type * as C from '@glimpse/catalog';
import {useMemo} from 'react';
import {DataGate, Empty, Redline, catVar, useDataset, usePath, type GlView} from '../../kit/index.ts';
import {Chip} from './shared/Chip.tsx';
import {cellText, isRecord, shapeMessage, toneMark} from './shared/data.ts';
import styles from './Chips.module.css';

/** More chips than this are folded into one "+N" chip. */
const MAX_CHIPS = 120;

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
  const slots = usePath<SurfaceMeta['slots']>(PATHS.metaSlots);
  const chips = useMemo(() => (Array.isArray(state.data) ? normalize(state.data) : []), [state.data]);
  return (
    <DataGate state={state} id={`Chips#${id}`}>
      {data => {
        if (!Array.isArray(data)) return <Redline code="E_SHAPE" id={`Chips#${id}`} message={shapeMessage('a list of strings or {label, tone?}', data)} />;
        if (chips.length === 0) return <Empty message="no chips to show" />;
        const shown = chips.slice(0, MAX_CHIPS);
        return (
          <ul className={styles.chips}>
            {shown.map((chip, i) => {
              const tone = toneMark(chip.tone);
              const slot = chip.slotKey ? (slots?.lang?.[chip.slotKey] ?? slots?.module?.[chip.slotKey] ?? slots?.author?.[chip.slotKey] ?? 0) : 0;
              const dot = tone?.color ?? (chip.slotKey ? catVar(slot) : undefined);
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
