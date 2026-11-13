import { statfsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { type NodeChildOutcome, resultLineOf, runNodeChild } from './node-child'

const FILE_BACKED_PROCESS = fileURLToPath(new URL('./file-backed-process.mjs', import.meta.url))
const MEBIBYTE_BYTES = 1024 * 1024
const DOCUMENTS = 16_384
const DIMENSION = 4096
const FLOAT32_BYTES = 4
const MAPPED_VECTOR_BYTES = DOCUMENTS * DIMENSION * FLOAT32_BYTES
const ANONYMOUS_MARGIN_BYTES = 96 * MEBIBYTE_BYTES
const WRITES_BESIDE_MAPPED_VECTORS = 10
const HEAP_MEGABYTES = 65_536
const SEMI_SPACE_MEGABYTES = 16
const TEST_TIMEOUT_MS = 300_000
const MEMORY_WRITE_BLOCKED = 'MEMORY_WRITE_BLOCKED'
const TMPFS_MAGIC = 0x01021994
const RAMFS_MAGIC = 0x858458f6
const DISK_TEMPORARY_DIRECTORY = '/var/tmp'

function diskBackedTemporaryDirectory(): string {
  for (const candidate of [tmpdir(), DISK_TEMPORARY_DIRECTORY]) {
    const { type } = statfsSync(candidate)
    if (type !== TMPFS_MAGIC && type !== RAMFS_MAGIC) return candidate
  }
  throw new Error(`Neither ${tmpdir()} nor ${DISK_TEMPORARY_DIRECTORY} is on a disk, so no file can back the vectors`)
}

interface WriteOutcome {
  accepted: boolean
  code?: string | null
  reason?: string | null
  message?: string
}

interface FileBackedResult {
  nearest: string | null
  fileBytes: number
  unbackedBytesBefore: number
  unbackedBytesDuring: number
  unbackedBytesAfter: number
  grownBytes: number
  limitBytes: number
  blockWritesAbove: number
  besideMappedVectors: WriteOutcome[]
  afterAnonymousGrowth: WriteOutcome
}

function runFileBackedProcess(args: string[]): Promise<NodeChildOutcome> {
  return runNodeChild([
    `--max-old-space-size=${HEAP_MEGABYTES}`,
    `--max-semi-space-size=${SEMI_SPACE_MEGABYTES}`,
    FILE_BACKED_PROCESS,
    ...args,
  ])
}

it.skipIf(process.platform !== 'linux')(
  'accepts writes beside vector files mapped from disk and refuses them once anonymous memory passes the block level',
  async () => {
    const directory = await mkdtemp(join(diskBackedTemporaryDirectory(), 'narsil-file-backed-'))
    try {
      const sizing = [String(DOCUMENTS), String(DIMENSION), String(ANONYMOUS_MARGIN_BYTES)]
      const built = await runFileBackedProcess(['build', directory, ...sizing])
      expect(built.exitCode, built.output).toBe(0)

      const { exitCode, output } = await runFileBackedProcess(['write', directory, ...sizing])
      expect(exitCode, output).toBe(0)
      const line = resultLineOf(output)
      expect(line, output).toBeDefined()
      const result = JSON.parse(line ?? 'null') as FileBackedResult

      expect(result.nearest).toBe(`passage-${DOCUMENTS - 1}`)
      expect(result.fileBytes, output).toBeGreaterThan(MAPPED_VECTOR_BYTES)
      expect(result.unbackedBytesDuring - result.unbackedBytesBefore, output).toBeLessThan(ANONYMOUS_MARGIN_BYTES / 2)
      expect(result.besideMappedVectors, output).toEqual(
        Array.from({ length: WRITES_BESIDE_MAPPED_VECTORS }, () => ({ accepted: true })),
      )

      expect(result.unbackedBytesAfter - result.unbackedBytesBefore, output).toBeGreaterThan(ANONYMOUS_MARGIN_BYTES)
      expect(result.afterAnonymousGrowth.accepted, output).toBe(false)
      expect(result.afterAnonymousGrowth.code, output).toBe(MEMORY_WRITE_BLOCKED)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  },
  TEST_TIMEOUT_MS,
)
