import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('writing operations documents skill', () => {
  const root = 'skills/writing-ops-documents';
  const references: Record<string, string[]> = {
    'document-standard': ['Markdown', '待确认', '脱敏', '事实', '推断'],
    'operation-record': ['影响评估', '备份', '实际执行', '回滚', '验证'],
    'troubleshooting-report': ['时间线', '业务影响', '证据', '根因待确认', '改进措施'],
    'service-deployment': ['前置检查', '制品', '观察期', '回滚触发条件', '业务验证'],
    'service-inspection': ['检查项', '判定标准', '未检查', '风险等级', '整改建议'],
    'general-ops-document': ['受众', '用途', '应急预案', '交接', '责任人']
  };

  it('ships an installable progressive-disclosure router', () => {
    const skill = readFileSync(`${root}/SKILL.md`, 'utf8');

    expect(skill).toContain('name: writing-ops-documents');
    expect(skill).toContain('Use when');
    expect(skill).toContain('中文 Markdown');
    expect(skill).toContain('$at-terminal-mcp');
    for (const name of Object.keys(references)) {
      expect(skill).toContain(`references/${name}.md`);
    }
    expect(skill.split(/\s+/).length).toBeLessThan(500);
  });

  it('ships one-level references with operations-specific requirements', () => {
    for (const [name, signals] of Object.entries(references)) {
      const path = `${root}/references/${name}.md`;
      expect(existsSync(path)).toBe(true);
      const content = readFileSync(path, 'utf8');
      for (const signal of signals) expect(content).toContain(signal);
    }
  });

  it('forbids fabricated evidence and unsafe documentation shortcuts', () => {
    const skill = readFileSync(`${root}/SKILL.md`, 'utf8');
    const standard = readFileSync(`${root}/references/document-standard.md`, 'utf8');

    expect(skill).toContain('不得编造');
    expect(skill).toContain('计划');
    expect(skill).toContain('实际');
    expect(standard).toContain('密码');
    expect(standard).toContain('Token');
    expect(standard).toContain('私钥');
    expect(standard).toContain('未提供');
    expect(standard).toContain('证据来源');
  });

  it('provides compatible UI metadata without requiring an MCP dependency', () => {
    const metadata = readFileSync(`${root}/agents/openai.yaml`, 'utf8');

    expect(metadata).toContain('display_name: "Operations Documents"');
    expect(metadata).toContain('$writing-ops-documents');
    expect(metadata).not.toContain('dependencies:');
  });

  it('teaches evidence-safe wording with an example and common mistakes', () => {
    const standard = readFileSync(`${root}/references/document-standard.md`, 'utf8');

    expect(standard).toContain('## 表达示例');
    expect(standard).toContain('已验证事实');
    expect(standard).toContain('推断');
    expect(standard).toContain('## 常见错误');
    expect(standard).toContain('预期结果写成实际结果');
  });

  /**
   * The README lists this repository's own skill set.
   *
   * The assertions here used to describe the **VS Code variant** — an `### Agent Skills`
   * heading, a `skills/at-terminal-mcp/` directory (this repository has never had one) and a
   * marketplace install line (`npx skills add xwamt/At-Terminal`). None of those exist here,
   * so the test was red from the first commit and the README rewrite in `a410b8b` was blamed
   * for it. What the README actually promises is the six directories under `skills/`, which
   * is what this now checks — every one of them verified on disk, so a renamed or dropped
   * skill cannot leave a stale line in the docs.
   */
  it('documents this repository\'s skill set in the README', () => {
    const readme = readFileSync('README.md', 'utf8');

    expect(readme).toContain('### DSH 创造套件技能体系（Skills）');
    for (const name of [
      'dsh-creator-skills',
      'cordis-plugin-development',
      'editing-cordis-compositions',
      'cordis-composition-reference',
      'agent-experience',
      'writing-ops-documents'
    ]) {
      // Documented **and** present: the README is the index, not a copy of the tree.
      expect(readme).toContain(`${name}/`);
      expect(existsSync(`skills/${name}/SKILL.md`)).toBe(true);
    }
  });
});
