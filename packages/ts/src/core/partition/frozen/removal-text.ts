import type { LanguageModule } from '../../../types/language'
import type { AnyDocument } from '../../../types/schema'
import { storedText } from '../../stored-values/text'
import { transformToken } from '../../tokenizer/cache'
import { resolveStopWords } from '../../tokenizer/tokenize'
import { visitDocumentSurfaceSpellings } from '../partial-words/spellings'
import type { PreparedRemovalSpelling, PreparedText } from '../prepared-text'
import type { PartitionInsertOptions } from '../utils'

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
      const normalized =
        held !== undefined
          ? held.normalized
          : normalize && !stopWords?.has(spelling)
            ? transformToken(spelling, language, false, false)
            : null
      words.set(spelling, { count: (held?.count ?? 0) + 1, normalized })
    }
    if (options?.customTokenizer === undefined) {
      visitDocumentSurfaceSpellings(document, { fields: [field], language, options }, add)
    } else {
      const records = prepared.fields.get(field)?.records
      if (records === undefined) continue
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

export function removedSurfaceSpellings(text: PreparedText): string[] {
  const spellings: string[] = []
  for (const field of text.removalSpellings?.values() ?? [])
    for (const [spelling, value] of field) for (let count = 0; count < value.count; count++) spellings.push(spelling)
  return spellings
}
