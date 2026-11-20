// packages/viewer/test/setup.ts  (WP0, frozen) - loaded before every viewer test file (vitest.config.ts).
// vitest runs without globals, so React Testing Library cannot register these itself.
import {cleanup} from '@testing-library/react';
import {afterEach} from 'vitest';

// Tell React that state updates are expected to be wrapped in act(); RTL's render, fireEvent and waitFor do that.
(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;

// Unmount everything a test rendered.
afterEach(() => cleanup());
