import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ErrorCodes } from '../../../errors'
import { createNarsil, type Narsil } from '../../../narsil'
import type { SchemaDefinition } from '../../../types/schema'

const DIM = 4

const schema: SchemaDefinition = {
  title: 'string',
  embedding: `vector[${DIM}]`,
}

function vec(lead: number, rest = 0): number[] {
  const v = new Array(DIM).fill(rest)
  v[0] = lead
  return v
}

describe('the oversample a vector query names', () => {
  let narsil: Narsil

  beforeEach(async () => {
    narsil = await createNarsil({ workers: { enabled: false } })
    await narsil.createIndex('docs', { schema, language: 'english' })
    await narsil.insert('docs', { title: 'alpha', embedding: vec(0.9, 0.1) })
    await narsil.insert('docs', { title: 'beta', embedding: vec(0.1, 0.9) })
  })

  afterEach(async () => {
    await narsil.shutdown()
  })

  it('accepts a finite number of at least 1 and rejects anything else with CONFIG_INVALID', async () => {
    const accepted = await narsil.query('docs', {
      mode: 'vector',
      vector: { field: 'embedding', value: vec(0.9, 0.1), oversample: 2.5 },
      limit: 1,
    })
    expect(accepted.hits).toHaveLength(1)

    for (const oversample of [0.5, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(
        narsil.query('docs', {
          mode: 'vector',
          vector: { field: 'embedding', value: vec(0.9, 0.1), oversample },
          limit: 1,
        }),
      ).rejects.toMatchObject({ code: ErrorCodes.CONFIG_INVALID })
    }
  })
})
