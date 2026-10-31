import { cp, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { expect } from 'vitest'
import type { Narsil } from '../../../narsil'
import type { AnyDocument } from '../../../types/schema'

export const RELEASE_0_3_FIXTURE = new URL('../../persistence/fixtures/0.3.0/', import.meta.url)

export async function copyReleaseFixture(
  part: 'wal' | 'snapshot-tier' | 'snapshot-tier-numeric-ids',
  destination: string,
): Promise<void> {
  await cp(fileURLToPath(new URL(`${part}/`, RELEASE_0_3_FIXTURE)), destination, { recursive: true })
}

export async function expectedFixtureDocuments(file: string): Promise<Record<string, AnyDocument>> {
  return JSON.parse(await readFile(new URL(file, RELEASE_0_3_FIXTURE), 'utf8')) as Record<string, AnyDocument>
}

function unsignedZero(value: number): number {
  return value === 0 ? 0 : value
}

function plainVector(value: unknown): number[] {
  if (value instanceof Float32Array) return Array.from(value)
  if (Array.isArray(value)) return value.map(Number)
  throw new Error('the document holds no vector')
}

export async function expectFixtureDocuments(
  engine: Narsil,
  indexName: string,
  expected: Record<string, AnyDocument>,
  vectorField: string | null,
): Promise<void> {
  expect(await engine.countDocuments(indexName)).toBe(Object.keys(expected).length)
  for (const [id, document] of Object.entries(expected)) {
    const stored = await engine.get(indexName, id)
    expect(stored, id).toBeDefined()
    if (stored?.id !== undefined) expect(stored.id).toBe(id)
    if (vectorField === null) {
      expect({ ...stored, id: undefined }).toEqual({ ...document, id: undefined })
      continue
    }
    expect({ ...stored, id: undefined, [vectorField]: undefined }).toEqual({
      ...document,
      id: undefined,
      [vectorField]: undefined,
    })
    expect(plainVector(stored?.[vectorField]).map(unsignedZero)).toEqual(
      plainVector(document[vectorField]).map(Math.fround).map(unsignedZero),
    )
  }
}
