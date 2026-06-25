import { type ChildProcess, spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createNarsil } from '../../../narsil'

const CHILD_SCRIPT = fileURLToPath(new URL('./child-writer-dist.mjs', import.meta.url))

interface ChildOptions {
  directory: string
  docCount: number
  mode?: 'sync' | 'async'
  exit?: 'wait-for-kill' | 'clean-exit' | 'normal-return'
}

function spawnChild(options: ChildOptions): {
  child: ChildProcess
  acked: Promise<void>
  exited: Promise<number | null>
} {
  const child = spawn(process.execPath, [CHILD_SCRIPT], {
    env: {
      ...process.env,
      NARSIL_WAL_DIR: options.directory,
      NARSIL_DOC_COUNT: String(options.docCount),
      NARSIL_MODE: options.mode ?? 'sync',
      NARSIL_EXIT: options.exit ?? 'wait-for-kill',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  let stdoutBuffer = ''
  let stderrBuffer = ''
  child.stderr?.on('data', (chunk: Buffer) => {
    stderrBuffer += chunk.toString()
  })
  const acked = new Promise<void>((resolve, reject) => {
    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutBuffer += chunk.toString()
      if (stdoutBuffer.includes('ACKED')) {
        resolve()
      }
    })
    child.on('exit', code => {
      if (!stdoutBuffer.includes('ACKED')) {
        reject(new Error(`child exited (code ${code}) before acknowledging writes; stderr: ${stderrBuffer}`))
      }
    })
    child.on('error', reject)
  })

  const exited = new Promise<number | null>(resolve => {
    child.on('exit', code => resolve(code))
  })

  return { child, acked, exited }
}

describe('durability crash recovery (out-of-process)', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'narsil-crash-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  async function recoverAndCount(): Promise<number> {
    const reader = await createNarsil({ durability: { directory: root } })
    try {
      return await reader.countDocuments('movies')
    } finally {
      await reader.shutdown()
    }
  }

  it('recovers all acknowledged writes after a SIGKILL mid-life (single doc)', async () => {
    const { child, acked, exited } = spawnChild({ directory: root, docCount: 1, exit: 'wait-for-kill' })
    await acked
    child.kill('SIGKILL')
    await exited

    expect(await recoverAndCount()).toBe(1)
  })

  it('recovers all acknowledged writes after a SIGKILL mid-life (many docs)', async () => {
    const { child, acked, exited } = spawnChild({ directory: root, docCount: 25, exit: 'wait-for-kill' })
    await acked
    child.kill('SIGKILL')
    await exited

    const reader = await createNarsil({ durability: { directory: root } })
    try {
      expect(await reader.countDocuments('movies')).toBe(25)
      expect(await reader.get('movies', 'm0')).toMatchObject({ title: 'Movie 0' })
      expect(await reader.get('movies', 'm24')).toMatchObject({ title: 'Movie 24' })
    } finally {
      await reader.shutdown()
    }
  })

  it('keeps full-text search consistent after a SIGKILL crash', async () => {
    const { child, acked, exited } = spawnChild({ directory: root, docCount: 10, exit: 'wait-for-kill' })
    await acked
    child.kill('SIGKILL')
    await exited

    const reader = await createNarsil({ durability: { directory: root } })
    try {
      const result = await reader.query('movies', { term: 'movie' })
      expect(result.hits.length).toBe(10)
    } finally {
      await reader.shutdown()
    }
  })

  it('recovers correctly across two crash-and-restart cycles', async () => {
    const first = spawnChild({ directory: root, docCount: 5, exit: 'wait-for-kill' })
    await first.acked
    first.child.kill('SIGKILL')
    await first.exited
    expect(await recoverAndCount()).toBe(5)

    const second = spawnChild({ directory: root, docCount: 8, exit: 'wait-for-kill' })
    await second.acked
    second.child.kill('SIGKILL')
    await second.exited
    expect(await recoverAndCount()).toBe(13)
  })

  it('loses no acknowledged write when the crash lands after the last ack', async () => {
    const { child, acked, exited } = spawnChild({ directory: root, docCount: 12, exit: 'wait-for-kill' })
    await acked
    await new Promise<void>(resolve => setTimeout(resolve, 50))
    child.kill('SIGKILL')
    await exited

    expect(await recoverAndCount()).toBe(12)
  })

  it('loses nothing on a clean async-mode exit because the OS flushes buffered bytes', async () => {
    const { acked, exited } = spawnChild({ directory: root, docCount: 15, mode: 'async', exit: 'clean-exit' })
    await acked
    const code = await exited
    expect(code).toBe(0)

    expect(await recoverAndCount()).toBe(15)
  })
}, 30_000)
