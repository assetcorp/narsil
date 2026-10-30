import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const SERVER_SCRIPT = fileURLToPath(new URL('./stop-server-process.mjs', import.meta.url))
const BUILT = existsSync(new URL('../../../../dist/server.mjs', import.meta.url))
const SEARCH_LOOPS = 8
const SEARCHING_MS = 1_500
const EXIT_DEADLINE_MS = 20_000
const QUERY = Array.from({ length: 16 }, (_, at) => Math.sin(at))

interface Stopped {
  code: number | null
  signal: NodeJS.Signals | null
  stderr: string
  answered: number
}

async function searchUntil(base: string, stop: { done: boolean }, loop: number): Promise<number> {
  let answered = 0
  while (!stop.done) {
    const body =
      loop % 2 === 0
        ? { mode: 'vector', vector: { field: 'embedding', value: QUERY }, limit: 5 }
        : { term: 'lantern', limit: 5 }
    try {
      const response = await fetch(`${base}/indexes/docs/search`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      await response.text()
      if (response.status === 200) answered += 1
    } catch {
      return answered
    }
  }
  return answered
}

async function stopWhileSearched(stopping: 'exit' | 'shutdown'): Promise<Stopped> {
  const child = spawn(process.execPath, [SERVER_SCRIPT], {
    env: { ...process.env, NODE_OPTIONS: '', NARSIL_STOPPING: stopping },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString()
  })
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
    child.once('exit', (code, signal) => resolve({ code, signal }))
  })
  const ready = await new Promise<{ port: number; threads: number }>((resolve, reject) => {
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
      const line = /READY (\d+) (\d+)/.exec(stdout)
      if (line !== null) resolve({ port: Number(line[1]), threads: Number(line[2]) })
    })
    void exited.then(outcome =>
      reject(new Error(`The server ended before it listened: ${JSON.stringify(outcome)} ${stderr}`)),
    )
  })
  expect(ready.threads).toBeGreaterThan(0)
  const stop = { done: false }
  const base = `http://127.0.0.1:${ready.port}`
  const loops = Array.from({ length: SEARCH_LOOPS }, (_, loop) => searchUntil(base, stop, loop))
  await new Promise(resolve => setTimeout(resolve, SEARCHING_MS))
  child.kill('SIGTERM')
  const deadline = new Promise<null>(resolve => setTimeout(() => resolve(null), EXIT_DEADLINE_MS))
  const outcome = await Promise.race([exited, deadline])
  stop.done = true
  const answered = (await Promise.all(loops)).reduce((total, count) => total + count, 0)
  if (outcome === null) {
    child.kill('SIGKILL')
    await exited
    return { code: null, signal: null, stderr: `still running ${EXIT_DEADLINE_MS} ms after SIGTERM`, answered }
  }
  return { ...outcome, stderr, answered }
}

describe.skipIf(!BUILT)('a server process with request threads, stopped while it answers searches', () => {
  it('exits with code 0 when its SIGTERM handler calls process.exit', async () => {
    const stopped = await stopWhileSearched('exit')
    expect(stopped.answered).toBeGreaterThan(0)
    expect(
      {
        code: stopped.code,
        signal: stopped.signal,
        crash: /uv_loop_close|Assertion|Segmentation/.test(stopped.stderr),
      },
      stopped.stderr,
    ).toEqual({
      code: 0,
      signal: null,
      crash: false,
    })
  }, 120_000)

  it('ends by itself once its SIGTERM handler has shut the server down', async () => {
    const stopped = await stopWhileSearched('shutdown')
    expect(stopped.answered).toBeGreaterThan(0)
    expect({ code: stopped.code, signal: stopped.signal }, stopped.stderr).toEqual({ code: 0, signal: null })
  }, 120_000)
})
