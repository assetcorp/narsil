import { importOptionalReads } from '../../engine/optional-reads-code'
import { lazyCode } from '../../search/lazy-code'
import type { LanguageModule } from '../../types/language'
import type * as FoldingKeys from './keys'
import type * as FoldedPartialWords from './partial-words'
import type * as Folding from './resolve'

const code = lazyCode('folded matching', importOptionalReads)

export type { SpellingFolds } from './keys'

export const spellingFoldsOf: typeof FoldingKeys.spellingFoldsOf = (...args) => code.get().spellingFoldsOf(...args)

export function indexFolds(foldMarks: boolean | undefined, language: LanguageModule): boolean {
  return foldMarks ?? language.folding !== undefined
}

export function loadFoldingFor(folds: boolean): Promise<void> | null {
  return folds ? code.load() : null
}

export function loadFoldingForQuery(
  term: string | undefined,
  exact: boolean | undefined,
  foldMarks: boolean | undefined,
  language: LanguageModule,
): Promise<void> | null {
  if (term === undefined || term.trim().length === 0 || exact === true) return null
  return loadFoldingFor(indexFolds(foldMarks, language))
}

export const resolveFoldedTerms: typeof Folding.resolveFoldedTerms = (...args) => code.get().resolveFoldedTerms(...args)

export const mergeFoldedCompletions: typeof Folding.mergeFoldedCompletions = (...args) =>
  code.get().mergeFoldedCompletions(...args)

export const resolveFoldedPhrases: typeof Folding.resolveFoldedPhrases = (...args) =>
  code.get().resolveFoldedPhrases(...args)

export const expandFoldedPartialWords: typeof FoldedPartialWords.expandFoldedPartialWords = (...args) =>
  code.get().expandFoldedPartialWords(...args)
