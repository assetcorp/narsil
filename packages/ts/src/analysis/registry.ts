import { ErrorCodes, NarsilError } from '../errors'
import type { CustomTokenizer, IndexConfig, StopWordOverride } from '../types/schema'

const tokenizers = new Map<string, CustomTokenizer>()
const stopWordSets = new Map<string, StopWordOverride>()

export interface ResolvedAnalysis {
  stopWords?: StopWordOverride
  customTokenizer?: CustomTokenizer
}

function requireName(name: string, kind: string): void {
  if (typeof name !== 'string' || name.trim().length === 0) {
    throw new NarsilError(ErrorCodes.CONFIG_INVALID, `A registered ${kind} needs a non-empty name`, { name })
  }
}

/**
 * Registers a tokeniser under a name that an index config can then reference.
 *
 * An index holds the name rather than the function, because a function
 * survives neither a worker boundary nor a restart. Register the tokeniser on
 * every thread that opens the index, and in the worker bootstrap module when
 * the engine promotes to workers.
 *
 * @param name - The name an index config sets as its `tokenizer`.
 * @param tokenizer - The tokeniser to bind to that name. Registering the same
 * name again replaces what was there.
 *
 * @public
 */
export function registerTokenizer(name: string, tokenizer: CustomTokenizer): void {
  requireName(name, 'tokenizer')
  if (typeof tokenizer?.tokenize !== 'function') {
    throw new NarsilError(ErrorCodes.CONFIG_INVALID, `Tokenizer "${name}" needs a tokenize method`, { tokenizer: name })
  }
  tokenizers.set(name, tokenizer)
}

/**
 * Registers a stop word list under a name that an index config can then
 * reference.
 *
 * An index holds the name rather than the list, so the same list survives a
 * worker boundary and a restart. Register it on every thread that opens the
 * index.
 *
 * @param name - The name an index config sets as its `stopWords`.
 * @param stopWords - Either a fixed set of words, or a function that receives
 * the language defaults and returns the set to use. Registering the same name
 * again replaces what was there.
 *
 * @public
 */
export function registerStopWords(name: string, stopWords: StopWordOverride): void {
  requireName(name, 'stop word set')
  if (!(stopWords instanceof Set) && typeof stopWords !== 'function') {
    throw new NarsilError(
      ErrorCodes.CONFIG_INVALID,
      `Stop word set "${name}" needs a Set of words or a function returning one`,
      { stopWords: name },
    )
  }
  stopWordSets.set(name, stopWords)
}

/**
 * Reports whether a tokeniser is registered under this name, which is how a
 * worker bootstrap checks its own work before an index needs it.
 *
 * @param name - The name to look for.
 * @returns True once {@link registerTokenizer} has bound that name.
 *
 * @public
 */
export function hasTokenizer(name: string): boolean {
  return tokenizers.has(name)
}

/**
 * Reports whether a stop word list is registered under this name.
 *
 * @param name - The name to look for.
 * @returns True once {@link registerStopWords} has bound that name.
 *
 * @public
 */
export function hasStopWords(name: string): boolean {
  return stopWordSets.has(name)
}

/**
 * Returns the tokeniser registered under a name.
 *
 * @param name - The name {@link registerTokenizer} bound.
 * @returns The registered tokeniser.
 * @throws A `NarsilError` with `CONFIG_INVALID` when nothing holds that name.
 *
 * @public
 */
export function getTokenizer(name: string): CustomTokenizer {
  const tokenizer = tokenizers.get(name)
  if (!tokenizer) {
    throw new NarsilError(ErrorCodes.CONFIG_INVALID, `Tokenizer "${name}" is not registered on this engine`, {
      tokenizer: name,
      available: [...tokenizers.keys()],
    })
  }
  return tokenizer
}

/**
 * Returns the stop word list registered under a name.
 *
 * @param name - The name {@link registerStopWords} bound.
 * @returns The registered set, or the function that produces one.
 * @throws A `NarsilError` with `CONFIG_INVALID` when nothing holds that name.
 *
 * @public
 */
export function getStopWords(name: string): StopWordOverride {
  const stopWords = stopWordSets.get(name)
  if (!stopWords) {
    throw new NarsilError(ErrorCodes.CONFIG_INVALID, `Stop word set "${name}" is not registered on this engine`, {
      stopWords: name,
      available: [...stopWordSets.keys()],
    })
  }
  return stopWords
}

export function resolveIndexAnalysis(config: IndexConfig): ResolvedAnalysis {
  return {
    stopWords: typeof config.stopWords === 'string' ? getStopWords(config.stopWords) : config.stopWords,
    customTokenizer: typeof config.tokenizer === 'string' ? getTokenizer(config.tokenizer) : config.tokenizer,
  }
}
