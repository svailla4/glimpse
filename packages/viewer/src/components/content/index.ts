// packages/viewer/src/components/content/index.ts
// The `content` chunk (eager): the content family, the two input components and the two charts small enough to
// ship in the first bundle. One file per component next to this one; pieces they share are in ./shared.
// Rules for views are in the header of ../../kit/implement.tsx.
import type {GlView} from '../../kit/index.ts';
import {AskView} from './Ask.tsx';
import {ButtonView} from './Button.tsx';
import {CalloutView} from './Callout.tsx';
import {ChipsView} from './Chips.tsx';
import {FileRefView} from './FileRef.tsx';
import {KeyValueView} from './KeyValue.tsx';
import {ListView} from './List.tsx';
import {MarkdownView} from './Markdown.tsx';
import {SegmentedBarView} from './SegmentedBar.tsx';
import {SparklineView} from './Sparkline.tsx';
import {StatView} from './Stat.tsx';
import {StatsView} from './Stats.tsx';
import {StepsView} from './Steps.tsx';
import {TextView} from './Text.tsx';

export const views: Record<string, GlView<any>> = {
  Text: TextView,
  Markdown: MarkdownView,
  Callout: CalloutView,
  KeyValue: KeyValueView,
  Chips: ChipsView,
  FileRef: FileRefView,
  Steps: StepsView,
  Stat: StatView,
  Stats: StatsView,
  List: ListView,
  Sparkline: SparklineView,
  SegmentedBar: SegmentedBarView,
  Button: ButtonView,
  Ask: AskView,
};
