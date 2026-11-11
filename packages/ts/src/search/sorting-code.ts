import { importOptionalReads } from '../engine/optional-reads-code'
import { filtersHoldTextRange } from '../filters/text-range'
import type { QueryParams, SortSpec } from '../types/search'
import { lazyCode } from './lazy-code'
import type * as Sorting from './sorting-runtime'

const code = lazyCode('sorting', importOptionalReads)

export function loadSortingFor(sort: SortSpec | undefined, filters?: QueryParams['filters']): Promise<void> | null {
  return sort === undefined && !filtersHoldTextRange(filters) ? null : code.load()
}

export const applySorting: typeof Sorting.applySorting = (...args) => code.get().applySorting(...args)

export const reduceSortValue: typeof Sorting.reduceSortValue = (...args) => code.get().reduceSortValue(...args)
export const reduceStoredSortValue: typeof Sorting.reduceStoredSortValue = (...args) =>
  code.get().reduceStoredSortValue(...args)

export const buildSortOrder: typeof Sorting.buildSortOrder = (...args) => code.get().buildSortOrder(...args)
export const textRange: typeof Sorting.textRange = (...args) => code.get().textRange(...args)
export const sortSelect: typeof Sorting.sortSelect = (...args) => code.get().sortSelect(...args)
export const createSortColumnSet: typeof Sorting.createSortColumnSet = (...args) =>
  code.get().createSortColumnSet(...args)
export const selectTextRange: typeof Sorting.selectTextRange = (...args) => code.get().selectTextRange(...args)
export const selectSortedPage: typeof Sorting.selectSortedPage = (...args) => code.get().selectSortedPage(...args)
export const compositeSortedPage: typeof Sorting.compositeSortedPage = (...args) =>
  code.get().compositeSortedPage(...args)

export const executeSortedQueryPage: typeof Sorting.executeSortedQueryPage = (...args) =>
  code.get().executeSortedQueryPage(...args)

export const sortsWithoutScores: typeof Sorting.sortsWithoutScores = params => code.get().sortsWithoutScores(params)

export const requireSortableFields: typeof Sorting.requireSortableFields = (sort, schema, strict) => {
  if (sort !== undefined) code.get().requireSortableFields(sort, schema, strict)
}
