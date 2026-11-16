import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

const SERVER_HEAP_MEGABYTES = 128
const SERVER_TIMEOUT_MS = 20_000

it('closes a feed whose frame declares more array elements than it holds, and keeps serving', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'narsil-impossible-arrays-'))
  const entry = fileURLToPath(new URL('./impossible-array-lengths-server.mjs', import.meta.url))
  const child = spawn(process.execPath, [`--max-old-space-size=${SERVER_HEAP_MEGABYTES}`, entry, directory], {
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: SERVER_TIMEOUT_MS,
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString()
  })
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString()
  })
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', resolve)
  })
  try {
    expect(await exited, stderr).toBe(0)
    expect(stdout).toContain('Both feeds refused every frame and the server kept serving writes.')
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await exited.catch(() => undefined)
    await rm(directory, { recursive: true, force: true })
  }
}, 30_000)
