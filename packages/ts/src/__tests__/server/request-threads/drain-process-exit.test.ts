import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { expect, it } from 'vitest'
import { distEntry, onNewConnection } from './silent-workers'

it.skipIf(!existsSync(distEntry))(
  'keeps the process alive until concurrent server and engine shutdown answer accepted requests',
  async () => {
    const index = new URL('../../../../dist/index.mjs', import.meta.url).href
    const server = new URL('../../../../dist/server.mjs', import.meta.url).href
    const source = `(async () => {
const { createNarsil } = await import(${JSON.stringify(index)})
const { createServer } = await import(${JSON.stringify(server)})
const engine = await createNarsil({ workers: {
  count: 1,
  bootstrapModule: 'data:text/javascript,setInterval(() => {}, 1000)',
} })
const server = createServer(engine, {
  host: '127.0.0.1', port: 0,
  async onRequest() {
    void server.close()
    void engine.shutdown()
    await new Promise(() => {})
  },
})
await server.listen()
if (server.requestThreadCount !== 1) throw new Error('The request thread did not start')
console.log(server.listeningPort)
})().catch(error => { console.error(error); process.exitCode = 1 })`
    const child = spawn(process.execPath, ['-e', source], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''
    child.stderr.setEncoding('utf8').on('data', chunk => {
      stderr += chunk
    })
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
      child.once('exit', (code, signal) => resolve({ code, signal }))
    })
    try {
      const port = await new Promise<number>((resolve, reject) => {
        let output = ''
        child.stdout.setEncoding('utf8').on('data', chunk => {
          output += chunk
          if (output.includes('\n')) resolve(Number(output.trim()))
        })
        child.once('error', reject)
        child.once('exit', () => reject(new Error(stderr)))
      })
      const answer = await onNewConnection<{ error: { code: string } }>(`http://127.0.0.1:${port}`, '/indexes', {
        timeoutMs: 45_000,
      })
      expect(answer.status).toBe(503)
      expect(answer.connection).toBe('close')
      expect(answer.body.error.code).toBe('WORKER_CRASHED')
      expect(await exited, stderr).toEqual({ code: 0, signal: null })
    } catch (error) {
      throw new Error(stderr, { cause: error })
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      await exited
    }
  },
  60_000,
)
