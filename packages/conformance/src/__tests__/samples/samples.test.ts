import { describe, expect, it } from 'vitest'
import { formDifference, formOf } from '../../forms/kinds'
import { independentContext } from '../../independent/context'
import { referenceForm } from '../../reference/read'
import { writeSample } from '../../reference/write'
import { readCatalog, readExpected, readSampleBytes, type SampleEntry } from '../../samples/catalog'

const catalog = await readCatalog()

function requestOf(entry: SampleEntry, bytes: Uint8Array) {
  return { kind: entry.kind, bytes, what: entry.name, storage: entry.storage }
}

describe('every sample file', () => {
  it('lists a sample of every kind', () => {
    expect(new Set(catalog.map(entry => entry.kind)).size).toBe(12)
  })

  it.each(
    catalog.map(entry => [entry.name, entry] as const),
  )('%s decodes through the independent reader to its expected JSON', async (_name, entry) => {
    const actual = await formOf(requestOf(entry, await readSampleBytes(entry)), independentContext)
    expect(formDifference(entry.kind, await readExpected(entry), actual)).toBeNull()
  })

  it.each(
    catalog.map(entry => [entry.name, entry] as const),
  )('%s opens through the reference reader to its expected JSON', async (_name, entry) => {
    const actual = await referenceForm(requestOf(entry, await readSampleBytes(entry)))
    expect(formDifference(entry.kind, await readExpected(entry), actual)).toBeNull()
  })

  it.each(
    catalog.map(entry => [entry.name, entry] as const),
  )('%s reads back unchanged after the reference writes it from its JSON', async (_name, entry) => {
    const expected = await readExpected(entry)
    const written = await writeSample(entry.kind, expected, entry.name)
    const independent = await formOf(requestOf(entry, written), independentContext)
    expect(formDifference(entry.kind, expected, independent)).toBeNull()
    const reference = await referenceForm(requestOf(entry, written))
    expect(formDifference(entry.kind, expected, reference)).toBeNull()
  })
})
