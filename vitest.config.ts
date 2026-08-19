import { defineConfig } from 'vitest/config';
import { WxtVitest } from 'wxt/testing/vitest-plugin';

// Most of this codebase is pure functions: no DOM, no browser, no mocks.
//
// The exceptions are the cache and the router, which are the two places a real
// bug can hide behind an await. WXT's plugin resolves `#imports` and swaps in
// an in-memory `browser`, so those get tested for real rather than mocked into
// agreement with whatever they currently do.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    mockReset: true,
    restoreMocks: true,
  },
  plugins: [WxtVitest()],
});
