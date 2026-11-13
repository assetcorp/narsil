import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { expect, it } from 'vitest'
import { distEntry, onNewConnection } from './silent-workers'

it.skipIf(!existsSync(distEntry))(
  'exits after shutdown overlaps retirement despite a bootstrap timer',
  async () => {
    const index = new URL('../../../../dist/index.mjs', import.meta.url).href
    const server = new URL('../../../../dist/server.mjs', import.meta.url).href
    const bootstrap = `import { registerLanguage } from ${JSON.stringify(index)}
setInterval(() => {}, 1000)
registerLanguage({ name: 'retired-process', revision: '1', stopWords: new Set(), stemmer(token) {
  if (token === 'fail') throw new Error('The worker rejected this token')
  return token
} })`
    const source = `(async () => {
const { createNarsil, registerLanguage } = await import(${JSON.stringify(index)})
const { createServer } = await import(${JSON.stringify(server)})
registerLanguage({ name: 'retired-process', revision: '1', stopWords: new Set(), stemmer: token => token })
const engine = await createNarsil({ workers: {
  count: 1, bootstrapModule: ${JSON.stringify(`data:text/javascript,${encodeURIComponent(bootstrap)}`)},
} })
const crashed = new Promise(resolve => engine.on('workerCrash', resolve))
const server = createServer(engine, {
  host: '127.0.0.1', port: 0,
  async onRequest() {
    await engine.update('tickets', 'ticket-0', { title: 'fail' })
    await crashed
    void server.close()
    await engine.shutdown()
    return { status: 403, code: 'DENIED', message: 'Access denied' }
  },
})
await server.listen()
await engine.createIndex('tickets', { schema: { title: 'string' }, language: 'retired-process' })
await engine.insertBatch('tickets', Array.from({ length: 1200 }, (_, i) => ({ id: 'ticket-' + i, title: 'ticket' })), { wait: true })
while (!(await engine.getMemoryStats()).workerCopies.some(copy => copy.scaledOut)) {
  await new Promise(resolve => setTimeout(resolve, 25))
}
if (server.requestThreadCount !== 1) throw new Error('The request thread did not start')
console.log('listening-port=' + server.listeningPort)
})().catch(error => { console.error(error); process.exitCode = 1 })`
    const child = spawn(process.execPath, ['-e', source], { stdio: ['ignore', 'pipe', 'pipe'] })
    const deadline = setTimeout(() => child.kill('SIGKILL'), 20_000)
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
          const port = /listening-port=(\d+)\n/.exec(output)?.[1]
          if (port !== undefined) resolve(Number(port))
        })
        child.once('error', reject)
        child.once('exit', () => reject(new Error(stderr)))
      })
      const answer = await onNewConnection<{ error: { code: string } }>(`http://127.0.0.1:${port}`, '/indexes', {
        timeoutMs: 15_000,
      })
      expect(answer.status, stderr).toBe(403)
      expect(answer.connection).toBe('close')
      expect(answer.body.error.code).toBe('DENIED')
      expect(await exited, stderr).toEqual({ code: 0, signal: null })
    } finally {
      clearTimeout(deadline)
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      await exited
    }
  },
  30_000,
)
