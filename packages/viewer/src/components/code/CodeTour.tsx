import type * as C from '@glimpse/catalog';
import {formatFileLoc, parseFileLoc, type StepItem, type TourStop} from '@glimpse/catalog';
import {useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode} from 'react';
import {
  DataGate, Empty, Icon, PathText, Redline, borrowView, fileEntity, fmtNum, useDataset, useFollowedFile, useSelection, useSize, type GlView,
} from '../../kit/index.ts';
import s from './CodeTour.module.css';
import {CodeFile} from './CodeView.tsx';
import {cx} from './codekit/lines.tsx';
import k from './codekit/lines.module.css';

const STACK_BELOW = 720;
const sameLoc = (file: string) => formatFileLoc(parseFileLoc(file));

/** The stop list when the content chunk has no Steps view to lend: same data, same selection behaviour. */
const LocalSteps: GlView<typeof C.Steps> = ({id, props}) => {
  const {select} = useSelection(id);
  const items = Array.isArray(props.data) ? (props.data as StepItem[]) : [];
  return (
    <ol className={s.steps} data-gl-steps="local">
      {items.map((item, index) => (
        <li key={index} className={s.step} data-current={index + 1 === props.current ? '' : undefined}>
          <button type="button" className={s.stepButton} aria-current={index + 1 === props.current ? 'step' : undefined} onClick={() => item.file && select(fileEntity(item.file))}>
            <span className={s.numeral}>{index + 1}</span>
            <span className={s.stepBody}>
              <span className={s.stepTitle}>{item.title}</span>
              {item.note ? <span className={s.stepNote}>{item.note}</span> : null}
              {item.file ? <PathText file={item.file} /> : null}
            </span>
          </button>
        </li>
      ))}
    </ol>
  );
};
const Steps = borrowView<typeof C.Steps>(() => import('../content/index.ts'), 'Steps', LocalSteps);

interface Stop { file: string; title: string; note: string }

function readStops(input: unknown[]): {stops: Stop[]; dropped: number} {
  const stops: Stop[] = [];
  let dropped = 0;
  for (const item of input as Array<Partial<TourStop> | null>) {
    const file = typeof item?.file === 'string' ? item.file.trim() : '';
    if (file === '' || parseFileLoc(file).path === '') {
      dropped++;
      continue;
    }
    const path = parseFileLoc(file).path;
    const title = typeof item?.title === 'string' && item.title.trim() !== '' ? item.title : path.slice(path.lastIndexOf('/') + 1);
    stops.push({file, title, note: typeof item?.note === 'string' ? item.note : ''});
  }
  return {stops, dropped};
}

export const CodeTourView: GlView<typeof C.CodeTour> = ({id, props}) => {
  const state = useDataset<TourStop[]>(props.data);
  return (
    <DataGate state={state} id={`CodeTour#${id}`}>
      {data => {
        if (!Array.isArray(data)) return <Redline code="E_SHAPE" id={`CodeTour#${id}`} message={`expected TourStop[] ([{file, note}]), received ${typeof data}`} />;
        return <Tour id={id} data={data} fill={Boolean(props.size)} framed={typeof props.title === 'string' && props.title !== ''} />;
      }}
    </DataGate>
  );
};

function Tour({id, data, fill, framed}: {id: string; data: unknown[]; fill: boolean; framed: boolean}): ReactNode {
  const {stops, dropped} = useMemo(() => readStops(data), [data]);
  const {select} = useSelection(id);
  const followed = useFollowedFile(undefined);
  const root = useRef<HTMLDivElement | null>(null);
  const {width} = useSize(root);
  const [picked, setPicked] = useState(0);
  const active = Math.min(picked, Math.max(0, stops.length - 1));
  const stop = stops[active];

  // Selecting a step (the Steps view does that) or anything else that names a stop moves the tour there.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only a change of the followed file moves the tour
  useEffect(() => {
    if (!followed || (stop && sameLoc(stop.file) === followed)) return;
    const index = stops.findIndex(candidate => sameLoc(candidate.file) === followed);
    if (index >= 0) setPicked(index);
  }, [followed]);

  const items = useMemo<StepItem[]>(() => stops.map(({file, title, note}) => ({title, file, ...(note ? {note} : {})})), [stops]);
  // The measured element is mounted in both branches, so the tour knows its width when stops arrive later.
  if (!stop) return <div ref={root}><Empty message={`no stop names a file (${fmtNum(dropped)} dropped)`} /></div>;

  const go = (to: number) => {
    const index = Math.min(stops.length - 1, Math.max(0, to));
    if (index === active) return;
    setPicked(index);
    select(fileEntity(stops[index]!.file));
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const to = event.key === 'ArrowRight' || event.key === 'j' ? active + 1 : event.key === 'ArrowLeft' || event.key === 'k' ? active - 1 : undefined;
    if (to === undefined) return;
    event.preventDefault();
    go(to);
  };
  const step = (label: string, to: number, back: boolean) => (
    <button type="button" className={cx(k.tool, back && s.back)} tabIndex={-1} aria-label={label} disabled={to < 0 || to >= stops.length} onClick={() => go(to)}>
      <Icon name="chevron-right" />
    </button>
  );

  return (
    <div
      ref={root}
      className={cx(k.code, s.tour)}
      role="group"
      aria-label={`Code tour, stop ${active + 1} of ${stops.length}: ${stop.title}`}
      aria-keyshortcuts="ArrowLeft ArrowRight j k"
      tabIndex={0}
      data-gl-code="tour"
      data-fit={fill ? 'fill' : 'cap'}
      data-boxed={framed ? undefined : ''}
      data-stack={width > 0 && width < STACK_BELOW ? '' : undefined}
      onKeyDown={onKeyDown}
    >
      <div className={s.stops}>
        <div className={k.head}>
          <span className={k.meta} data-gl-tour-at="">{active + 1} / {stops.length}</span>
          {dropped > 0 ? <span className={k.meta} data-gl-marginal="">{fmtNum(dropped)} malformed dropped</span> : null}
          <span className={k.grow} />
          {step('Previous stop', active - 1, true)}
          {step('Next stop', active + 1, false)}
        </div>
        <div className={s.list}>
          <Steps id={id} props={{data: items, current: active + 1}} child={() => null} />
        </div>
      </div>
      <div className={s.code}>
        <CodeFile id={id} file={stop.file} fit="fill" chrome="bare" />
      </div>
    </div>
  );
}
