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

export function registerTokenizer(name: string, tokenizer: CustomTokenizer): void {
  requireName(name, 'tokenizer')
  if (typeof tokenizer?.tokenize !== 'function') {
    throw new NarsilError(ErrorCodes.CONFIG_INVALID, `Tokenizer "${name}" needs a tokenize method`, { tokenizer: name })
  }
  tokenizers.set(name, tokenizer)
}

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

export function hasTokenizer(name: string): boolean {
  return tokenizers.has(name)
}

export function hasStopWords(name: string): boolean {
  return stopWordSets.has(name)
}

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
