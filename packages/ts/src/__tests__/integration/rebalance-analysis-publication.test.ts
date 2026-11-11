import { expect, it } from 'vitest'
import { registerStopWords, registerTokenizer } from '../../analysis/registry'
import { ErrorCodes } from '../../errors'
import { registerLanguage } from '../../languages/registry'
import { createNarsil } from '../../narsil'

it('refuses invalid queued writes before acknowledging them and retains the prior document', async () => {
  let refused = ''
  registerTokenizer('rebalance-refusal', {
    tokenize(text) {
      if (text === refused) throw new Error('The analyser refused the text')
      return text.split(' ').map((token, position) => ({ token, position }))
    },
  })
  const refusals: unknown[] = []
  let split = false
  const engine = await createNarsil({
    workers: { enabled: false },
    plugins: [
      {
        name: 'queued-analysis-refusal',
        async onPartitionSplit() {
          split = true
          refused = 'closed'
          for (const write of [
            () => engine.insert('readings', { title: 'ghost', body: 'closed' }, 'new'),
            () => engine.update('readings', 'retained', { title: 'forest', body: 'closed' }),
          ]) {
            try {
              await write()
            } catch (error) {
              refusals.push(error)
            }
          }
          refused = 'shore'
          try {
            await engine.remove('readings', 'retained')
          } catch (error) {
            refusals.push(error)
          }
          refused = ''
        },
      },
    ],
  })
  try {
    await engine.createIndex('readings', {
      schema: { title: 'string:partial', body: 'string' },
      tokenizer: 'rebalance-refusal',
      partitions: { maxPartitions: 2 },
    })
    await engine.insert('readings', { title: 'river', body: 'shore' }, 'retained')
    await engine.rebalance('readings', 1)
    expect(split).toBe(true)
    expect(refusals).toHaveLength(3)
    for (const error of refusals) expect(error).toMatchObject({ message: 'The analyser refused the text' })
    expect(await engine.get('readings', 'retained')).toEqual({ title: 'river', body: 'shore' })
    expect(await engine.get('readings', 'new')).toBeUndefined()
    expect(await engine.countDocuments('readings')).toBe(1)
    expect((await engine.query('readings', { term: 'river' })).hits.map(hit => hit.id)).toEqual(['retained'])
    expect((await engine.query('readings', { term: 'ghost forest' })).count).toBe(0)
    expect((await engine.query('readings', { term: 'ive', partialWords: true })).count).toBe(1)
  } finally {
    await engine.shutdown()
  }
})

it('prepares queued changes against their latest document and replays without calling the analyser', async () => {
  const calls: string[] = []
  let replaying = false
  registerTokenizer('rebalance-prepared', {
    tokenize(text) {
      if (replaying) throw new Error('The analyser was called during replay')
      calls.push(text)
      return [{ token: text, position: 0 }]
    },
  })
  let admitted: string[] = []
  const observed: Array<{ title: unknown; vector: number[] }> = []
  const engine = await createNarsil({
    workers: { enabled: false },
    plugins: [
      {
        name: 'queued-document-history',
        async onPartitionSplit() {
          calls.length = 0
          await engine.update('readings', 'reading', { title: 'lagoon', embedding: [0, 1] })
          await engine.update('readings', 'reading', { title: 'forest', embedding: [-1, 0] })
          await engine.remove('readings', 'reading')
          await engine.update('readings', 'reading', { title: 'desert', embedding: [0, -1] })
          await engine.remove('readings', 'reading')
          const document = { title: 'mountain', embedding: [1, 1] }
          await engine.insert('readings', document, 'reading')
          document.title = 'changed'
          document.embedding[0] = -1
          admitted = calls.splice(0)
          replaying = true
        },
        async afterUpdate() {
          if (!replaying) return
          const document = await engine.get('readings', 'reading')
          const vector = document?.embedding
          if (!(vector instanceof Float32Array)) throw new Error('A queued document has no vector')
          observed.push({ title: document?.title, vector: Array.from(vector) })
        },
      },
    ],
  })
  try {
    await engine.createIndex('readings', {
      schema: { title: 'string:partial', embedding: 'vector[2]' },
      tokenizer: 'rebalance-prepared',
      partitions: { maxPartitions: 2 },
    })
    await engine.insert('readings', { title: 'river', embedding: [1, 0] }, 'reading')
    await engine.rebalance('readings', 1)
    expect(admitted).toEqual(['river', 'lagoon', 'forest', 'desert', 'mountain'])
    expect(calls).toEqual([])
    expect(observed).toEqual([
      { title: 'lagoon', vector: [0, 1] },
      { title: 'forest', vector: [-1, 0] },
      { title: 'desert', vector: [0, -1] },
    ])
    replaying = false
    expect(await engine.countDocuments('readings')).toBe(1)
    expect((await engine.get('readings', 'reading'))?.title).toBe('mountain')
    expect((await engine.query('readings', { term: 'mountain' })).count).toBe(1)
    for (const term of ['river', 'lagoon', 'forest', 'desert', 'changed']) {
      expect((await engine.query('readings', { term })).count).toBe(0)
    }
    const ranked = await engine.query<{ embedding: Float32Array }>('readings', {
      vector: { field: 'embedding', value: [1, 0] },
    })
    expect(ranked.hits).toHaveLength(1)
    expect(Array.from(ranked.hits[0].document?.embedding ?? [])).toEqual([1, 1])
    expect(ranked.hits[0].score).toBeCloseTo(1 / Math.sqrt(2), 6)
    expect(engine.getStats('readings').heldSearchStates).toBe(0)
  } finally {
    await engine.shutdown()
  }
})

