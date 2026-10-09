import { describe, expect, it } from 'vitest'
import {
  compareWithBaseline,
  FLOATING_POINT_TOLERANCE,
  parseScoreTable,
  type QualityCheckDefinition,
  type ScoreTable,
} from '../quality-check'

const RECALL: QualityCheckDefinition = {
  check: 'vector-recall',
  title: 'Vector recall',
  subjects: ['scifact', 'nfcorpus'],
  metrics: [
    { key: 'recall10', label: 'Recall@10' },
    { key: 'recall100', label: 'Recall@100' },
  ],
}

const BASELINE: ScoreTable = {
  scifact: { recall10: 0.99, recall100: 0.995 },
  nfcorpus: { recall10: 0.98, recall100: 0.99 },
}

function measuredWith(subject: string, key: string, value: number): ScoreTable {
  return { ...BASELINE, [subject]: { ...BASELINE[subject], [key]: value } }
}

describe('comparing a quality check with its recorded baseline', () => {
  it('passes with one row per subject and metric, in definition order, when every score holds', () => {
    const report = compareWithBaseline(RECALL, BASELINE, BASELINE)

    expect(report).toMatchObject({ check: 'vector-recall', title: 'Vector recall', passed: true })
    expect(report.rows.map(row => `${row.subject} ${row.metric}`)).toEqual([
      'scifact Recall@10',
      'scifact Recall@100',
      'nfcorpus Recall@10',
      'nfcorpus Recall@100',
    ])
  })

  it('passes when a score rises', () => {
    expect(compareWithBaseline(RECALL, measuredWith('nfcorpus', 'recall10', 0.99), BASELINE).passed).toBe(true)
  })

  it('fails the one row whose score drops, however small the drop', () => {
    const report = compareWithBaseline(RECALL, measuredWith('scifact', 'recall100', 0.995 - 1e-6), BASELINE)

    expect(report.passed).toBe(false)
    expect(report.rows.filter(row => !row.passed).map(row => `${row.subject} ${row.metric}`)).toEqual([
      'scifact Recall@100',
    ])
  })

  it('treats a difference inside floating point tolerance as equal', () => {
    const lastBitLower = measuredWith('scifact', 'recall10', 0.99 - FLOATING_POINT_TOLERANCE / 2)

    expect(compareWithBaseline(RECALL, lastBitLower, BASELINE).passed).toBe(true)
  })

  it('refuses a measurement that leaves out a subject', () => {
    expect(() => compareWithBaseline(RECALL, { scifact: BASELINE.scifact }, BASELINE)).toThrow(
      /measured no recall10 for nfcorpus/,
    )
  })
})

describe('reading a recorded baseline', () => {
  it('keeps every score of every subject in the definition', () => {
    expect(parseScoreTable(BASELINE, RECALL, 'baseline')).toEqual(BASELINE)
  })

  it.each([
    ['a missing subject', { scifact: BASELINE.scifact }],
    ['a missing score', { ...BASELINE, nfcorpus: { recall10: 0.98 } }],
    ['a score above 1', { ...BASELINE, scifact: { recall10: 1.5, recall100: 0.995 } }],
    ['a score held as text', { ...BASELINE, scifact: { recall10: '0.99', recall100: 0.995 } }],
    ['a value that is no object', null],
  ])('rejects %s', (_label, raw) => {
    expect(() => parseScoreTable(raw, RECALL, 'vector-recall baseline')).toThrow(/vector-recall baseline/)
  })
})
