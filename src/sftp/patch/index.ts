/**
 * Vendored from `@deepseek-ai/dsh-fs-patch@0.2.2-rc.1` (`lib/index.js`).
 *
 * The upstream package is a pure, filesystem-independent parser and LF text updater adapted
 * from OpenAI Codex rust-v0.158.0. It is copied here because this plugin's `src/**` tree must
 * not import any `@deepseek-ai/*` package: the installed harness' packages live inside
 * `app.asar` and a `link:`-installed plugin cannot resolve them at runtime.
 *
 * Copyright 2025 OpenAI. Apache-2.0 portions. Copyright (c) 2026 DeepSeek. MIT License.
 * See NOTICE and LICENSE in this directory for the full attribution and license texts.
 * The implementation below is kept semantically identical to upstream; do not "improve" its
 * matching rules without updating the tests and the NOTICE version.
 */

/** One source line of a patch, with its one-based line number in the original input. */
interface PatchLine {
  text: string;
  number: number;
}

/** One update hunk produced by {@link parsePatch}. */
export interface PatchHunk {
  lineNumber: number;
  oldLines: string[];
  newLines: string[];
  isEndOfFile: boolean;
  /** Text after `@@` in the patch, used as a context anchor before the hunk's old lines. */
  context?: string;
}

/** One ordered file operation produced by {@link parsePatch}. */
export type ParsedPatchOperation =
  | { kind: 'add'; path: string; lineNumber: number; content: string }
  | { kind: 'delete'; path: string; lineNumber: number }
  | { kind: 'update'; path: string; lineNumber: number; hunks: PatchHunk[]; moveTo?: string };

/** Structured reason {@link applyHunks} could not apply one hunk. */
export interface PatchHunkFailure {
  hunkLineNumber: number;
  stage: 'context' | 'oldLines';
  searchStart: number;
  pattern: string[];
}

/** Result of {@link applyHunks}; a failure never includes partial text. */
export type ApplyHunksResult =
  | { ok: true; after: string }
  | { ok: false; failure: PatchHunkFailure };

/** Syntax failure with a one-based line in the original input, including any wrapper. */
export class PatchParseError extends Error {
  override readonly name = 'PatchParseError';

  constructor(
    public readonly lineNumber: number,
    public readonly reason: string
  ) {
    super(`Invalid patch at line ${lineNumber}: ${reason}`);
  }
}

// Rust uses Unicode White_Space (all in the BMP); JavaScript trim also removes BOM.
const WHITE_SPACE = /\p{White_Space}/u;
const BEGIN = '*** Begin Patch';
const END = '*** End Patch';
const EOF = '*** End of File';
const MOVE = '*** Move to: ';
const ADD = '*** Add File: ';
const DELETE = '*** Delete File: ';
const UPDATE = '*** Update File: ';

/** Scan the ends to avoid regex backtracking over long interior whitespace. */
function trim(value: string): string {
  let start = 0;
  while (start < value.length && WHITE_SPACE.test(value.charAt(start))) start += 1;
  return trimEnd(value.slice(start));
}

function trimEnd(value: string): string {
  let end = value.length;
  while (end > 0 && WHITE_SPACE.test(value.charAt(end - 1))) end -= 1;
  return value.slice(0, end);
}

function patchLines(patch: string): PatchLine[] {
  const offset =
    patch.slice(0, patch.length - patch.replace(/^\p{White_Space}+/u, '').length).split('\n').length - 1;
  let lines: PatchLine[] = trim(patch)
    .split(/\r?\n/u)
    .map((text, index) => ({ text, number: offset + index + 1 }));
  const first = lines[0];
  const last = lines[lines.length - 1];
  if (
    ["<<EOF", "<<'EOF'", '<<"EOF"'].includes(first.text) &&
    last.text.endsWith('EOF') &&
    lines.length >= 4
  ) {
    lines = lines.slice(1, -1);
  }
  const start = lines[0];
  const end = lines[lines.length - 1];
  if (trim(start.text) !== BEGIN) throw new PatchParseError(start.number, `Expected '${BEGIN}'`);
  if (trim(end.text) !== END) throw new PatchParseError(end.number, `Expected '${END}'`);
  return lines.map((line, index) =>
    index < lines.length - 1
      ? {
          ...line,
          text: line.text.replace(/\r$/u, '')
        }
      : line
  );
}

function emptyHunk(hunk: PatchHunk): boolean {
  return hunk.oldLines.length === 0 && hunk.newLines.length === 0;
}

