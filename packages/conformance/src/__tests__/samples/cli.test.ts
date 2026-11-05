import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PACKAGE_ROOT } from '../../package-root'
import { jsonText, readCatalog, readExpected, readSampleBytes } from '../../samples/catalog'

const run = promisify(execFile)
const catalog = await readCatalog()
const CLI_TIMEOUT_MS = 300_000
const CLI_OUTPUT_LIMIT_BYTES = 16_777_216

interface CliResult {
  code: number
  output: string
}

async function cli(...args: string[]): Promise<CliResult> {
  try {
    const { stdout } = await run(join(PACKAGE_ROOT, 'node_modules', '.bin', 'tsx'), ['src/cli.ts', ...args], {
      cwd: PACKAGE_ROOT,
      maxBuffer: CLI_OUTPUT_LIMIT_BYTES,
    })
    return { code: 0, output: stdout }
  } catch (error) {
    if (error instanceof Error && 'code' in error && typeof error.code === 'number' && 'stdout' in error) {
      return { code: error.code, output: String(error.stdout) }
    }
    throw error
  }
}

async function placed(directory: string, relativePath: string, content: Uint8Array | string): Promise<void> {
  await mkdir(dirname(join(directory, relativePath)), { recursive: true })
  await writeFile(join(directory, relativePath), content)
}

let directory = ''

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'narsil-conformance-cli-'))
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

describe('the conformance command', () => {
  it(
    'passes an implementation whose decoded JSON matches and names the one sample that differs',
    async () => {
      for (const entry of catalog) await placed(directory, `${entry.name}.json`, jsonText(await readExpected(entry)))
      const clean = await cli('check-read', directory)
      expect(clean.code).toBe(0)
      expect(clean.output).toContain(`${catalog.length} of ${catalog.length} samples pass`)
      const changed = catalog.find(entry => entry.kind === 'keyword-segment')
      if (changed === undefined) throw new Error('the catalog lists no keyword segment')
      const expected = await readExpected(changed)
      await placed(directory, `${changed.name}.json`, jsonText({ ...expected, header: { version: 3 } }))
      const failing = await cli('check-read', directory)
      expect(failing.code).toBe(1)
      expect(failing.output).toContain(`FAIL  ${changed.name}`)
      expect(failing.output.match(/^FAIL/gm)).toHaveLength(1)
    },
    CLI_TIMEOUT_MS,
  )

  it(
    'passes files that read as their JSON and fails a truncated one',
    async () => {
      for (const entry of catalog) await placed(directory, entry.name, await readSampleBytes(entry))
      const clean = await cli('check-written', directory)
      expect(clean.code).toBe(0)
      expect(clean.output).toContain(`${catalog.length} of ${catalog.length} samples pass`)
      const changed = catalog.find(entry => entry.kind === 'vector-file')
      if (changed === undefined) throw new Error('the catalog lists no vector file')
      const bytes = await readSampleBytes(changed)
      await placed(directory, changed.name, bytes.subarray(0, bytes.length - 1))
      const failing = await cli('check-written', directory)
      expect(failing.code).toBe(1)
      expect(failing.output).toContain(`FAIL  ${changed.name}`)
      expect(failing.output.match(/^FAIL/gm)).toHaveLength(1)
    },
    CLI_TIMEOUT_MS,
  )

  it('refuses a check with no directory', async () => {
    expect((await cli('check-read')).code).toBe(2)
  })
})
