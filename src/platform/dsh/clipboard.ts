import type { Clipboard } from '../../core/ports';
import type { DshLogger } from './host';

/**
 * The dsh implementation of the `Clipboard` port.
 *
 * dsh's Host half owns no clipboard: the web UI runs in the renderer, and the three
 * call sites this port serves (`src/extension.ts` copies a host address, a host-key
 * fingerprint, and a remote path) are *user gestures* in the Client half. There is
 * therefore nothing to adapt — the capability simply is not on this side.
 *
 * What the adapter must not do is pretend. Two dishonest options were rejected:
 *
 * - **throw**: the port has no error channel, so a copy would fail the surrounding
 *   command, and the caller would report "copy failed" for a reason it cannot
 *   explain;
 * - **silently do nothing**: the user would believe the value is on their clipboard.
 *
 * So the text goes to `ctx.logger` instead. The value is one the user was already
 * looking at (an address, a fingerprint, a path — never a credential), and the log
 * line is a real delivery mechanism in a headless host: it is where an operator can
 * recover it. When the M3/M4 Client half lands, `writeText` becomes a message to the
 * renderer and this file stops being the endpoint — the call sites do not change,
 * which is the point of the port.
 */
export function createDshClipboard({ logger }: { logger: DshLogger }): Clipboard {
  return {
    async writeText(text: string): Promise<void> {
      logger.info('AT Terminal: clipboard write requested — %s', text);
    }
  };
}
