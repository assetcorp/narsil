import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { writeJsonAtomicSync, writeTextAtomicSync } from '../runner/atomic-write'
import {
  compareWithBaseline,
  parseScoreTable,
  type QualityCheckDefinition,
  type QualityCheckReport,
  type ScoreTable,
} from './quality-check'
import { measureRankingQuality, RANKING_QUALITY } from './ranking-quality'
import { measureVectorRecall, VECTOR_RECALL } from './vector-recall'

interface QualityCheck {
  definition: QualityCheckDefinition
  measure(subject: string): Promise<Record<string, number>>
}

const QUALITY_CHECKS: readonly QualityCheck[] = [
  { definition: RANKING_QUALITY, measure: measureRankingQuality },
  { definition: VECTOR_RECALL, measure: measureVectorRecall },
]

const BASELINE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), 'baselines')

function baselinePath(definition: QualityCheckDefinition): string {
  return resolve(BASELINE_DIR, `${definition.check}.json`)
}

function findCheck(name: string | undefined): QualityCheck {
  const known = QUALITY_CHECKS.map(check => check.definition.check)
  const found = QUALITY_CHECKS.find(check => check.definition.check === name)
  if (found === undefined) throw new Error(`name one quality check to run: ${known.join(', ')}`)
  return found
}

function printReport(report: QualityCheckReport): void {
  console.log(`\n${report.title}: ${report.passed ? 'passed' : 'FAILED'}`)
  for (const row of report.rows) {
    const verdict = row.passed ? (row.measured > row.baseline ? 'higher' : 'equal') : 'LOWER'
    console.log(
      `  ${row.subject.padEnd(10)} ${row.metric.padEnd(10)} baseline ${row.baseline.toFixed(6)}  measured ${row.measured.toFixed(6)}  ${verdict}`,
    )
  }
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      report: { type: 'string' },
      'update-baseline': { type: 'boolean', default: false },
    },
  })
  const { definition, measure } = findCheck(positionals[0])

  const measured: ScoreTable = {}
  for (const subject of definition.subjects) measured[subject] = await measure(subject)

  if (values['update-baseline']) {
    const baseline = parseScoreTable(measured, definition, `${definition.check} measurement`)
    writeTextAtomicSync(baselinePath(definition), `${JSON.stringify(baseline, null, 2)}\n`)
    console.log(`wrote the ${definition.check} baseline to ${baselinePath(definition)}`)
    return
  }

  if (!existsSync(baselinePath(definition))) {
    const scores = JSON.stringify(parseScoreTable(measured, definition, `${definition.check} measurement`), null, 2)
    console.error(`No ${definition.check} baseline is recorded. Commit these scores as ${baselinePath(definition)}:`)
    console.error(scores)
    process.exitCode = 1
    return
  }

  const raw = JSON.parse(readFileSync(baselinePath(definition), 'utf-8'))
  const baseline = parseScoreTable(raw, definition, `${definition.check} baseline`)
  const report = compareWithBaseline(definition, measured, baseline)
  printReport(report)

  if (values.report !== undefined) {
    const reportPath = resolve(values.report)
    mkdirSync(dirname(reportPath), { recursive: true })
    writeJsonAtomicSync(reportPath, report)
  }

  if (!report.passed) {
    console.error(`\n${report.title} dropped below the recorded baseline.`)
    process.exitCode = 1
    return
  }
  if (report.rows.some(row => row.measured > row.baseline)) {
    console.log(`\n${report.title} rose. Record the new scores with --update-baseline.`)
  }
}

await main()
