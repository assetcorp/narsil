import { decode, encode } from '@msgpack/msgpack'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { registerStopWords, registerTokenizer } from '../../analysis/registry'
import { ErrorCodes, NarsilError } from '../../errors'
import { createNarsil, type Narsil } from '../../narsil'
import type { CustomTokenizer } from '../../types/schema'

const schema = { title: 'string' as const }

const perLetter: CustomTokenizer = {
  tokenize(text: string) {
    return [...text.replace(/\s+/g, '')].map((token, position) => ({ token, position }))
  },
}

describe('snapshot and restore of index analysis', () => {
  let narsil: Narsil

  beforeEach(async () => {
    narsil = await createNarsil()
  })

  afterEach(async () => {
    await narsil.shutdown()
  })

  it('restores an index onto the tokenizer its snapshot names', async () => {
    registerTokenizer('snapshot-letters', perLetter)

    await narsil.createIndex('prose', { schema, tokenizer: 'snapshot-letters' })
    await narsil.insert('prose', { title: 'machine' })
    const data = await narsil.snapshot('prose')
    await narsil.dropIndex('prose')

    await narsil.restore('prose', data)

    expect((await narsil.query('prose', { term: 'm' })).hits).toHaveLength(1)
    await narsil.insert('prose', { title: 'engine' })
    expect((await narsil.query('prose', { term: 'g' })).hits).toHaveLength(1)
    expect((await narsil.query('prose', { term: 'n' })).hits).toHaveLength(2)
  })

  it('restores an index onto the stop word set its snapshot names', async () => {
    registerStopWords('snapshot-keeps-everything', new Set<string>())

    await narsil.createIndex('prose', { schema, stopWords: 'snapshot-keeps-everything' })
    await narsil.insert('prose', { title: 'the rise of the machine' })
    const data = await narsil.snapshot('prose')
    await narsil.dropIndex('prose')

    await narsil.restore('prose', data)

    expect((await narsil.query('prose', { term: 'the' })).hits).toHaveLength(1)
  })

  it('refuses to snapshot an index whose tokenizer is an instance', async () => {
    await narsil.createIndex('prose', { schema, tokenizer: perLetter })
    await expect(narsil.snapshot('prose')).rejects.toMatchObject({
      code: ErrorCodes.CONFIG_INVALID,
      message: expect.stringContaining('registerTokenizer'),
    })
  })

  it('refuses to snapshot an index whose stop words are a function', async () => {
    await narsil.createIndex('prose', { schema, stopWords: defaults => defaults })
    await expect(narsil.snapshot('prose')).rejects.toMatchObject({
      code: ErrorCodes.CONFIG_INVALID,
      message: expect.stringContaining('registerStopWords'),
    })
  })

  it('refuses a snapshot naming an unregistered tokenizer and keeps the existing index intact', async () => {
    await narsil.createIndex('prose', { schema })
    await narsil.insert('prose', { title: 'survivor' })
    const data = await narsil.snapshot('prose')

    const envelope = decode(data) as Record<string, unknown>
    const renamed = encode({ ...envelope, tokenizer: 'nobody-registered-this-snapshot' })

    await expect(narsil.restore('prose', renamed)).rejects.toMatchObject({
      code: ErrorCodes.CONFIG_INVALID,
      message: expect.stringContaining('nobody-registered-this-snapshot'),
    })
    expect((await narsil.query('prose', { term: 'survivor' })).hits).toHaveLength(1)
  })

  it('rejects a snapshot whose analysis name is not a string', async () => {
    await narsil.createIndex('prose', { schema })
    const data = await narsil.snapshot('prose')
    const envelope = decode(data) as Record<string, unknown>

    await expect(narsil.restore('prose', encode({ ...envelope, tokenizer: 42 }))).rejects.toBeInstanceOf(NarsilError)
    await expect(narsil.restore('prose', encode({ ...envelope, stopWords: ['a'] }))).rejects.toBeInstanceOf(NarsilError)
  })

  it('restores a snapshot written before the analysis fields existed', async () => {
    await narsil.createIndex('prose', { schema })
    await narsil.insert('prose', { title: 'machine learning' })
    const data = await narsil.snapshot('prose')
    const envelope = decode(data) as Record<string, unknown>
    expect(envelope.tokenizer).toBeUndefined()
    expect(envelope.stopWords).toBeUndefined()
    await narsil.dropIndex('prose')

    await narsil.restore('prose', data)
    expect((await narsil.query('prose', { term: 'machine' })).hits).toHaveLength(1)
  })
})
