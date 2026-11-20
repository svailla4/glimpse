// Stat (design 5.3): one hero numeral with its label, unit, sparkline and delta.
import type * as C from '@glimpse/catalog';
import {Drafting, Redline, useDataset, type GlView} from '../../kit/index.ts';
import {shapeMessage} from './shared/data.ts';
import {textOf} from './shared/inline.tsx';
import {StatCell, asFormat} from './shared/StatCell.tsx';
import styles from './Stat.module.css';

export const StatView: GlView<typeof C.Stat> = ({id, props}) => {
  const value = useDataset<number | string>(props.value);
  const spark = useDataset<number[]>(props.spark);
  if (value.status === 'pending') return <Drafting label={value.message} />;
  if (value.status === 'error') return <Redline code={value.code ?? 'E_DATA'} id={`Stat#${id}`} message={value.message ?? 'failed'} />;
  // An unbound value is a missing cell, not a missing plate: the label stays and the numeral is a dash.
  const data: unknown = value.status === 'ready' ? value.data : undefined;
  if (typeof data === 'object' && data !== null) {
    return <Redline code="E_SHAPE" id={`Stat#${id}`} message={shapeMessage('a number or a short string', data)} />;
  }
  return (
    <div className={styles.stat} data-gl-state={value.status === 'empty' ? 'empty' : undefined}>
      <StatCell
        value={data}
        label={textOf(props.label).trim() || undefined}
        unit={textOf(props.unit).trim() || undefined}
        delta={props.delta}
        spark={spark.status === 'ready' ? spark.data : undefined}
        format={asFormat(props.format)}
      />
    </div>
  );
};