function ensureUpdate(operation: ParsedPatchOperation | undefined, lineNumber: number): void {
  if (operation?.kind !== 'update') return;
  const last = operation.hunks[operation.hunks.length - 1];
  if (last === undefined) {
    throw new PatchParseError(operation.lineNumber, `Update for '${operation.path}' requires at least one hunk`);
  }
  if (emptyHunk(last)) {
    throw new PatchParseError(lineNumber, 'Update hunk must contain context, added, or removed lines');
  }
}

function newHunk(lineNumber: number): PatchHunk {
  return {
    lineNumber,
    oldLines: [],
    newLines: [],
    isEndOfFile: false
  };
}

function readUpdate(operation: Extract<ParsedPatchOperation, { kind: 'update' }>, line: PatchLine): void {
  const text = trimEnd(line.text);
  const previous = operation.hunks[operation.hunks.length - 1];
  const marker = text === '@@' || text.startsWith('@@ ');
  if (previous?.isEndOfFile) {
    if (text === '') return;
    if (!marker) throw new PatchParseError(line.number, "Expected '@@' after '*** End of File'");
  }
  if (previous === undefined && operation.moveTo === undefined && text.startsWith(MOVE)) {
    operation.moveTo = text.slice(13);
    return;
  }
  if (marker) {
    if (previous !== undefined && emptyHunk(previous)) {
      throw new PatchParseError(line.number, 'Update hunk must contain context, added, or removed lines');
    }
    const hunk = newHunk(line.number);
    if (text.startsWith('@@ ')) hunk.context = text.slice(3);
    operation.hunks.push(hunk);
    return;
  }
  if (text === EOF) {
    if (previous !== undefined) {
      if (emptyHunk(previous)) {
        throw new PatchParseError(line.number, 'Update hunk must contain context, added, or removed lines');
      }
      previous.isEndOfFile = true;
    }
    return;
  }
  const prefix = line.text[0];
  if (line.text !== '' && prefix !== ' ' && prefix !== '+' && prefix !== '-') {
    throw new PatchParseError(
      line.number,
      "Expected a context (' '), added ('+'), removed ('-') line, or '@@'"
    );
  }
  const hunk = previous ?? newHunk(line.number);
  if (previous === undefined) operation.hunks.push(hunk);
  const content = line.text.slice(1);
  if (prefix === '+') hunk.newLines.push(content);
  else if (prefix === '-') hunk.oldLines.push(content);
  else {
    hunk.oldLines.push(content);
    hunk.newLines.push(content);
  }
}

/**
 * Parse a complete Codex-style patch without reading or modifying files.
 *
 * @param patch patch text, optionally wrapped in a literal EOF heredoc
 * @returns ordered, JSON-serializable operations; an empty patch returns an empty array
 * @throws {PatchParseError} for malformed syntax or an unsupported Environment ID header
 */
export function parsePatch(patch: string): ParsedPatchOperation[] {
  const lines = patchLines(patch);
  const operations: ParsedPatchOperation[] = [];
  let ended = false;
  for (const line of lines.slice(1)) {
    const operation = operations[operations.length - 1];
    const header =
      operation?.kind === 'update' && line !== lines[lines.length - 1] ? trimEnd(line.text) : trim(line.text);
    if (ended && line !== lines[lines.length - 1]) {
      if (trim(line.text) !== '') throw new PatchParseError(line.number, `Unexpected content after '${END}'`);
      continue;
    }
    if (header === END) {
      ensureUpdate(operation, line.number);
      ended = true;
    } else if (header.startsWith(ADD)) {
      ensureUpdate(operation, line.number);
      operations.push({
        kind: 'add',
        path: header.slice(14),
        lineNumber: line.number,
        content: ''
      });
    } else if (header.startsWith(DELETE)) {
      ensureUpdate(operation, line.number);
      operations.push({
        kind: 'delete',
        path: header.slice(17),
        lineNumber: line.number
      });
    } else if (header.startsWith(UPDATE)) {
      ensureUpdate(operation, line.number);
      operations.push({
        kind: 'update',
        path: header.slice(17),
        lineNumber: line.number,
        hunks: []
      });
    } else if (operations.length === 0 && header.startsWith('*** Environment ID:')) {
      throw new PatchParseError(
        line.number,
        'Environment ID headers are unsupported; the caller selects the filesystem provider'
      );
    } else if (operation?.kind === 'add' && line.text.startsWith('+')) {
      operation.content += `${line.text.slice(1)}\n`;
    } else if (operation?.kind === 'update') {
      readUpdate(operation, line);
    } else {
      throw new PatchParseError(
        line.number,
        'Expected an Add File, Delete File, or Update File header; added content must start with +'
      );
    }
  }
  return operations;
}

