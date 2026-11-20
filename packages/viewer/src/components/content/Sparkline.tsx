// Sparkline (design 5.3): an inline trend. 72 x 20 by default and stretches with its cell; no axes.
// Takes numbers, or rows of a dataset (the value role, else the first numeric field).
import type * as C from '@glimpse/catalog';
import {useMemo, useRef, type JSX} from 'react';
import {DataGate, Empty, Redline, toNumber, useDataset, useSize, type DataState, type GlView} from '../../kit/index.ts';
import {isRecord, shapeMessage} from './shared/data.ts';
import {Spark, describeSpark, sparkValues, type SparkKind} from './shared/Spark.tsx';
import styles from './Sparkline.module.css';

const MIN_WIDTH = 72;
const HEIGHT = 20;

/** The series of a number list, or of the value column of rows. */
function seriesOf(state: DataState<unknown>): Array<number | undefined> {
  const data = state.data;
  if (!Array.isArray(data)) return [];
  const first = data.find(isRecord);
  if (!first) return sparkValues(data);
  const key = state.roles?.value ?? state.roles?.y?.[0] ?? state.fields?.find(field => field.kind === 'num' || field.kind === 'bar')?.key ?? Object.keys(first).find(k => toNumber(first[k]) !== undefined);
  return key ? data.map(row => (isRecord(row) ? toNumber(row[key]) : undefined)) : [];
}

/** Mounted only once there is something to plot, so the box is measured when it exists. */
function Plot(p: {values: Array<number | undefined>; kind: SparkKind; name?: string}): JSX.Element {
  const box = useRef<HTMLDivElement>(null);
  const {width} = useSize(box);
  return (
    <div className={styles.sparkline} ref={box}>
      <Spark values={p.values} kind={p.kind} width={Math.max(MIN_WIDTH, Math.floor(width))} height={HEIGHT} label={`Sparkline, ${describeSpark(p.values)}`} name={p.name} />
    </div>
  );
}

export const SparklineView: GlView<typeof C.Sparkline> = ({id, props}) => {
  const state = useDataset<number[]>(props.data);
  const values = useMemo(() => seriesOf(state), [state]);
  const kind = props.kind === 'bar' || props.kind === 'area' ? props.kind : 'line';
  return (
    <DataGate state={state} id={`Sparkline#${id}`}>
      {data => {
        if (!Array.isArray(data)) return <Redline code="E_SHAPE" id={`Sparkline#${id}`} message={shapeMessage('a list of numbers', data)} />;
        if (!values.some(v => v !== undefined)) return <Empty message="no numbers to plot" />;
        return <Plot values={values} kind={kind} />;
      }}
    </DataGate>
  );
};
