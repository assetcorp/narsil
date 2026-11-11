import { readFileSync, writeFileSync } from 'node:fs'

const distEntry = new URL('../../../ts/dist/index.mjs', import.meta.url)
const { createNarsil } = await import(distEntry.href)

async function bytesOf(stream) {
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

async function write(request) {
  const engine = await createNarsil({ workers: { enabled: false } })
  try {
    await engine.createIndex(request.index, request.config)
    for (const document of request.documents) await engine.insert(request.index, document)
    writeFileSync(request.snapshot, await bytesOf(await engine.snapshot(request.index)))
  } finally {
    await engine.shutdown()
  }
}

async function restore(request) {
  const engine = await createNarsil({ workers: { enabled: false } })
  try {
    await engine.restore(request.index, new Uint8Array(readFileSync(request.snapshot)))
    writeFileSync(request.outcome, JSON.stringify({ code: null }))
  } catch (error) {
    writeFileSync(request.outcome, JSON.stringify({ code: error?.code ?? null, message: String(error?.message) }))
  } finally {
    await engine.shutdown()
  }
}

async function exportRestored(request) {
  const engine = await createNarsil({ workers: { enabled: false } })
  try {
    await engine.restore(request.index, new Uint8Array(readFileSync(request.snapshot)))
    writeFileSync(request.outcome, await bytesOf(await engine.exportDocuments(request.index)))
  } finally {
    await engine.shutdown()
  }
}

const request = JSON.parse(readFileSync(process.argv[2], 'utf8'))
if (request.mode === 'write') await write(request)
else if (request.mode === 'restore') await restore(request)
else if (request.mode === 'export') await exportRestored(request)
else throw new Error(`unknown mode ${request.mode}`)
