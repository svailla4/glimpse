// packages/viewer/src/components/charts/index.ts
// The `charts` chunk (`chunk: 'charts'` in @glimpse/catalog): one view per component, each in the file of its name,
// all drawn as SVG on the shared chartkit/. Exports exactly `views`.
// It also holds Slider, an input (family `input`), which is kept lazy here for the eager budget (decision what-if-as-a2ui-calls).
import type {GlView} from '../../kit/index.ts';
import {BarChartView} from './BarChart.tsx';
import {CalendarHeatmapView} from './CalendarHeatmap.tsx';
import {HeatmapView} from './Heatmap.tsx';
import {HistogramView} from './Histogram.tsx';
import {IcicleView} from './Icicle.tsx';
import {LineChartView} from './LineChart.tsx';
import {ScatterPlotView} from './ScatterPlot.tsx';
import {SliderView} from './Slider.tsx';
import {TreemapView} from './Treemap.tsx';

export const views: Record<string, GlView<any>> = {
  BarChart: BarChartView,
  LineChart: LineChartView,
  ScatterPlot: ScatterPlotView,
  Histogram: HistogramView,
  Heatmap: HeatmapView,
  CalendarHeatmap: CalendarHeatmapView,
  Treemap: TreemapView,
  Icicle: IcicleView,
  Slider: SliderView,
};
