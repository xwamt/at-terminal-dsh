import { describe, expect, it, vi } from 'vitest';
// @ts-expect-error plain-JS host module
import { RUNTIME_SKILLS, recordSkillStatus, registerRuntimeSkills, skillStatusText, verifyRegisteredSkills } from '../../dsh/skills.js';

/**
 * Runtime skills.
 *
 * The host's `register()` validates the name and description, then answers a duplicate with a
 * **warning plus a no-op disposer** (`dsh-skill/lib/index.js:197-199`) — it does not throw. So
 * "the call returned" is not evidence that a skill landed, and the code that reports success
 * has to read the catalog instead of trusting the call. These tests model that: the fake
 * register can accept, ignore or reject, and every claim is checked against what `list()` says.
 */
function fakeSkills({ ignore = [] as string[], reject = '' } = {}) {
  const store = new Map<string, { name: string; description?: string }>();
  return {
    store,
    register: vi.fn((skill: { name: string; description: string }) => {
      if (reject !== '' && skill.name === reject) throw new Error(`invalid skill name "${skill.name}"`);
      if (ignore.includes(skill.name) || store.has(skill.name)) return () => {};
      store.set(skill.name, skill);
      return () => {
        store.delete(skill.name);
      };
    }),
    list: vi.fn(async () => [...store.values()].map((skill) => ({ name: skill.name })))
  };
}

describe('the runtime skill catalog', () => {
  it('uses names the host will accept, with real bodies behind them', () => {
    // `SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/` and a non-empty description are the only
    // things `validateRuntimeSkill` checks; a name outside that pattern throws at load.
    for (const skill of RUNTIME_SKILLS) {
      expect(skill.name).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
      expect(skill.description.length).toBeGreaterThan(40);
      expect(skill.whenToUse.length).toBeGreaterThan(40);
      // The body is what the model gets on invocation; an empty one would register a skill
      // that teaches nothing.
      expect(skill.content).toContain('#');
      expect(skill.content.length).toBeGreaterThan(400);
    }
    expect(new Set(RUNTIME_SKILLS.map((skill: { name: string }) => skill.name)).size).toBe(RUNTIME_SKILLS.length);
  });

  it('registers every skill, and the catalog agrees', async () => {
    recordSkillStatus('reset for test');
    const skills = fakeSkills();

    const outcome = registerRuntimeSkills(skills);
    const status = await verifyRegisteredSkills(skills);

    expect(outcome.registered).toBe(RUNTIME_SKILLS.length);
    expect(skills.register).toHaveBeenCalledTimes(RUNTIME_SKILLS.length);
    expect(status).toBe(`registered ${RUNTIME_SKILLS.length}/${RUNTIME_SKILLS.length} (catalog confirms)`);
    expect(skillStatusText()).toBe(status);
  });

  it('does not claim a skill the catalog does not offer', async () => {
    // The failure this exists for: `register()` returns a no-op for a name someone else
    // already owns, so the count says three while the catalog has two of ours.
    recordSkillStatus('reset for test');
    const skills = fakeSkills({ ignore: ['at-terminal-remote-edit'] });

    const outcome = registerRuntimeSkills(skills);
    const status = await verifyRegisteredSkills(skills);

    expect(outcome.registered).toBe(RUNTIME_SKILLS.length);
    expect(status).toContain(`not in catalog: at-terminal-remote-edit`);
    expect(status).not.toContain('catalog confirms');
  });

  it('stops at the first refusal and names it', () => {
    recordSkillStatus('reset for test');
    const skills = fakeSkills({ reject: 'at-terminal-incident-log' });

    const outcome = registerRuntimeSkills(skills);

    expect(outcome.registered).toBe(RUNTIME_SKILLS.length - 1);
    expect(outcome.status).toContain('invalid skill name');
  });

  it('says which piece is missing instead of failing the plugin', async () => {
    recordSkillStatus('reset for test');

    expect(registerRuntimeSkills(undefined).status).toContain('skills service lacks register()');
    // A catalog that cannot be read is still not a reason to throw: the tools work, the
    // skills are simply unverified, and the status says exactly that.
    const status = await verifyRegisteredSkills({ register: () => () => {} });
    expect(status).toContain('catalog unreadable');
  });
});
