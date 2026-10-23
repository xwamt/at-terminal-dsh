import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The settings tab's layout invariants.
 *
 * These are asserted against the source because the defect they prevent is invisible to every
 * other kind of test: an SSH fingerprint is ~50 characters of base64 with no break opportunities,
 * and laying it out inline pushed the **Forget** button past the panel's right edge — the panel
 * grew a horizontal scrollbar and the action needed a sideways drag to reach. Nothing throws, no
 * copy is wrong, and a screenshot taken at the wrong width looks fine.
 *
 * Three properties, and each one is a specific way the overflow came back:
 *
 * 1. Strings with no spaces wrap (`overflowWrap: 'anywhere'`) instead of widening their card.
 * 2. Strings that must stay on one line also declare `minWidth: 0` — the CSS default is `auto`,
 *    and `min-width: auto` on a flex or grid child refuses to shrink, which is what makes
 *    `text-overflow: ellipsis` silently do nothing.
 * 3. The fingerprint gets its own line rather than sharing a row with the address and the button.
 */

const SOURCE = readFileSync(
  join(process.cwd(), 'src/platform/dsh/client/views/settingsTab.ts'),
  'utf8'
);

describe('the settings tab does not scroll sideways', () => {
  it('lets the fingerprint wrap', () => {
    expect(SOURCE).toMatch(/const fingerprintStyle = \{[\s\S]{0,400}?overflowWrap: 'anywhere'/);
    expect(SOURCE).toMatch(/const fingerprintStyle = \{[\s\S]{0,400}?wordBreak: 'break-all'/);
  });

  it('gives every truncating style a zero minimum width', () => {
    // `ellipsisStyle` is the one shared way to truncate; without `minWidth: 0` it is decorative.
    expect(SOURCE).toMatch(/const ellipsisStyle = \{[\s\S]{0,300}?minWidth: 0/);
    expect(SOURCE).toMatch(/const ellipsisStyle = \{[\s\S]{0,300}?textOverflow: 'ellipsis'/);
  });

  it('keeps the fingerprint off the address row', () => {
    // The key card is a column: address+button, then owner, then the fingerprint. If the
    // fingerprint moved back onto one line, this ordering would disappear.
    const card = SOURCE.slice(SOURCE.indexOf('style: keyCardStyle'));
    const ownerLine = card.indexOf('t(\'settings.trust.ownerless\')');
    const fingerprintLine = card.indexOf('style: fingerprintStyle');
    expect(ownerLine).toBeGreaterThan(-1);
    expect(fingerprintLine).toBeGreaterThan(ownerLine);
  });

  it('makes the audit command column shrinkable', () => {
    expect(SOURCE).toMatch(/gridTemplateColumns: '62px minmax\(64px, auto\) minmax\(0, 1fr\)'/);
  });

  it('pins the page to the panel width instead of a fixed column', () => {
    expect(SOURCE).toMatch(/const pageStyle = \{[\s\S]{0,300}?width: '100%'/);
    expect(SOURCE).toMatch(/const pageStyle = \{[\s\S]{0,300}?boxSizing: 'border-box'/);
  });
});
