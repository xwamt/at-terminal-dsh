import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
// @ts-expect-error plain-JS ESM helper with no type declarations
import { findDshAsar, openAsar } from '../../dsh/scripts/lib/asar.mjs';

/**
 * The documents below describe *this install*: "verified against Harness 0.2.1-rc.2" and
 * "nine independent checks". Both kinds of number rot silently — 0.1.7-rc.2 survived a
 * whole release after the Host had moved on — so they are read back from the artefacts
 * they claim to describe rather than trusted.
 *
 * Per the repo's third iron law, "no Harness installed" is a **skip**, never a pass: the
 * version claim cannot be checked without the install, and a green tick would be a lie.
 */

interface AsarArchive {
  read(path: string): Buffer | null;
  close(): void;
}

function installedHostVersion(): string | null {
  const archive: string | null = findDshAsar();
  if (archive === null) return null;
  let asar: AsarArchive | null = null;
  try {
    asar = openAsar(archive) as AsarArchive;
    const manifest = asar.read('/dsh/node_modules/@deepseek-ai/dsh/package.json');
    if (manifest === null) return null;
    const version = JSON.parse(manifest.toString('utf8'))?.version;
    return typeof version === 'string' ? version : null;
  } catch {
    return null;
  } finally {
    asar?.close();
  }
}

const HOST_VERSION = installedHostVersion();

/** `DSH-0.2.1--rc.2_Verified` — shields.io escapes a literal `-` as `--`. */
function badgeVersion(readme: string): string | null {
  const badge = /!\[DSH Verified\]\([^)]*\/badge\/DSH-([^_]+)_Verified[^)]*\)/.exec(readme);
  return badge === null ? null : badge[1].replace(/--/g, '-');
}

function verifiedAgainst(dshReadme: string): string | null {
  const claim = /Verified against:[^\n]*?`([0-9][^`]*)`/.exec(dshReadme);
  return claim === null ? null : claim[1];
}

const WORD_NUMBERS: Record<string, number> = {
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12
};

/** The real number of entries `verify:dsh` runs, counted where they are declared. */
function actualCheckCount(): number {
  const source = readFileSync('dsh/scripts/verify.mjs', 'utf8');
  return (source.match(/^\s*await check\(/gm) ?? []).length;
}

describe.skipIf(HOST_VERSION === null)('host version claims', () => {
  it('the README badge names the installed Harness', () => {
    expect(HOST_VERSION).not.toBeNull();
    expect(badgeVersion(readFileSync('README.md', 'utf8'))).toBe(HOST_VERSION);
  });

  it('dsh/README.md "Verified against" names the installed Harness', () => {
    expect(verifiedAgainst(readFileSync('dsh/README.md', 'utf8'))).toBe(HOST_VERSION);
  });

  it('dsh/README.md counts the kernel gate checks correctly', () => {
    const kernel = readFileSync('scripts/verify-kernel-seam.mjs', 'utf8');
    const kernelCount = (kernel.match(/^\s*await check\(/gm) ?? []).length;
    const dshReadme = readFileSync('dsh/README.md', 'utf8');
    const stated = /verify-kernel-seam\.mjs,\s*(\d+)\s*checks/.exec(dshReadme);
    expect(stated).not.toBeNull();
    expect({ stated: Number(stated![1]), actual: kernelCount }).toEqual({
      stated: kernelCount,
      actual: kernelCount
    });
  });
});

describe('stated gate counts', () => {
  const count = actualCheckCount();

  it('dsh/README.md states the number of checks verify.mjs actually runs', () => {
    const statement = /\*\*([A-Za-z]+)\*\* independent checks/.exec(readFileSync('dsh/README.md', 'utf8'));
    expect(statement).not.toBeNull();
    const word = statement![1].toLowerCase();
    expect({ word, count: WORD_NUMBERS[word] ?? Number(word) }).toEqual({ word, count });
  });

  it('README.md states the same number in the build-and-verify section', () => {
    const line = readFileSync('README.md', 'utf8')
      .split('\n')
      .find((candidate) => candidate.includes('项自动化合规规则'));
    expect(line).toBeDefined();
    const stated = /\((\d+)\s*项/.exec(line!);
    expect(stated).not.toBeNull();
    expect({ stated: Number(stated![1]), actual: count }).toEqual({ stated: count, actual: count });
  });

  it('counts something, so the assertions above cannot pass on an empty file', () => {
    expect(count).toBeGreaterThanOrEqual(9);
  });
});
