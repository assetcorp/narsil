import type { PatternHost } from '../core/pattern-index/types'

const NO_SOURCES: readonly number[] = []

const sourcesByTable = new WeakMap<ReadonlyMap<number, number>, Map<number, number[]>>()

function sourcesByFold(table: ReadonlyMap<number, number>): Map<number, number[]> {
  const known = sourcesByTable.get(table)
  if (known !== undefined) return known
  const sources = new Map<number, number[]>()
  for (const [source, folded] of table) {
    const listed = sources.get(folded)
    if (listed === undefined) sources.set(folded, [source])
    else listed.push(source)
  }
  sourcesByTable.set(table, sources)
  return sources
}

export function singleFoldSourcesOf(host: PatternHost): (folded: number) => readonly number[] {
  const sources = sourcesByFold(host.singleFolds())
  return folded => sources.get(folded) ?? NO_SOURCES
}
