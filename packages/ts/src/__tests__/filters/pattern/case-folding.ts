import { readFileSync } from 'node:fs'

const CASE_FOLDING_FILE = new URL('../../../../scripts/data/CaseFolding.txt', import.meta.url)
const FULL_FOLD_STATUSES = new Set(['C', 'F'])

function readFoldTable(): Map<number, number[]> {
  const table = new Map<number, number[]>()
  for (const line of readFileSync(CASE_FOLDING_FILE, 'utf8').split('\n')) {
    const [code, status, mapping] = line.split(';').map(part => part.trim())
    if (!FULL_FOLD_STATUSES.has(status)) continue
    table.set(
      Number.parseInt(code, 16),
      mapping.split(' ').map(hex => Number.parseInt(hex, 16)),
    )
  }
  return table
}

export const UNICODE_FOLDS = readFoldTable()

export function codePointsOf(text: string, caseFold: boolean): number[] {
  const codePoints: number[] = []
  for (const character of text) {
    const codePoint = character.codePointAt(0) ?? 0
    if (caseFold) codePoints.push(...(UNICODE_FOLDS.get(codePoint) ?? [codePoint]))
    else codePoints.push(codePoint)
  }
  return codePoints
}
