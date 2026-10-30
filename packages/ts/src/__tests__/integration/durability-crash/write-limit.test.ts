import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createNarsil } from '../../../narsil'

const CHILD_SCRIPT = fileURLToPath(new URL('./child-writer-limited.mjs', import.meta.url))
const BUILT = existsSync(new URL('../../../../dist/index.mjs', import.meta.url))
const FILE_SIZE_LIMIT_BLOCKS = 256

function writeUntilTheFileSizeLimit(directory: string): Promise<{ lines: string[]; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      '/bin/sh',
      ['-c', `trap '' XFSZ; ulimit -f ${FILE_SIZE_LIMIT_BLOCKS}; exec "$0" "$1"`, process.execPath, CHILD_SCRIPT],
      { env: { ...process.env, NARSIL_WAL_DIR: directory }, stdio: ['ignore', 'pipe', 'pipe'] },
    )
    let output = ''
    let errors = ''
    child.stdout.on('data', chunk => {
      output += chunk
    })
    child.stderr.on('data', chunk => {
      errors += chunk
    })
    child.on('error', reject)
    child.on('exit', code => {
      if (code !== 0) reject(new Error(`the writer exited with ${code}: ${errors}`))
      else resolve({ lines: output.split('\n').filter(line => line.length > 0), code })
    })
  })
}

describe.skipIf(!BUILT)('a disk that stops taking writes', { timeout: 60_000 }, () => {
  let directory: string

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'narsil-write-limit-'))
  })

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  it('refuses the write it cannot save, keeps refusing, and recovers every document it acknowledged', async () => {
    const { lines } = await writeUntilTheFileSizeLimit(directory)
    const acknowledged = lines.filter(line => line.startsWith('ACKED ')).map(line => line.slice('ACKED '.length))
    const refusals = lines.filter(line => line.startsWith('REFUSED '))

    expect(acknowledged.length).toBeGreaterThan(0)
    expect(acknowledged).not.toContain('after')
    expect(refusals).toHaveLength(2)
    for (const refusal of refusals) expect(refusal).toMatch(/^REFUSED PERSISTENCE_/)

    const narsil = await createNarsil({ durability: { directory, tier: 'wal' }, workers: { enabled: false } })
    try {
      for (const id of acknowledged) expect(await narsil.get('movies', id), id).toBeDefined()
    } finally {
      await narsil.shutdown()
    }
  })
})
