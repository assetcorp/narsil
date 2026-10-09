export const FLOATING_POINT_TOLERANCE = 1e-9

export interface QualityMetric {
  key: string
  label: string
}

export interface QualityCheckDefinition {
  check: string
  title: string
  subjects: readonly string[]
  metrics: readonly QualityMetric[]
}

export type ScoreTable = Record<string, Record<string, number>>

export interface QualityCheckRow {
  subject: string
  metric: string
  baseline: number
  measured: number
  passed: boolean
}

export interface QualityCheckReport {
  check: string
  title: string
  passed: boolean
  rows: QualityCheckRow[]
}

function isScore(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
}

export function parseScoreTable(raw: unknown, definition: QualityCheckDefinition, source: string): ScoreTable {
  if (typeof raw !== 'object' || raw === null) throw new Error(`the ${source} is not a JSON object`)
  const table: ScoreTable = {}
  for (const subject of definition.subjects) {
    const entry = (raw as Record<string, unknown>)[subject]
    if (typeof entry !== 'object' || entry === null) throw new Error(`the ${source} records no scores for ${subject}`)
    const scores: Record<string, number> = {}
    for (const { key } of definition.metrics) {
      const value = (entry as Record<string, unknown>)[key]
      if (!isScore(value)) throw new Error(`the ${source} holds no score between 0 and 1 for ${subject} ${key}`)
      scores[key] = value
    }
    table[subject] = scores
  }
  return table
}

export function compareWithBaseline(
  definition: QualityCheckDefinition,
  measured: ScoreTable,
  baseline: ScoreTable,
): QualityCheckReport {
  const rows: QualityCheckRow[] = []
  for (const subject of definition.subjects) {
    for (const { key, label } of definition.metrics) {
      const recorded = baseline[subject]?.[key]
      const score = measured[subject]?.[key]
      if (recorded === undefined) throw new Error(`the baseline records no ${key} for ${subject}`)
      if (score === undefined) throw new Error(`the ${definition.check} check measured no ${key} for ${subject}`)
      rows.push({
        subject,
        metric: label,
        baseline: recorded,
        measured: score,
        passed: score >= recorded - FLOATING_POINT_TOLERANCE,
      })
    }
  }
  return { check: definition.check, title: definition.title, passed: rows.every(row => row.passed), rows }
}
