/**
 * Full results that do not fit inline, handed to the Host's own spill store.
 *
 * Every tool in this bundle caps what it returns: `run_remote_command` defaults to 64 000
 * bytes per stream, `sftp_read_file` to 64 KiB. Past the cap the rest was simply gone — the
 * model could see that a result was cut (`truncated: true`) and had no way to ask for what
 * was cut off, so a wide `ps` or a long log became "run it again with `| tail`", which is a
 * second round trip to rediscover bytes this process already had.
 *
 * `ctx.spillStore.saveText()` is the Host's answer: it writes the complete text under a
 * per-session private directory and returns a path. The model can then `read` a window of
 * it or `grep` it — the same recovery the official `tool-fs-search` uses, copied from
 * `dsh-tool-fs-search/lib/index.js` (`trySaveFormattedResult`) rather than guessed:
 *
 * ```js
 * const sessionId = exec.agent?.session.header.id
 * const spillStore = ctx.get('spillStore')
 * await spillStore.saveText({ owner: { sessionId }, source: { kind: 'tool', toolName, callId, label }, suggestedName, content })
 * // → { locator, bytes, retrievalHint }
 * ```
 *
 * Everything here degrades rather than throws. No session (a programmatic sub-call), no
 * spill store (a preset that composes without one), or a failing write all end in the same
 * place as before this file existed: a truncated result, with a marker that says so. A tool
 * result must not become an error because the *optional* convenience failed.
 */

/** Above this many characters the result is split; below it, inline is already complete. */
export const INLINE_BUDGET = 32 * 1024

/** How much of the head and tail stay inline when a result is spilled. */
export const INLINE_HEAD = 16 * 1024
export const INLINE_TAIL = 4 * 1024

/**
 * Cut `text` into the head and tail that stay inline, plus how much fell between them.
 *
 * Head *and* tail rather than head alone: a compiler error or a stack trace is at the end,
 * and a result that keeps only the first 16 KiB of a build log hides the one line the caller
 * needed. The tail is smaller because the middle of a long log is the least informative part.
 *
 * @param {string} text
 * @returns {{ head: string, tail: string, omitted: number }}
 */
export function splitForSpill(text) {
  const headEnd = Math.min(INLINE_HEAD, text.length)
  const tailStart = Math.max(headEnd, text.length - INLINE_TAIL)
  return { head: text.slice(0, headEnd), tail: text.slice(tailStart), omitted: tailStart - headEnd }
}

/** The per-session owner id, in either shape the Host has shipped. */
function sessionIdOf(exec) {
  const session = exec?.agent?.session
  const id = session?.id ?? session?.header?.id
  return typeof id === 'string' && id !== '' ? id : undefined
}

/**
 * Spill `text` when it is over the inline budget.
 *
 * @param {{
 *   text: string,
 *   exec: object,
 *   toolName: string,
 *   suggestedName: string,
 *   resolveSpillStore?: () => { saveText(input: object): Promise<{ locator: unknown }> } | undefined,
 *   logger?: { warn?: (...parts: unknown[]) => void },
 *   budget?: number
 * }} input
 * @returns {Promise<{ text: string, spillPath: string | null, saved: boolean, totalBytes: number }>}
 */
export async function spillIfOverBudget({
  text,
  exec,
  toolName,
  suggestedName,
  resolveSpillStore,
  logger,
  budget = INLINE_BUDGET
}) {
  const totalBytes = Buffer.byteLength(text, 'utf8')
  if (text.length <= budget) {
    return { text, spillPath: null, saved: false, totalBytes }
  }

  const { head, tail, omitted } = splitForSpill(text)
  const marker = `… ${omitted} of ${text.length} characters omitted`
  /** Note goes *between* head and tail, so the last lines a caller usually needs stay last. */
  const compose = (note) => `${head}\n\n${marker} — ${note}\n\n${tail}`

  const sessionId = sessionIdOf(exec)
  const unsaved = (why) => {
    logger?.warn?.(`at-terminal: ${toolName} result not saved (${why}); returning a truncated result`)
    return {
      text: compose('the complete result could not be saved.'),
      spillPath: null,
      saved: false,
      totalBytes
    }
  }
  if (sessionId === undefined) return unsaved('the call has no session')

  let store
  try {
    store = resolveSpillStore?.()
  } catch {
    store = undefined
  }
  if (store === undefined || store === null) return unsaved('no ctx.spillStore backend is loaded')

  try {
    const saved = await store.saveText({
      owner: { sessionId },
      source: { kind: 'tool', toolName, callId: exec?.callId, label: 'result' },
      suggestedName,
      content: text
    })
    // `locator` is opaque to this bundle: `LocalSpillStore` returns a path, but the contract
    // only promises something the model can name back to the Host.
    const locator = saved?.locator
    const spillPath = typeof locator === 'string' ? locator : locator === undefined ? null : String(locator)
    if (spillPath === null) return unsaved('the spill store returned no locator')
    return {
      text: compose(`complete result: ${spillPath} (read it with offset/limit, or grep it).`),
      spillPath,
      saved: true,
      totalBytes
    }
  } catch (error) {
    return unsaved(`saveText failed: ${String(error?.message ?? error)}`)
  }
}
