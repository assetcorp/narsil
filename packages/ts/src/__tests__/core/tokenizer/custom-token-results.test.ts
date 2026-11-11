import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { registerTokenizer } from '../../../analysis/registry'
import { ErrorCodes } from '../../../errors'
import { createNarsil, type Narsil } from '../../../narsil'

const INDEX = 'notes'
const REFUSED_WORD = 'refused'
const SCHEMA = { title: 'string', body: 'string', tags: 'string[]' } as const

const REFUSED_ENTRIES: ReadonlyArray<readonly [string, (position: number) => Record<string, unknown>]> = [
  ['a token that is a number', position => ({ token: 7, position })],
  ['a negative position', () => ({ token: REFUSED_WORD, position: -1 })],
  ['a fractional position', () => ({ token: REFUSED_WORD, position: 0.5 })],
  ['the position 2^32', () => ({ token: REFUSED_WORD, position: 2 ** 32 })],
  ['a position that is NaN', () => ({ token: REFUSED_WORD, position: Number.NaN })],
]

function registerHostileTokenizer(name: string, refusedEntry: (position: number) => Record<string, unknown>): void {
  registerTokenizer(name, {
    tokenize(text: string) {
      const words = text.split(' ').filter(word => word.length > 0)
      return words.map((word, position) =>
        word === REFUSED_WORD ? refusedEntry(position) : { token: word, position },
      ) as Array<{ token: string; position: number }>
    },
  })
}

const goodDocuments = {
  kept: { title: 'lantern harbour', body: 'kept before the refusal', tags: ['shelf'] },
  later: { title: 'lantern quay', body: 'written after the refusal', tags: ['shelf'] },
}

const refusedDocument = { title: 'lantern orphan', body: `orphan ${REFUSED_WORD}`, tags: ['orphan'] }

async function rankingOf(engine: Narsil, term: string): Promise<Array<[string, number | undefined]>> {
  const result = await engine.query(INDEX, { term })
  return result.hits.map(hit => [hit.id, hit.score])
}

describe.each(REFUSED_ENTRIES)('a custom tokenizer that returns %s', (kind, refusedEntry) => {
  const tokenizer = `hostile-${kind.replaceAll(' ', '-').replaceAll('^', '')}`
  let directory: string
  let referenceDirectory: string
  const engines: Narsil[] = []

  async function open(at: string): Promise<Narsil> {
    const engine = await createNarsil({ workers: { enabled: false }, durability: { directory: at } })
    engines.push(engine)
    return engine
  }

  async function reference(): Promise<Narsil> {
    const engine = await open(referenceDirectory)
    await engine.createIndex(INDEX, { schema: SCHEMA, tokenizer })
    await engine.insert(INDEX, goodDocuments.kept, 'kept')
    await engine.insert(INDEX, goodDocuments.later, 'later')
    return engine
  }

  beforeEach(async () => {
    registerHostileTokenizer(tokenizer, refusedEntry)
    directory = await mkdtemp(join(tmpdir(), 'narsil-token-results-'))
    referenceDirectory = await mkdtemp(join(tmpdir(), 'narsil-token-results-reference-'))
  })

  afterEach(async () => {
    for (const engine of engines.splice(0)) await engine.shutdown().catch(() => undefined)
    await rm(directory, { recursive: true, force: true })
    await rm(referenceDirectory, { recursive: true, force: true })
  })

  it('refuses the document on an insert, an update, and a batch, and stores nothing from it', async () => {
    const engine = await open(directory)
    await engine.createIndex(INDEX, { schema: SCHEMA, tokenizer })
    await engine.insert(INDEX, goodDocuments.kept, 'kept')

    await expect(engine.insert(INDEX, refusedDocument, 'orphan')).rejects.toMatchObject({
      code: ErrorCodes.DOC_VALIDATION_FAILED,
    })
    await expect(engine.update(INDEX, 'kept', refusedDocument)).rejects.toMatchObject({
      code: ErrorCodes.DOC_VALIDATION_FAILED,
    })
    const batch = await engine.insertBatch(INDEX, [
      { id: 'orphan-in-batch', ...refusedDocument },
      { id: 'later', ...goodDocuments.later },
    ])
    expect(batch.succeeded).toEqual(['later'])
    expect(batch.failed.map(failure => [failure.docId, failure.error.code])).toEqual([
      ['orphan-in-batch', ErrorCodes.DOC_VALIDATION_FAILED],
    ])

    const expected = await reference()
    const check = async (subject: Narsil) => {
      expect(await subject.countDocuments(INDEX)).toBe(2)
      expect(await subject.get(INDEX, 'orphan')).toBeUndefined()
      expect(await subject.get(INDEX, 'orphan-in-batch')).toBeUndefined()
      expect(await subject.get(INDEX, 'kept')).toEqual(goodDocuments.kept)
      for (const term of ['lantern', 'orphan', 'harbour', 'shelf']) {
        expect(await rankingOf(subject, term), term).toEqual(await rankingOf(expected, term))
      }
    }
    await check(engine)
    await engine.shutdown()
    await check(await open(directory))
  })

  it('refuses a query whose text the tokenizer answers that way, and answers the next query', async () => {
    const engine = await reference()

    await expect(engine.query(INDEX, { term: `lantern ${REFUSED_WORD}` })).rejects.toMatchObject({
      code: ErrorCodes.CONFIG_INVALID,
    })
    expect((await rankingOf(engine, 'lantern')).map(([id]) => id).sort()).toEqual(['kept', 'later'])
  })
})
