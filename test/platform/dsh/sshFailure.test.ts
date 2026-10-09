import { describe, expect, it } from 'vitest';

import { classifySshFailure } from '../../../src/platform/dsh/sshFailure';

/**
 * The classifier exists because a real connect showed the user ssh2's own wording:
 * `connect-failed: All configured authentication methods failed` — a message that names
 * neither what was tried nor what to do. These assertions pin what it may and may not
 * claim: an authentication refusal is *rejected methods*, never "your password is
 * wrong", because the server does not tell us which part it disliked.
 */

const context = { host: '10.0.0.1', port: 22 };

describe('dsh SSH failure classification', () => {
  it('names an authentication refusal without inventing a cause', () => {
    const failure = classifySshFailure(
      Object.assign(new Error('All configured authentication methods failed'), {
        level: 'client-authentication'
      }),
      context
    );
    expect(failure.code).toBe('authentication-failed');
    expect(failure.message).toContain('10.0.0.1:22');
    // The server lists what it accepts, not what it disliked.
    expect(failure.message).not.toMatch(/wrong password|invalid password/i);
  });

  it('maps ssh2 and errno transport failures onto their own codes', () => {
    const cases: Array<[{ code?: string; level?: string }, string]> = [
      [{ code: 'ECONNREFUSED' }, 'connection-refused'],
      [{ code: 'ENOTFOUND' }, 'host-unresolved'],
      [{ code: 'EAI_AGAIN' }, 'host-unresolved'],
      [{ code: 'ETIMEDOUT' }, 'connection-timeout'],
      [{ level: 'client-timeout' }, 'connection-timeout'],
      [{ code: 'ENOENT' }, 'private-key-unreadable'],
      [{ code: 'EHOSTUNREACH' }, 'host-unreachable'],
      [{ code: 'ENETUNREACH' }, 'host-unreachable']
    ];
    for (const [shape, expected] of cases) {
      const failure = classifySshFailure(Object.assign(new Error('boom'), shape), context);
      expect(failure.code, JSON.stringify(shape)).toBe(expected);
      expect(failure.message.length).toBeGreaterThan(0);
    }
  });

  it('keeps a code the domain already assigned, message and all', () => {
    expect(
      classifySshFailure(
        Object.assign(new Error('Missing password. Edit the server configuration and enter a password.'), {
          code: 'password-missing'
        }),
        context
      )
    ).toEqual({
      code: 'password-missing',
      message: 'Missing password. Edit the server configuration and enter a password.'
    });
    expect(
      classifySshFailure(Object.assign(new Error('10.0.0.1:22 is not a known host.'), { code: 'host-key-unknown' }), context)
        .code
    ).toBe('host-key-unknown');
  });

  it('falls back to connect-failed, carrying the original message', () => {
    expect(classifySshFailure(new Error('something odd'), context)).toEqual({
      code: 'connect-failed',
      message: 'something odd'
    });
    expect(classifySshFailure('a string', context)).toEqual({
      code: 'connect-failed',
      message: 'a string'
    });
  });

  it('describes the target, or says "the server" rather than inventing one', () => {
    expect(classifySshFailure(Object.assign(new Error('x'), { code: 'ECONNREFUSED' })).message).toContain(
      'the server'
    );
    expect(
      classifySshFailure(Object.assign(new Error('x'), { code: 'ECONNREFUSED' }), { host: 'h' }).message
    ).toContain('h');
  });
});