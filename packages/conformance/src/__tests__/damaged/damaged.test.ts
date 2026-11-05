import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { type DamagedCase, readCases } from '../../damaged/case'
import { openCase } from '../../damaged/open'
import { contentDifference, type Json } from '../../forms/json'
import { SAMPLES_ROOT } from '../../samples/catalog'

const cases = await readCases()
const refusing = cases.filter(entry => 'code' in entry.expect)
const opening = cases.filter(entry => 'documents' in entry.expect)

function named(entries: DamagedCase[]) {
  return entries.map(entry => [entry.name, entry] as const)
}

describe('damaged files', () => {
  it.each(named(refusing))('%s raises its code and loads none of its content', async (_name, entry) => {
    const outcome = await openCase(entry)
    const wanted = entry.expect
    if ('line' in wanted) {
      expect(outcome).toEqual({
        imported: wanted.imported,
        refusedLines: [{ line: wanted.line, code: wanted.code }],
      })
      return
    }
    if (!('code' in wanted)) throw new Error(`${entry.name} names no code`)
    expect(outcome).toEqual({ refused: wanted.code })
  })

  it.each(named(opening))('%s opens with every document of its checkpoint', async (_name, entry) => {
    if (!('documents' in entry.expect)) throw new Error(`${entry.name} names no documents`)
    const expected: Json = JSON.parse(await readFile(join(SAMPLES_ROOT, entry.expect.documents), 'utf8'))
    const outcome = await openCase(entry)
    if (!('documents' in outcome)) throw new Error(`${entry.name} gave ${JSON.stringify(outcome)}`)
    expect(contentDifference(expected, outcome.documents, '', { signedZero: true })).toBeNull()
  })
})
