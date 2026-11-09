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
 * Four things are worth asserting here, and only the first is obvious:
 *
 * 1. `describeOptionalBundle` distinguishes the states the settings page renders — "no plugin
 *    manager", "not installed", "installed but off", "active", "enabled but activation failed",
 *    and "enabled but unverifiable". Collapsing any two of them shows the wrong button or, worse,
 *    paints a failed bundle as Active.
 * 2. `enabled` is only the saved selection. A 0.2.2 install result can carry `pendingBuilds`,
 *    an activation `diagnostic`, or a `restoring` update; those must be surfaced, not swallowed.
 * 3. The install spec is derived from **this package's version**, never from a request. A route
 *    that installed a caller-supplied package name would be a remote package installer behind a
 *    local HTTP fence, so the shape of the function is the guard.
 * 4. The channel takes only the 0.2.2 options the page can justify (`enabled`, `approvedBuilds`,
 *    `requestId`) and keeps the last change result for the next read.
 */

const BUNDLE = join(process.cwd(), 'dsh');

describe('the optional bundle description', () => {
  // The real manager answers with a promise (measured): the double must too, or the test would
  // pass against a shape that never occurs in production.
  const manager = (entry: unknown, plugins?: unknown) => ({
    listBundles: async () => (entry === undefined ? [] : [entry]),
    ...(plugins === undefined ? {} : { listPlugins: async () => plugins })
  });

  const rows = [
    { rowId: 'registry', entryId: 'entry-registry' },
    { rowId: 'backend', entryId: 'entry-backend' },
    { rowId: 'tools', entryId: 'entry-tools' }
  ];
  const activePlugins = [
    { entryId: 'entry-registry', fiberPhase: 'active' },
    { entryId: 'entry-backend', fiberPhase: 'active' },
    { entryId: 'entry-tools', fiberPhase: 'active' }
  ];

  it('reports installed but switched off as unknown activation', async () => {
    const state = await describeOptionalBundle({
      manager: manager({ name: OPTIONAL_BUNDLE_NAME, installed: true, enabled: false, rows }),
      version: '0.2.0'
    });
    expect(state).toMatchObject({
      available: true,
      installed: true,
      enabled: false,
      rows: 3,
      activation: 'unknown'
    });
    expect(state.spec).toBe('@at-series/dsh-at-terminal-ssh@0.2.0');
  });

  it('reports active only when every declared row is mounted and its fiber is active', async () => {
    const state = await describeOptionalBundle({
      manager: manager(
        { name: OPTIONAL_BUNDLE_NAME, installed: true, enabled: true, rows },
        activePlugins
      ),
      version: '0.2.0'
    });
    expect(state).toMatchObject({ installed: true, enabled: true, rows: 3, activation: 'active' });
  });

  it('falls back to the declared row count when an older manager cannot list plugin fibers', async () => {
    // 0.2.1 managers only answer `listBundles`; a bundle with declared rows is the best available
    // evidence there. A manager that can report fibers is never allowed this shortcut.
    const state = await describeOptionalBundle({
      manager: manager({ name: OPTIONAL_BUNDLE_NAME, installed: true, enabled: true, rows: [1, 2, 3] }),
      version: '0.2.0'
    });
    expect(state).toMatchObject({ installed: true, enabled: true, rows: 3, activation: 'active' });
  });

  it('does not call a partly mounted bundle active', async () => {
    // `enabled` is the saved selection; one row still loading is not an active bundle.
    const state = await describeOptionalBundle({
      manager: manager(
        { name: OPTIONAL_BUNDLE_NAME, installed: true, enabled: true, rows },
        [
          { entryId: 'entry-registry', fiberPhase: 'active' },
          { entryId: 'entry-backend', fiberPhase: 'loading' },
          { entryId: 'entry-tools', fiberPhase: 'active' }
        ]
      ),
      version: '0.2.0'
    });
    expect(state.activation).toBe('unknown');
  });

  it('reports a bundle-level manager error as failed, not Active', async () => {
    const state = await describeOptionalBundle({
      manager: manager({
        name: OPTIONAL_BUNDLE_NAME,
        installed: true,
        enabled: true,
        rows,
        error: { code: 'operation-error', diagnostic: 'the bundle patch could not be read' }
      }),
      version: '0.2.0'
    });
    expect(state).toMatchObject({ installed: true, enabled: true, activation: 'failed' });
    expect(state.diagnostic).toContain('patch could not be read');
  });

  it('reports a failed row fiber as failed, with the row diagnostic', async () => {
    const state = await describeOptionalBundle({
      manager: manager(
        { name: OPTIONAL_BUNDLE_NAME, installed: true, enabled: true, rows },
        [
          { entryId: 'entry-registry', fiberPhase: 'active' },
          { entryId: 'entry-backend', fiberPhase: 'failed', diagnostic: 'Cannot find module terminal-backend' },
          { entryId: 'entry-tools', fiberPhase: 'active' }
        ]
      ),
      version: '0.2.0'
    });
    expect(state.activation).toBe('failed');
    expect(state.diagnostic).toContain('Cannot find module');
  });

  it('surfaces pendingBuilds from a failed install and still calls activation failed', async () => {
    // The package did not install, but the profile's saved selection can already say enabled.
    // The page needs the exact names to offer "allow these scripts and retry".
    const state = await describeOptionalBundle({
      manager: manager({ name: OPTIONAL_BUNDLE_NAME, installed: true, enabled: true, rows }),
      version: '0.2.0',
      install: {
        changed: false,
        application: 'failed',
        stage: 'install',
        target: OPTIONAL_BUNDLE_NAME,
        pendingBuilds: ['esbuild', 'sharp']
      }
    });
    expect(state).toMatchObject({
      enabled: true,
      activation: 'failed',
      pendingBuilds: ['esbuild', 'sharp']
    });
  });

  it('surfaces the 0.2.2 activation diagnostic from a failed enable result', async () => {
    const state = await describeOptionalBundle({
      manager: manager({ name: OPTIONAL_BUNDLE_NAME, installed: true, enabled: true, rows }),
      version: '0.2.0',
      install: {
        changed: true,
        application: 'failed',
        stage: 'enable',
        target: OPTIONAL_BUNDLE_NAME,
        error: { code: 'operation-error', diagnostic: 'plugin activate failed: boom' }
      }
    });
    expect(state.activation).toBe('failed');
    expect(state.diagnostic).toContain('plugin activate failed');
  });

  it('reports restart-required as unknown rather than active', async () => {
    // The package installed but its rows start only after a restart; calling that Active would
    // be the same lie as calling a saved selection "running".
    const state = await describeOptionalBundle({
      manager: manager({ name: OPTIONAL_BUNDLE_NAME, installed: true, enabled: true, rows }, []),
      version: '0.2.0',
      install: {
        changed: true,
        application: 'restart-required',
        stage: 'install',
        target: OPTIONAL_BUNDLE_NAME,
        restartReason: 'no-hmr'
      }
    });
    expect(state.activation).toBe('unknown');
    expect(state.restoring).toBeUndefined();
  });

  it('reports a restoring update as unknown and keeps the restoring flag', async () => {
    const state = await describeOptionalBundle({
      manager: manager({ name: OPTIONAL_BUNDLE_NAME, installed: true, enabled: true, rows }),
      version: '0.2.0',
      install: {
        changed: true,
        application: 'failed',
        stage: 'install',
        target: OPTIONAL_BUNDLE_NAME,
        restore: { changed: true, application: 'applied', stage: 'install', target: OPTIONAL_BUNDLE_NAME }
      }
    });
    expect(state.restoring).toBe(true);
    expect(state.activation).toBe('unknown');
  });

  it('reports present in the catalogue but not installed', async () => {
    const state = await describeOptionalBundle({ manager: manager(undefined), version: '0.2.0' });
    expect(state).toMatchObject({
      available: true,
      installed: false,
      enabled: false,
      rows: 0,
      activation: 'unknown'
    });
  });

  it('says why it cannot act when the composition has no plugin manager', async () => {
    const state = await describeOptionalBundle({ manager: undefined, version: '0.2.0' });
    expect(state.available).toBe(false);
    expect(state.activation).toBe('unknown');
    expect(state.reason).toContain('plugin manager');
  });

  it('survives a plugin manager that throws instead of propagating it', async () => {
    const state = await describeOptionalBundle({
      manager: {
        async listBundles() {
          throw new Error('profile locked');
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
  const installStart = channel.indexOf("'terminal.optionalBundle.install'");
  const install = channel.slice(installStart, channel.indexOf("'terminal.optionalBundle.setEnabled'"));

  it('takes no caller-supplied spec for install', () => {
    // `install(params)` may carry only the build approval and request id; there is no field a
    // page could put a package name into.
    expect(channel).toMatch(/'terminal\.optionalBundle\.install'\(params = \{\}\)\s*\{/);
    expect(channel).toMatch(/const spec = optionalBundleSpec\(version\)/);
    expect(install).not.toContain('params.spec');
  });

  it('sends the explicit 0.2.2 enable option instead of the dead activateNewBundles name', () => {
    expect(install).toContain('enabled: true');
    expect(install).not.toContain('activateNewBundles');
  });

  it('passes approvedBuilds and requestId through as real install options', () => {
    expect(install).toContain('options.approvedBuilds = [...params.approvedBuilds]');
    expect(install).toContain('options.requestId = params.requestId');
    expect(install).toContain('bad-params');
  });

  it('keeps the last change result so the next get can explain a failed activation', () => {
    expect(install).toContain('lastOptionalChange = outcome ?? null');
    expect(install).toContain('describeOptionalBundle({ manager, version, install: lastOptionalChange })');
    const get = channel.slice(
      channel.indexOf("'terminal.optionalBundle.get'"),
      channel.indexOf("'terminal.optionalBundle.install'")
    );
    expect(get).toContain('install: lastOptionalChange');
  });

  it('only switches the one bundle, by the constant name', () => {
    expect(channel).toMatch(/setBundleEnabled\(OPTIONAL_BUNDLE_NAME, enabled\)/);
  });
});
