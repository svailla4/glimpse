// The ELK layout, off the main thread (decision diagram-engine-in-worker). Vite bundles this file with ELK into its own same-origin
// asset, assets/elk.worker-<hash>.js, which the host serves under the page's CSP (no eval: elk.bundled.js has none).
// Started only by elk.ts: new Worker(new URL('./elk.worker.ts', import.meta.url), {type: 'module'}).
import ELK from 'elkjs/lib/elk.bundled.js';
import {answer, type ElkReply, type ElkRequest} from './elk.protocol.ts';

const scope = self as unknown as {onmessage: ((event: {data: ElkRequest}) => void) | null; postMessage(reply: ElkReply): void};
// elk.bundled.js runs ELK in this thread (its FakeWorker). In a worker, the engine also points self.onmessage at its
// own dispatcher when it is first evaluated, which is inside `new ELK()`: the assignment below must come after that
// line. Do not switch to addEventListener('message'): both handlers would then answer.
const elk = new ELK();
scope.onmessage = event => void answer(elk, event.data).then(reply => scope.postMessage(reply));