const WHITE_SPACE_APPLY = /\p{White_Space}/u;

function trimWhitespace(value: string, leading: boolean): string {
  let start = 0;
  let end = value.length;
  if (leading) while (start < end && WHITE_SPACE_APPLY.test(value.charAt(start))) start += 1;
  while (end > start && WHITE_SPACE_APPLY.test(value.charAt(end - 1))) end -= 1;
  return value.slice(start, end);
}

function normalizePunctuation(value: string): string {
  return trimWhitespace(value, true)
    .replace(/[\u2010-\u2015\u2212]/gu, '-')
    .replace(/[\u2018-\u201B]/gu, "'")
    .replace(/[\u201C-\u201F]/gu, '"')
    .replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/gu, ' ');
}

const MATCH_PASSES: Array<(value: string) => string> = [
  (value) => value,
  (value) => trimWhitespace(value, false),
  (value) => trimWhitespace(value, true),
  normalizePunctuation
];

/** NormalizeToLf checks only the tail candidate for EOF, even before the cursor. */
function seekSequence(lines: string[], pattern: string[], start: number, eof: boolean): number | undefined {
  if (pattern.length === 0) return start;
  if (pattern.length > lines.length) return undefined;
  const last = lines.length - pattern.length;
  const first = eof ? last : start;
  for (const normalize of MATCH_PASSES) {
    const expected = pattern.map(normalize);
    for (let index = first; index <= last; index += 1) {
      if (expected.every((line, offset) => normalize(lines[index + offset]) === line)) return index;
    }
  }
  return undefined;
}

/**
 * Apply parsed hunks to LF-normalized text without I/O or input mutation.
 *
 * All searches use the original text; a failed search returns no partial text. Successful
 * nonempty output ends in LF, including initially unterminated text.
 *
 * @param before text normalized by the caller; CR characters receive no line-ending handling
 * @param hunks ordered hunks from {@link parsePatch}; EOF searches follow NormalizeToLf tail semantics
 * @returns new text or the first unmatched hunk, without throwing for a match failure
 */
export function applyHunks(before: string, hunks: PatchHunk[]): ApplyHunksResult {
  const original = before.split('\n');
  if (original[original.length - 1] === '') original.pop();
  const replacements: Array<{ start: number; oldLength: number; newLines: string[] }> = [];
  let lineIndex = 0;
  for (const hunk of hunks) {
    if (hunk.context !== undefined) {
      const pattern = [hunk.context];
      const found = seekSequence(original, pattern, lineIndex, false);
      if (found === undefined) {
        return {
          ok: false,
          failure: {
            hunkLineNumber: hunk.lineNumber,
            stage: 'context',
            searchStart: lineIndex,
            pattern
          }
        };
      }
      lineIndex = found + 1;
    }
    if (hunk.oldLines.length === 0) {
      const start = original[original.length - 1] === '' ? original.length - 1 : original.length;
      replacements.push({
        start,
        oldLength: 0,
        newLines: hunk.newLines
      });
      continue;
    }
    let pattern = hunk.oldLines;
    let newLines = hunk.newLines;
    let found = seekSequence(original, pattern, lineIndex, hunk.isEndOfFile);
    if (found === undefined && pattern[pattern.length - 1] === '') {
      pattern = pattern.slice(0, -1);
      if (newLines[newLines.length - 1] === '') newLines = newLines.slice(0, -1);
      found = seekSequence(original, pattern, lineIndex, hunk.isEndOfFile);
    }
    if (found === undefined) {
      return {
        ok: false,
        failure: {
          hunkLineNumber: hunk.lineNumber,
          stage: 'oldLines',
          searchStart: lineIndex,
          pattern: [...hunk.oldLines]
        }
      };
    }
    replacements.push({
      start: found,
      oldLength: pattern.length,
      newLines
    });
    lineIndex = found + pattern.length;
  }
  replacements.sort((left, right) => left.start - right.start);
  let lines = original;
  for (const replacement of replacements.reverse()) {
    lines = [
      ...lines.slice(0, replacement.start),
      ...replacement.newLines,
      ...lines.slice(replacement.start + replacement.oldLength)
    ];
  }
  if (lines[lines.length - 1] !== '') lines.push('');
  return {
    ok: true,
    after: lines.join('\n')
  };
}
