// packages/server/src/code/index.ts  (stub by WP0; owned by WP3)
// WP3 replaces this file. Frozen signature:
//   createCodeService(ctx: RepoContext): CodeService
// The stub's methods reject with SourceError('E_INTERNAL', 'not implemented'); the host answers those requests with
// an error and the viewer shows a redline in the component that asked.
import {SourceError, type CodeService, type RepoContext} from '../contracts.ts';

const notImplemented = (what: string) => Promise.reject(new SourceError('E_INTERNAL', `not implemented: ${what}`));

export function createCodeService(_ctx: RepoContext): CodeService {
  return {
    file: () => notImplemented('CodeService.file'),
    highlight: () => notImplemented('CodeService.highlight'),
    outline: () => notImplemented('CodeService.outline'),
  };
}
