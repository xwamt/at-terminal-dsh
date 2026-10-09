import { describe, expect, it } from 'vitest';
import type { HostEnvironment } from '../../../src/core/ports';
import { createDshHostEnvironment } from '../../../src/platform/dsh/environment';
import type { DshHostFacts } from '../../../src/platform/dsh/host';

/**
 * `createDshHostEnvironment` is a pure mapping from the injected `DshHostFacts` to the
 * port, with one deliberate absence (`workspaceFolders`). Both are asserted here.
 */

const FACTS: DshHostFacts = {
  pluginName: '@at-series/dsh-at-terminal',
  pluginVersion: '1.0.0',
  bundlePath: '/home/user/.dsh/bundles/at-terminal',
  storageDir: '/home/user/.dsh/storages/at-terminal',
  appName: 'DeepSeek Harness',
  appRoot: '/opt/deepseek-harness',
  uriScheme: 'dsh'
};

describe('createDshHostEnvironment', () => {
  it('maps every field one-to-one from the injected facts', () => {
    const env: HostEnvironment = createDshHostEnvironment(FACTS);

    // Host identity straight from the facts (there is no ctx.env to read on dsh).
    expect(env.appName).toBe('DeepSeek Harness');
    expect(env.appRoot).toBe('/opt/deepseek-harness');
    expect(env.uriScheme).toBe('dsh');
    // `extensionPath` is the bundle directory, `storageDir` the $DSH_HOME-based data dir.
    expect(env.extensionPath).toBe('/home/user/.dsh/bundles/at-terminal');
    expect(env.storageDir).toBe('/home/user/.dsh/storages/at-terminal');
  });

  it('reports no workspace rather than fabricating one (the caller falls back to extension storage)', () => {
    const env = createDshHostEnvironment(FACTS);

    expect(env.workspaceFolders).toBeUndefined();
    // The consumption site treats it the same as VS Code with no folder open: it takes the
    // fallback branch. Asserting the projection makes that intent explicit.
    const editStorage = env.workspaceFolders ?? [];
    expect(editStorage).toHaveLength(0);
  });
});
