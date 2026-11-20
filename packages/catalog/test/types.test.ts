// Type probe: ViewProps<D> and WireProps<D> are exact. The assertions are checked by `tsc` (npm run check);
// the runtime test only keeps the file in the suite.
import {describe, expect, it} from 'vitest';
import type {Button, DataTable, Page, Split, Stat, Steps, Tabs, Treemap} from '../src/components.ts';
import type {Dataset, DirNode, Rows, StepItem} from '../src/datasets.ts';
import type {Bind, Call, ChildToken, DataInput, ViewProps, WireProps} from '../src/props.ts';

type Expect<T extends true> = T;
type Eq<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

type TableView = ViewProps<typeof DataTable>;
type PageView = ViewProps<typeof Page>;
type TreemapWire = WireProps<typeof Treemap>;
type PageWire = WireProps<typeof Page>;

export type Probes = [
  Expect<Eq<TableView['data'], DataInput<Rows>>>,
  Expect<Eq<TableView['columns'], string | undefined>>,
  Expect<Eq<TableView['title'], string | undefined>>,
  Expect<Eq<TableView['size'], 's' | 'm' | 'l' | 'xl' | 'fill' | undefined>>,
  Expect<Eq<TableView['span'], number | undefined>>,
  Expect<Eq<PageView['children'], ChildToken[]>>,
  Expect<Eq<PageView['title'], string>>,
  Expect<Eq<ViewProps<typeof Split>['start'], string>>,
  Expect<Eq<ViewProps<typeof Button>['action'], () => Promise<void>>>,
  Expect<Eq<ViewProps<typeof Treemap>['color'], 'lang' | 'churn' | 'age' | 'complexity' | 'depth' | 'none' | undefined>>,
  Expect<Eq<ViewProps<typeof Tabs>['labels'], string[]>>,
  Expect<Eq<ViewProps<typeof Steps>['data'], DataInput<StepItem[]>>>,
  Expect<Eq<ViewProps<typeof Stat>['value'], DataInput<string | number>>>,
  Expect<Eq<TreemapWire['data'], DirNode | Dataset<DirNode> | string | Bind | Call | undefined>>,
  Expect<Eq<PageWire['title'], string | Bind | Call>>,
];

const wire: WireProps<typeof DataTable> = {data: {'@path': '/ds/git_churn'}, columns: 'path commits:bar', span: 6};
// @ts-expect-error unknown prop
const misspelt: WireProps<typeof DataTable> = {data: [], colums: 'x'};
// @ts-expect-error a required prop is missing
const incomplete: WireProps<typeof Page> = {title: 'T'};

describe('type probe', () => {
  it('WireProps accepts a binding, a ref string or inline rows for a data prop', () => {
    const forms: Array<WireProps<typeof DataTable>['data']> = [{'@path': '/ds/x'}, 'git.churn top=5', [{a: 1}]];
    expect(forms).toHaveLength(3);
    expect(wire.span).toBe(6);
    expect(misspelt).toBeDefined();
    expect(incomplete).toBeDefined();
  });
});
