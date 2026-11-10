import type { TokenizedTextSource } from '../core/tokenizer/tokenize'
import type { CustomTokenizer } from '../types/schema'
import { MAX_TOKEN_POSITION } from './constants'
import { ErrorCodes, NarsilError, withUnpairedSurrogatesReplaced } from './custom-token-host'

export { bindCustomTokenHost } from './custom-token-host'

function refuseTokenizerResult(source: TokenizedTextSource, message: string, details: Record<string, unknown>): never {
  const code = source === 'document' ? ErrorCodes.DOC_VALIDATION_FAILED : ErrorCodes.CONFIG_INVALID
  throw new NarsilError(code, `The custom tokenizer ${message}`, details)
}

function kindOf(value: unknown): string {
  if (value === null) return 'null'
  return Array.isArray(value) ? 'array' : typeof value
}

function checkedTokenizerEntry(
  entry: unknown,
  at: number,
  source: TokenizedTextSource,
): { token: string; position: number } {
  const { token, position } = (entry !== null && typeof entry === 'object' ? entry : {}) as Record<string, unknown>
  if (typeof token !== 'string') {
    refuseTokenizerResult(
      source,
      `returned a token of type ${kindOf(token)} at entry ${at}, where a token is a string`,
      { entry: at, tokenType: kindOf(token) },
    )
  }
  if (typeof position !== 'number' || !Number.isInteger(position) || position < 0 || position > MAX_TOKEN_POSITION) {
    const shown = typeof position === 'number' ? String(position) : kindOf(position)
    refuseTokenizerResult(
      source,
      `returned the position ${shown} at entry ${at}, where a position is a whole number from 0 to ${MAX_TOKEN_POSITION}`,
      { entry: at, position: shown },
    )
  }
  return { token: withUnpairedSurrogatesReplaced(token), position }
}

function holdsPositionsOutOfOrder(entries: ReadonlyArray<{ position: number }>): boolean {
  for (let index = 1; index < entries.length; index++) {
    if (entries[index].position < entries[index - 1].position) return true
  }
  return false
}

export function customTokensOf(
  tokenizer: CustomTokenizer,
  text: string,
  source: TokenizedTextSource,
): Array<{ token: string; position: number }> {
  const entries: unknown = tokenizer.tokenize(text)
  if (!Array.isArray(entries)) {
    refuseTokenizerResult(source, `returned ${kindOf(entries)}, where it returns a list of tokens`, {
      received: kindOf(entries),
    })
  }
  const checked = new Array<{ token: string; position: number }>(entries.length)
  for (let at = 0; at < checked.length; at++) checked[at] = checkedTokenizerEntry(entries[at], at, source)
  if (!holdsPositionsOutOfOrder(checked)) return checked
  return checked.sort((first, second) => first.position - second.position)
}
