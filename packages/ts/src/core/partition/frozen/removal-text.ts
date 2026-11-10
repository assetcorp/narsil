import type { LanguageModule } from '../../../types/language'
import type { AnyDocument } from '../../../types/schema'
import { packedTokens } from '../../segment-writes/prepared-tokens'
import { storedText } from '../../stored-values/text'
import { transformToken } from '../../tokenizer/cache'
import { resolveStopWords } from '../../tokenizer/tokenize'
import { visitDocumentSurfaceSpellings } from '../partial-words/spellings'
import type { PreparedRemovalSpelling, PreparedText } from '../prepared-text'
import type { PartitionInsertOptions } from '../utils'
import {
  addDistinctRemovedSpellings,
  beginRemovedSpellings,
  finishRemovedSpellings,
  type RemovedSpellings,
} from './removed-spellings'

export function prepareRemovalText(
  prepared: PreparedText,
  document: AnyDocument,
  fields: readonly string[],
  language: LanguageModule,
  options: PartitionInsertOptions | undefined,
): PreparedText {
  if (prepared.removalSpellings !== undefined) return prepared
  const removalSpellings = new Map<string, Map<string, PreparedRemovalSpelling>>()
  const normalize =
    options?.customTokenizer === undefined &&
    language.normalizer !== undefined &&
    language.tokenizer?.normalizeDiacritics !== true
  const stopWords = normalize ? resolveStopWords(language, options?.stopWordOverride) : null
  for (const field of fields) {
    const words = new Map<string, PreparedRemovalSpelling>()
    removalSpellings.set(field, words)
    const add = (spelling: string): void => {
      const held = words.get(spelling)
      if (held !== undefined) {
        held.count++
        return
      }
      const normalized =
        normalize && !stopWords?.has(spelling) ? transformToken(spelling, language, false, false) : null
      words.set(spelling, { count: 1, normalized })
    }
    if (options?.customTokenizer === undefined) {
      visitDocumentSurfaceSpellings(document, { fields: [field], language, options }, add)
    } else {
      const held = prepared.fields.get(field)?.records
      if (held === undefined) continue
      const records = packedTokens(held)
      for (let at = 0; at < records.tokens.length; at += 8) {
        const shown = records.tokens[at + 3]
        add(
          shown === 0xffffffff
            ? storedText(records.units, records.tokens[at + 1], records.tokens[at + 2])
            : storedText(records.units, shown, records.tokens[at + 4]),
        )
      }
    }
  }
  return { ...prepared, removalSpellings }
}

export function removedSurfaceSpellings(text: PreparedText | undefined): RemovedSpellings {
  beginRemovedSpellings()
  for (const field of text?.removalSpellings?.values() ?? []) addDistinctRemovedSpellings(field)
  return finishRemovedSpellings()
}
