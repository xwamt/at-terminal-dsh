import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// The directive belongs on the line TS reports — the `from '…'` line of a multi-line import.
import {
  OPTIONAL_BUNDLE_NAME,
  describeOptionalBundle,
  optionalBundleSpec
  // @ts-expect-error plain-JS host modules
} from '../../dsh/optionalBundle.js';

/**
 * The optional bundle seam.
 *
 * Three things are worth asserting here, and only the first is obvious:
 *
 * 1. `describeOptionalBundle` distinguishes the states the settings page renders — "no plugin
 *    manager", "not installed", "installed but off", "active". Collapsing any two of them shows
 *    the wrong button.
 * 2. The install spec is derived from **this package's version**, never from a request. A route
 *    that installed a caller-supplied package name would be a remote package installer behind a
 *    local HTTP fence, so the shape of the function is the guard.
 * 3. The channel takes no parameters for install. Asserted against the source because the guard is
 *    the signature, and a signature is not observable from behaviour.
 */

const BUNDLE = join(process.cwd(), 'dsh');

describe('the optional bundle description', () => {
  // The real manager answers with a promise (measured): the double must too, or the test would
  // pass against a shape that never occurs in production.
  const manager = (entry: unknown) => ({
    listBundles: async () => (entry === undefined ? [] : [entry])
  });

  it('reports installed but switched off', async () => {
    const state = await describeOptionalBundle({
      manager: manager({
        name: OPTIONAL_BUNDLE_NAME,
        installed: true,
        enabled: false,
        rows: [{ id: 'registry' }, { id: 'backend' }, { id: 'tools' }]
      }),
      version: '0.2.0'
    });
    expect(state).toMatchObject({ available: true, installed: true, enabled: false, rows: 3 });
    expect(state.spec).toBe('@at-series/dsh-at-terminal-ssh@0.2.0');
  });

  it('reports active with the row count', async () => {
    const state = await describeOptionalBundle({
      manager: manager({ name: OPTIONAL_BUNDLE_NAME, installed: true, enabled: true, rows: [1, 2, 3] }),
      version: '0.2.0'
    });
    expect(state).toMatchObject({ installed: true, enabled: true, rows: 3 });
  });

  it('reports present in the catalogue but not installed', async () => {
    const state = await describeOptionalBundle({ manager: manager(undefined), version: '0.2.0' });
    expect(state).toMatchObject({ available: true, installed: false, enabled: false, rows: 0 });
  });

  it('says why it cannot act when the composition has no plugin manager', async () => {
    const state = await describeOptionalBundle({ manager: undefined, version: '0.2.0' });
    expect(state.available).toBe(false);
    expect(state.reason).toContain('plugin manager');
  });

  it('survives a plugin manager that throws instead of propagating it', async () => {
    const state = await describeOptionalBundle({
      manager: {
        async listBundles() {
          throw new Error('profile locked')
        }
      },
      version: '0.2.0'
    });
    expect(state.available).toBe(false);
    expect(state.reason).toContain('profile locked');
  });

  it('pins the spec to this build, so a version mismatch cannot resolve a missing backend', () => {
    // The bundle references `@at-series/dsh-at-terminal/terminal-backend` by subpath: pairing
    // 0.3.0 of the shell with a 0.2.0 main package would resolve a backend that does not exist.
    expect(optionalBundleSpec('0.2.0')).toBe(`${OPTIONAL_BUNDLE_NAME}@0.2.0`);
    expect(optionalBundleSpec('0.3.1')).toBe(`${OPTIONAL_BUNDLE_NAME}@0.3.1`);
  });
});

describe('the channel guard', () => {
  const channel = readFileSync(join(BUNDLE, 'channel.js'), 'utf8');

  it('takes no caller-supplied spec for install', () => {
    // `install()` with no parameters is the guard: there is no field a page could put a package
    // name into.
    expect(channel).toMatch(/'terminal\.optionalBundle\.install'\(\)\s*\{/);
    expect(channel).toMatch(/const spec = optionalBundleSpec\(version\)/);
  });

  it('only switches the one bundle, by the constant name', () => {
    expect(channel).toMatch(/setBundleEnabled\(OPTIONAL_BUNDLE_NAME, enabled\)/);
  });

  it('asks the manager for the truth after acting', () => {
    // Both mutators re-read `describeOptionalBundle` instead of assuming the change took: an
    // install can succeed and still leave the rows unmounted.
    const install = channel.slice(channel.indexOf("'terminal.optionalBundle.install'"));
    expect(install).toContain('describeOptionalBundle({ manager, version })');
  });
});
