import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SftpWriteAuthorizer, type SftpWriteConfirmation } from '../../src/agent/SftpWriteAuthorizer';
import type { ServerConfig } from '../../src/config/schema';

/**
 * `docs/features*.md` said two opposite things about the same case, in both languages:
 *
 *   "Full trust skips both remote-command and SFTP write confirmation, **including
 *    sensitive paths**."          — docs/features.md
 *   "Sensitive paths … **always require a second confirmation** and are never
 *    remembered."                 — same file, three bullets later
 *   （中文侧同样："完全信任会跳过 … 含敏感路径" vs "敏感路径 … 一律二次确认"）
 *
 * A test cannot pick a side by reading prose, so it measures the code first and then
 * requires the prose to say what the code does. The measurement is two prompts, both
 * `once` — trust is granted to a server, not to `~/.ssh/authorized_keys` on it.
 */

const WORKSPACE_ROOT = '/home/deploy/app';
const SENSITIVE_PATH = '/etc/cron.d/backup';
const ORDINARY_PATH = `${WORKSPACE_ROOT}/notes/a.txt`;

function server(trust: ServerConfig['agentCommandTrust']): ServerConfig {
  return {
    id: `server-${trust ?? 'unset'}`,
    label: 'Production',
    host: 'prod.example.com',
    port: 22,
    username: 'deploy',
    authType: 'password',
    keepAliveInterval: 30,
    encoding: 'utf-8',
    createdAt: 1,
    updatedAt: 1,
    agentCommandTrust: trust
  };
}

/** Every stage the authorizer asks for, in order, on a fully trusted server. */
async function stagesUnderFullTrust(
  kind: 'write' | 'delete',
  path: string
): Promise<string[]> {
  const stages: string[] = [];
  const authorizer = new SftpWriteAuthorizer({
    confirm: async (confirmation: SftpWriteConfirmation) => {
      stages.push(confirmation.stage);
      return 'once';
    }
  });
  const request = { operation: 'write_file' as const, path, overwrite: false, workspaceRoot: WORKSPACE_ROOT };
  if (kind === 'write') {
    await authorizer.requireWrite(server('full'), request);
  } else {
    await authorizer.requireDelete(server('full'), { ...request, operation: 'delete_file' });
  }
  return stages;
}

/** The measured truth, computed once: these are what the documents must agree with. */
const SENSITIVE_WRITE_STAGES = await stagesUnderFullTrust('write', SENSITIVE_PATH);
const ORDINARY_WRITE_STAGES = await stagesUnderFullTrust('write', ORDINARY_PATH);
const SENSITIVE_DELETE_STAGES = await stagesUnderFullTrust('delete', SENSITIVE_PATH);

const FULL_TRUST = /full trust|完全信任/i;
const SENSITIVE = /sensitive|敏感/i;
const STILL_ASKS = /still|except|does not skip|never auto|二次确认|仍然|仍要|例外|除外/i;
/** The sentence used when a fully trusted server genuinely skips the prompt. */
const SKIPS = /skips?\b|does not ask|no prompt|跳过|不询问/i;

const DOCUMENTS = [
  { file: 'docs/features.md', sensitiveLine: /always require a second confirmation/i },
  { file: 'docs/features.zh-CN.md', sensitiveLine: /一律二次确认/ }
];

describe('the measured behaviour of full trust', () => {
  it('skips an ordinary write', () => {
    expect(ORDINARY_WRITE_STAGES).toEqual([]);
  });

  it('still asks twice for a sensitive write', () => {
    expect(SENSITIVE_WRITE_STAGES).toEqual(['primary', 'sensitive-double-check']);
  });

  it('still asks twice for a sensitive delete', () => {
    expect(SENSITIVE_DELETE_STAGES).toEqual(['primary', 'sensitive-double-check']);
  });
});

describe.each(DOCUMENTS)('$file', ({ file, sensitiveLine }) => {
  const lines = readFileSync(file, 'utf8').split('\n');
  const both = lines.filter((line) => FULL_TRUST.test(line) && SENSITIVE.test(line));

  it('states, somewhere, that sensitive paths always ask', () => {
    expect(lines.some((line) => sensitiveLine.test(line))).toBe(true);
  });

  it('never claims full trust skips sensitive paths, because it does not', () => {
    // At least one sentence has to mention both, or the next assertion is vacuous —
    // deleting the claim entirely would otherwise pass as "no contradiction".
    expect(both.length).toBeGreaterThan(0);
    for (const line of both) {
      expect({ line, stillAsks: STILL_ASKS.test(line) }).toEqual({ line, stillAsks: true });
    }
  });

  it('does not keep the old "including sensitive paths" phrasing next to "full trust"', () => {
    for (const line of both) {
      expect({ line, skipsWithoutException: SKIPS.test(line) && !STILL_ASKS.test(line) }).toEqual({
        line,
        skipsWithoutException: false
      });
    }
  });
});
