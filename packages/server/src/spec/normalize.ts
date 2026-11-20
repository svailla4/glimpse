// packages/server/src/spec/normalize.ts
// The normalizer is defined in @glimpse/catalog (src/normalize.ts) because the catalog tests, the generated fixtures
// and the viewer test harness compile Express through the same function. The server uses it through this module.
// Keep this file a re-export: a behaviour change belongs in the catalog copy, so every consumer changes together.
export {normalizeSpec} from '@glimpse/catalog';
