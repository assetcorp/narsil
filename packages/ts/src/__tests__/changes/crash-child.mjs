import { createRequire, syncBuiltinESMExports } from 'node:module'

const require = createRequire(import.meta.url)
const fsPromises = require('node:fs/promises')
const directory = process.env.NARSIL_DIR ?? ''
const killAt = process.env.NARSIL_KILL_AT ?? ''
const writes = Number(process.env.NARSIL_WRITES ?? '0')
const firstDocuments = Number(process.env.NARSIL_FIRST_DOCUMENTS ?? '0')

function killNow() {
  process.kill(process.pid, 'SIGKILL')
  return new Promise(() => undefined)
}

const rename = fsPromises.rename
fsPromises.rename = async (from, to) => {
  if (killAt === 'history-move' && String(to).includes('/history/')) return killNow()
  return rename(from, to)
}
syncBuiltinESMExports()

function writeAt(at) {
  const id = `p${at % firstDocuments}`
  if (at % 5 === 4) return { op: 'remove', id }
  if (at % 3 === 0) return { op: 'insert', id: `w${at}`, document: { title: `written ${at}`, price: at } }
  return { op: 'update', id, document: { title: `updated ${at}`, price: at * 7 } }
}

function report(kind, write) {
  process.stdout.write(`${kind} ${JSON.stringify(write)}\n`)
}

async function perform(engine, write) {
  if (write.op === 'insert') await engine.insert('shop', write.document, write.id)
  else if (write.op === 'update') {
    if (await engine.has('shop', write.id)) await engine.update('shop', write.id, write.document)
    else await engine.insert('shop', write.document, write.id)
  } else if (await engine.has('shop', write.id)) await engine.remove('shop', write.id)
}

async function main() {
  const { createNarsil } = await import('../../../dist/index.mjs')
  const engine = await createNarsil({ workers: { enabled: false }, durability: { directory, mode: 'sync' } })
  for (let at = 0; at < writes; at++) {
    const write = writeAt(at)
    if (killAt === 'write' && at === writes - 1) {
      report('INFLIGHT', write)
      void perform(engine, write)
      setImmediate(() => process.kill(process.pid, 'SIGKILL'))
      return
    }
    await perform(engine, write)
    report('ACK', write)
  }
  await engine.checkpoint('shop')
  process.stdout.write('DONE without reaching the kill point\n')
  await engine.shutdown()
}

main().catch(error => {
  process.stderr.write(`child error: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
})
