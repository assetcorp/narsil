import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createNarsil, type Narsil, registerTokenizer } from '../../index'

type Row = { id: string; body: string }

async function verify(engine: Narsil, rows: ReadonlyMap<string, Row>): Promise<void> {
  const shared = await engine.query('terms', { term: 'shared', limit: 1_000 })
  expect(shared.count).toBe(rows.size)
  expect(shared.hits.map(hit => hit.id).sort()).toEqual([...rows.keys()].sort())
  for (const row of rows.values()) {
    const token = row.body.split(' ')[2]
    const exact = await engine.query('terms', { term: token })
    expect(exact.hits.map(hit => hit.id)).toEqual([row.id])
  }
  for (const prefix of ['word0', 'word1', 'replacement', '\u{10000}', '\ue000']) {
    const expected = new Set(
      [...rows.values()].flatMap(row => row.body.split(' ')).filter(word => word.startsWith(prefix)),
    )
    const answer = await engine.suggest('terms', { prefix, limit: 50 })
    const compare = (left: string, right: string): number => {
      const a = Array.from(left, character => character.codePointAt(0) ?? 0)
      const b = Array.from(right, character => character.codePointAt(0) ?? 0)
      for (let at = 0; at < Math.min(a.length, b.length); at++) if (a[at] !== b[at]) return a[at] - b[at]
      return a.length - b.length
    }
    expect(answer.terms.map(entry => entry.term)).toEqual([...expected].sort(compare).slice(0, 50))
  }
}

it('retains exact terms and live frequencies through table growth, removal, ordinal reuse, and recovery', async () => {
  registerTokenizer('stored-term-words', {
    tokenize: text => text.split(' ').map((token, position) => ({ token, position })),
  })
  const directory = await mkdtemp(join(tmpdir(), 'narsil-term-table-'))
  const options = { workers: { enabled: false }, durability: { directory } }
  let engine = await createNarsil(options)
  const rows = new Map<string, Row>()
  try {
    await engine.createIndex('terms', {
      schema: { body: 'string' },
      tokenizer: 'stored-term-words',
      partitions: { maxPartitions: 1 },
    })
    for (let at = 0; at < 400; at++) {
      const words = Array.from({ length: 8 }, (_, column) => `word${String(at * 8 + column).padStart(4, '0')}`)
      const row = { id: `row-${at}`, body: ['shared', 'shared', ...words].join(' ') }
      rows.set(row.id, row)
    }
    rows.set('supplementary', { id: 'supplementary', body: 'shared shared \u{10000}term' })
    rows.set('basic', { id: 'basic', body: 'shared shared \ue000term' })
    expect((await engine.insertBatch('terms', [...rows.values()])).failed).toEqual([])
    await verify(engine, rows)
    for (let at = 0; at < 300; at++) {
      const id = `row-${at}`
      await engine.remove('terms', id)
      rows.delete(id)
    }
    for (let at = 0; at < 300; at++) {
      const row = { id: `row-${at}`, body: `shared shared replacement${String(at).padStart(4, '0')}` }
      await engine.insert('terms', row, row.id)
      rows.set(row.id, row)
    }
    await verify(engine, rows)
    expect((await engine.query('terms', { term: 'word0000' })).count).toBe(0)
    await engine.checkpoint('terms')
    await engine.shutdown()
    engine = await createNarsil(options)
    await verify(engine, rows)
    await engine.update('terms', 'row-0', { body: 'shared shared word0000' })
    rows.set('row-0', { id: 'row-0', body: 'shared shared word0000' })
    await verify(engine, rows)
  } finally {
    await engine.shutdown()
    await rm(directory, { recursive: true, force: true })
  }
}, 60_000)

function editDistance(left: string, right: string): number {
  const a = Array.from(left)
  const b = Array.from(right)
  const matrix = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0))
  for (let row = 0; row <= a.length; row++) matrix[row][0] = row
  for (let column = 0; column <= b.length; column++) matrix[0][column] = column
  for (let row = 1; row <= a.length; row++) {
    for (let column = 1; column <= b.length; column++) {
      matrix[row][column] = Math.min(
        matrix[row - 1][column] + 1,
        matrix[row][column - 1] + 1,
        matrix[row - 1][column - 1] + Number(a[row - 1] !== b[column - 1]),
      )
    }
  }
  return matrix[a.length][b.length]
}

it('keeps Unicode typo matches and document-frequency suggestions equal through frozen removals and recovery', async () => {
  registerTokenizer('literal-term-lookup', {
    tokenize: text =>
      text
        .split(' ')
        .filter(Boolean)
        .map((token, position) => ({ token, position })),
  })
  const directory = await mkdtemp(join(tmpdir(), 'narsil-unicode-terms-'))
  const options = { workers: { enabled: false }, durability: { directory } }
  let engine = await createNarsil(options)
  const words = ['harbor', 'harbour', 'habor', 'harboring', 'harb', '\ufeffharbor', '\u{10000}harbor', '\ue000harbor']
  const rows = new Map<string, { id: string; body: string; word: string }>()
  for (let at = 0; at < words.length; at++) {
    for (let copy = 0; copy <= at % 3; copy++) {
      const id = `term-${at}-${copy}`
      rows.set(id, { id, body: `${words[at]} ${words[at]}`, word: words[at] })
    }
  }
  async function verifyMatches(): Promise<void> {
    const query = '\u{10000}harbr'
    const prefix = Array.from(query)[0]
    const expected = [...rows.values()].filter(row => row.word.startsWith(prefix) && editDistance(query, row.word) <= 1)
    const answer = await engine.query('terms', { term: query, tolerance: 1, prefixLength: 1, limit: 100 })
    expect(answer.hits.map(hit => hit.id).sort()).toEqual(expected.map(row => row.id).sort())
    expect(answer.count).toBe(expected.length)
    const frequencies = new Map<string, number>()
    for (const row of rows.values()) frequencies.set(row.word, (frequencies.get(row.word) ?? 0) + 1)
    const suggested = [...frequencies]
      .filter(([word]) => word.startsWith('ha'))
      .sort((left, right) => right[1] - left[1] || (left[0] < right[0] ? -1 : 1))
    const suggestions = await engine.suggest('terms', { prefix: 'ha', limit: 100 })
    expect(suggestions.terms.map(entry => entry.term)).toEqual(suggested.map(([word]) => word))
  }
  try {
    await engine.createIndex('terms', { schema: { body: 'string', word: 'string' }, tokenizer: 'literal-term-lookup' })
    expect((await engine.insertBatch('terms', [...rows.values()])).failed).toEqual([])
    await verifyMatches()
    await engine.checkpoint('terms')
    await engine.shutdown()
    engine = await createNarsil(options)
    await verifyMatches()
    for (const id of ['term-1-0', 'term-2-0', 'term-2-1', 'term-5-0']) {
      await engine.remove('terms', id)
      rows.delete(id)
    }
    await verifyMatches()
    await engine.shutdown()
    engine = await createNarsil(options)
    await verifyMatches()
  } finally {
    await engine.shutdown()
    await rm(directory, { recursive: true, force: true })
  }
}, 60_000)
