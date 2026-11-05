import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import * as v from 'valibot'
import type { Json, JsonObject } from '../forms/json'
import { SAMPLE_KINDS } from '../forms/kinds'
import { PACKAGE_ROOT } from '../package-root'

export const SAMPLES_ROOT = join(PACKAGE_ROOT, 'samples')
export const CATALOG_PATH = join(SAMPLES_ROOT, 'samples.json')
const INDENT = '  '

const SampleEntrySchema = v.strictObject({
  name: v.pipe(v.string(), v.regex(/^[a-z0-9-]+\/[a-z0-9-]+$/)),
  kind: v.picklist(SAMPLE_KINDS),
  file: v.pipe(
    v.string(),
    v.regex(/^[A-Za-z0-9._/-]+$/),
    v.check(path => !path.split('/').includes('..')),
  ),
  storage: v.optional(v.picklist(['memory', 'disk'])),
  expected: v.pipe(v.string(), v.regex(/^expected\/[a-z0-9-]+\/[a-z0-9-]+\.json$/)),
})

const CatalogSchema = v.strictObject({
  samples: v.array(SampleEntrySchema),
})

export type SampleEntry = v.InferOutput<typeof SampleEntrySchema>

export async function readCatalog(): Promise<SampleEntry[]> {
  return v.parse(CatalogSchema, JSON.parse(await readFile(CATALOG_PATH, 'utf8'))).samples
}

export async function readExpected(entry: SampleEntry): Promise<JsonObject> {
  const value: Json = JSON.parse(await readFile(join(SAMPLES_ROOT, entry.expected), 'utf8'))
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${entry.expected} does not hold a JSON object`)
  }
  return value
}

export async function readSampleBytes(entry: SampleEntry): Promise<Uint8Array> {
  return new Uint8Array(await readFile(join(SAMPLES_ROOT, entry.file)))
}

function numberText(value: number): string {
  return Object.is(value, -0) ? '-0' : JSON.stringify(value)
}

function isScalar(value: Json): boolean {
  return value === null || typeof value !== 'object'
}

function textOf(value: Json, depth: number): string {
  if (typeof value === 'number') return numberText(value)
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  const inner = INDENT.repeat(depth + 1)
  const outer = INDENT.repeat(depth)
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]'
    if (value.every(isScalar)) return `[${value.map(item => textOf(item, depth)).join(', ')}]`
    return `[\n${value.map(item => `${inner}${textOf(item, depth + 1)}`).join(',\n')}\n${outer}]`
  }
  const entries = Object.entries(value)
  if (entries.length === 0) return '{}'
  return `{\n${entries.map(([key, item]) => `${inner}${JSON.stringify(key)}: ${textOf(item, depth + 1)}`).join(',\n')}\n${outer}}`
}

export function jsonText(value: Json): string {
  return `${textOf(value, 0)}\n`
}
