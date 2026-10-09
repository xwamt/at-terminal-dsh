import { setPlatform } from '../src/platform/current';
import { createFakePlatform } from './core/fakes';

/**
 * Installs the in-memory platform bundle before every test file.
 *
 * Domain code reads host capabilities through `platform()` (src/platform/current.ts),
 * which throws until the composition root calls `setPlatform()`. Unit tests never run
 * an extension activation, so the fake platform from `test/core/fakes.ts` stands in —
 * the same fakes `test/core/**` uses to verify the port contracts.
 */
setPlatform(createFakePlatform());