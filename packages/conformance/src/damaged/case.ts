import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import * as v from 'valibot'
import { SAMPLES_ROOT } from '../samples/catalog'

export const DAMAGED_ROOT = join(SAMPLES_ROOT, 'damaged')
export const CASES_PATH = join(DAMAGED_ROOT, 'cases.json')

const SamplePath = v.pipe(
  v.string(),
  v.regex(/^[A-Za-z0-9._/-]+$/),
  v.check(path => !path.split('/').includes('..') && !path.startsWith('/')),
)

const RefusedSchema = v.strictObject({ code: v.string() })

const RefusedLineSchema = v.strictObject({
  code: v.string(),
  line: v.pipe(v.number(), v.integer(), v.minValue(2)),
  imported: v.pipe(v.number(), v.integer(), v.minValue(0)),
})

const OpensSchema = v.strictObject({ documents: SamplePath })

const CheckpointCaseSchema = v.strictObject({
  name: v.pipe(v.string(), v.regex(/^[a-z0-9-]+$/)),
  rule: v.string(),
  open: v.literal('checkpoint'),
  index: v.pipe(v.string(), v.regex(/^[a-z0-9-]+$/)),
  base: SamplePath,
  files: v.record(SamplePath, SamplePath),
  remove: v.optional(v.string()),
  search: v.optional(v.string()),
  expect: v.union([RefusedSchema, OpensSchema]),
})

const ArchiveCaseSchema = v.strictObject({
  name: v.pipe(v.string(), v.regex(/^[a-z0-9-]+$/)),
  rule: v.string(),
  open: v.literal('archive'),
  index: v.pipe(v.string(), v.regex(/^[a-z0-9-]+$/)),
  file: SamplePath,
  expect: RefusedSchema,
})

const ExportCaseSchema = v.strictObject({
  name: v.pipe(v.string(), v.regex(/^[a-z0-9-]+$/)),
  rule: v.string(),
  open: v.literal('export'),
  index: v.pipe(v.string(), v.regex(/^[a-z0-9-]+$/)),
  file: SamplePath,
  gzip: v.optional(v.boolean()),
  expect: v.union([RefusedSchema, RefusedLineSchema, OpensSchema]),
})

const CaseSchema = v.variant('open', [CheckpointCaseSchema, ArchiveCaseSchema, ExportCaseSchema])

const CasesSchema = v.strictObject({ cases: v.array(CaseSchema) })

export type DamagedCase = v.InferOutput<typeof CaseSchema>
export type CaseExpectation = DamagedCase['expect']

export async function readCases(): Promise<DamagedCase[]> {
  return v.parse(CasesSchema, JSON.parse(await readFile(CASES_PATH, 'utf8'))).cases
}

export function refusedCode(expectation: CaseExpectation): string | null {
  return 'code' in expectation ? expectation.code : null
}
