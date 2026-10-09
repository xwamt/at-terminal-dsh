import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['test/**/*.test.ts'],
    setupFiles: ['test/setup-platform.ts'],
    fileParallelism: false
  },
  resolve: {
    alias: [
      // The Client half imports React, which the browser module table provides and this repo does not
      // depend on (`src/platform/dsh/client/react.d.ts` declares the members it uses). A test that
      // imports a client module directly needs a runtime stand-in.
      //
      // Anchored, unlike the string form: a string alias matches `react/…` subpaths too
      // (`react/jsx-runtime`), and would resolve those into the fixture's directory as a missing
      // file — a failure whose cause would be three steps away from its message.
      { find: /^react$/, replacement: resolve(process.cwd(), 'test-fixtures/react.ts') }
    ]
  }
});