it('rejects replay and waiting writes when a queued removal loses its document', async () => {
  let waiting: Promise<unknown> | undefined
  const engine = await createNarsil({
    workers: { enabled: false },
    plugins: [
      {
        name: 'clear-before-queued-removal',
        async onPartitionSplit() {
          await engine.remove('readings', 'reading')
          await engine.insert('readings', { title: 'later' }, 'later')
          waiting = engine.update('readings', 'later', { title: 'waiting' }, { wait: true }).then(
            () => 'acknowledged',
            error => error,
          )
          await engine.clear('readings')
        },
      },
    ],
  })
  try {
    await engine.createIndex('readings', {
      schema: { title: 'string' },
      partitions: { maxPartitions: 2 },
    })
    await engine.insert('readings', { title: 'river' }, 'reading')
    await expect(engine.rebalance('readings', 1)).rejects.toMatchObject({ code: ErrorCodes.DOC_NOT_FOUND })
    expect(waiting).toBeDefined()
    expect(await waiting).toMatchObject({ code: ErrorCodes.DOC_NOT_FOUND })
    expect(await engine.get('readings', 'later')).toBeUndefined()
    expect(await engine.countDocuments('readings')).toBe(0)
    await expect(engine.insert('readings', { title: 'refused' }, 'next')).rejects.toMatchObject({
      code: ErrorCodes.DOC_NOT_FOUND,
    })
    await expect(engine.rebalance('readings', 2)).rejects.toMatchObject({
      code: ErrorCodes.PARTITION_REBALANCING_BACKPRESSURE,
    })
    expect(engine.getStats('readings').heldSearchStates).toBe(0)
  } finally {
    await engine.shutdown()
  }
})

it('retains queued array tokens when later analysis replaces its output buffers', async () => {
  let replaying = false
  registerStopWords('queued-native-text', defaults => {
    if (replaying) throw new Error('The analyser was called during replay')
    return defaults
  })
  const engine = await createNarsil({
    workers: { enabled: false },
    plugins: [
      {
        name: 'queued-token-storage',
        async onPartitionSplit() {
          await engine.update('readings', 'river', { title: ['flowing rivers', 'green forests'] })
          await engine.insert('readings', { title: ['mountains '.repeat(4_000)] }, 'mountain')
          await engine.insert('readings', { title: ['quiet lakes'] }, 'lake')
          replaying = true
        },
      },
    ],
  })
  try {
    await engine.createIndex('readings', {
      schema: { title: 'string[]' },
      stopWords: 'queued-native-text',
      partitions: { maxPartitions: 2 },
    })
    await engine.insert('readings', { title: ['old shore'] }, 'river')
    await engine.rebalance('readings', 1)
    replaying = false
    expect(await engine.countDocuments('readings')).toBe(3)
    for (const [term, id] of [
      ['river', 'river'],
      ['forest', 'river'],
      ['mountain', 'mountain'],
      ['lake', 'lake'],
    ]) {
      expect((await engine.query('readings', { term })).hits.map(hit => hit.id)).toEqual([id])
    }
    expect((await engine.query('readings', { term: 'shore' })).count).toBe(0)
    const mountain = await engine.query('readings', { term: 'mountain' })
    const expected = (Math.log(8 / 3) * 4_000 * 2.2) / (4_000 + 1.2 * (0.25 + (0.75 * 4_000) / (4_006 / 3)))
    expect(mountain.hits[0].score).toBeCloseTo(expected, 10)
    expect((await engine.query('readings', { term: '"flowing rivers"' })).hits.map(hit => hit.id)).toEqual(['river'])
    expect((await engine.query('readings', { term: '"rivers green"' })).count).toBe(0)
  } finally {
    await engine.shutdown()
  }
})

it.each([
  'normalizer',
  'stemmer',
  'stopWords',
] as const)('retains prepared queued text when the %s becomes unavailable after admission', async callback => {
  let replaying = false
  const registered = `queued-${callback}`
  const check = (): void => {
    if (replaying) throw new Error('The analyser was called during replay')
  }
  const transform = (text: string): string => {
    check()
    return text
  }
  registerLanguage({
    name: registered,
    revision: '1',
    stopWords: new Set(),
    normalizer: callback === 'normalizer' ? transform : undefined,
    stemmer: callback === 'stemmer' ? transform : null,
  })
  registerStopWords(registered, defaults => {
    check()
    return defaults
  })
  let admitted = false
  const engine = await createNarsil({
    workers: { enabled: false },
    plugins: [
      {
        name: 'prepared-analysis-callbacks',
        async onPartitionSplit() {
          await engine.update('readings', 'reading', { title: '' })
          await engine.update('readings', 'reading', {})
          await engine.remove('readings', 'reading')
          await engine.insert('readings', { title: 'shore' }, 'reading')
          replaying = true
          admitted = true
        },
      },
    ],
  })
  try {
    await engine.createIndex('readings', {
      schema: { title: 'string' },
      language: registered,
      stopWords: callback === 'stopWords' ? registered : undefined,
      partitions: { maxPartitions: 2 },
    })
    await engine.insert('readings', { title: 'river' }, 'reading')
    await engine.rebalance('readings', 1)
    expect(admitted).toBe(true)
    expect(await engine.get('readings', 'reading')).toEqual({ title: 'shore' })
    replaying = false
    expect((await engine.query('readings', { term: 'shore' })).count).toBe(1)
    expect((await engine.query('readings', { term: 'river' })).count).toBe(0)
    expect(await engine.countDocuments('readings')).toBe(1)
  } finally {
    await engine.shutdown()
  }
})
