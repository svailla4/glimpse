// packages/catalog/src/index.ts
export * from './props.ts';
export * from './datasets.ts';
export * from './components.ts';
// `Row` is both a dataset row type (datasets.ts) and the Row layout component (components.ts). The barrel exports the
// component as `Row` and the row type as `DataRow`; `Rows` (= DataRow[]) is unaffected.
export {Row} from './components.ts';
export type {Row as DataRow} from './datasets.ts';
export * from './sources.ts';
export * from './catalog.ts';
export * from './docs.ts';
export * from './views.ts';
export * from './gallery.ts';
export * from './transport.ts';
export * from './diagrams.ts';
export * from './notation.ts';
export * from './normalize.ts';
