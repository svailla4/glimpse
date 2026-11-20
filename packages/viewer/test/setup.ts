// packages/viewer/test/setup.ts  (WP0, frozen) - loaded before every viewer test file (vitest.config.ts).
// vitest runs without globals, so React Testing Library cannot register these itself.
import {cleanup, configure} from '@testing-library/react';
import {afterEach} from 'vitest';

// Tell React that state updates are expected to be wrapped in act(); RTL's render, fireEvent and waitFor do that.
(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;

// Unmount everything a test rendered.
afterEach(() => cleanup());

// findBy* and waitFor default to 1 s. Diagram tests wait on an ELK layout that runs in this thread, which can take
// several seconds on a loaded CI runner; the wait only lasts as long as the layout does.
configure({asyncUtilTimeout: 10_000});
