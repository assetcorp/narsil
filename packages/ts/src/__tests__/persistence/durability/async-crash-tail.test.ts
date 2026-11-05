import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createNarsil, type Narsil } from '../../../narsil'

const CHILD_SCRIPT = fileURLToPath(new URL('./async-writes-child.mjs', import.meta.url))
const BUILT = existsSync(new URL('../../../../dist/index.mjs', import.meta.url))

const UNCHANGED_DOCUMENTS = 40

const EXPECTED_TITLES = {
  kept: 'written before the checkpoint',
  late: 'written after the checkpoint',
}

function killedAfterItsWrites(directory: string): Promise<void> {
  const child = spawn(process.execPath, [CHILD_SCRIPT, directory], { stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString()
  })
  return new Promise((resolve, reject) => {
    let killed = false
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
      if (killed || !stdout.includes('READY\n')) return
      killed = true
      child.kill('SIGKILL')
    })
    child.once('exit', code => {
      if (killed) resolve()
      else reject(new Error(`the writer exited with ${code} before its writes: ${stderr}`))
    })
    child.once('error', reject)
  })
}

async function titlesOf(engine: Narsil): Promise<Record<string, unknown>> {
  const titles: Record<string, unknown> = {}
  for (const id of ['kept', 'removed', 'late']) {
    const document = await engine.get('docs', id)
    if (document !== undefined) titles[id] = document.title
  }
  return titles
}

describe.skipIf(!BUILT)('writes that a killed async-mode process left past the commit marker', () => {
  let directory: string
  let engine: Narsil | null = null

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'narsil-async-crash-tail-'))
  })

  afterEach(async () => {
    await engine?.shutdown()
    engine = null
    await rm(directory, { recursive: true, force: true })
  })

  it('stay applied through the next checkpoint and restart', async () => {
    const first = await createNarsil({ workers: { enabled: false }, durability: { directory } })
    await first.createIndex('docs', { schema: { title: 'string' }, language: 'english' })
    await first.insert('docs', { title: EXPECTED_TITLES.kept }, 'kept')
    await first.insert('docs', { title: 'removed after the checkpoint' }, 'removed')
    await first.insertBatch(
      'docs',
      Array.from({ length: UNCHANGED_DOCUMENTS }, (_, at) => ({ id: `unchanged-${at}`, title: `unchanged ${at}` })),
    )
    await first.checkpoint('docs')
    await first.shutdown()

    await killedAfterItsWrites(directory)

    engine = await createNarsil({ workers: { enabled: false }, durability: { directory } })
    expect(await titlesOf(engine)).toEqual(EXPECTED_TITLES)
    await engine.checkpoint('docs')
    await engine.shutdown()

    engine = await createNarsil({ workers: { enabled: false }, durability: { directory } })
    expect(await titlesOf(engine)).toEqual(EXPECTED_TITLES)
    expect(await engine.countDocuments('docs')).toBe(UNCHANGED_DOCUMENTS + Object.keys(EXPECTED_TITLES).length)
  })
})
