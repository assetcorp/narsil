import { readFile } from 'node:fs/promises'
import { createNarsil } from '../../../dist/index.mjs'

const SETTLE_DEADLINE_MS = 60_000

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function untilSettled(narsil, index) {
  const deadline = Date.now() + SETTLE_DEADLINE_MS
  while (narsil.vectorMaintenanceStatus(index).some(field => field.building || field.graphCount === 0)) {
    if (Date.now() > deadline) throw new Error(`the graph of ${index} was still building after 60 s`)
    await sleep(5)
  }
}

async function untilEveryWorkerHoldsACopy(narsil, index, probe) {
  const deadline = Date.now() + SETTLE_DEADLINE_MS
  for (;;) {
    await narsil.query(index, probe)
    const stats = await narsil.getMemoryStats()
    if (stats.workerCopies.some(report => report.indexName === index && report.scaledOut)) return
    if (Date.now() > deadline) throw new Error(`the workers still held no copy of ${index} after 60 s`)
    await sleep(20)
  }
}

async function main() {
  const scenario = JSON.parse(await readFile(process.env.NARSIL_SCENARIO, 'utf8'))
  const { index, config, papers, rounds, questions } = scenario
  const narsil = await createNarsil({ workers: { count: 2 } })
  await narsil.createIndex(index, config)
  for (let start = 0; start < papers.length; start += scenario.batchSize) {
    const result = await narsil.insertBatch(index, papers.slice(start, start + scenario.batchSize))
    if (result.failed.length > 0) throw new Error(`${result.failed.length} papers failed to insert`)
  }
  await untilSettled(narsil, index)
  await untilEveryWorkerHoldsACopy(narsil, index, questions[0].params)
  const archive = new Uint8Array(await new Response(await narsil.snapshot(index)).arrayBuffer())
  for (const [round, reembedded] of rounds.entries()) {
    const result = await narsil.updateBatch(
      index,
      reembedded.map(paper => ({ docId: paper.id, document: paper })),
    )
    if (result.failed.length > 0) throw new Error(`${result.failed.length} papers failed to update`)
    await narsil.restore(index, archive)
    await untilSettled(narsil, index)
    await untilEveryWorkerHoldsACopy(narsil, index, questions[0].params)
    process.stdout.write(`ROUND ${round + 1}\n`)
  }
  const answers = []
  for (const question of questions) {
    const result = await narsil.query(index, question.params)
    answers.push(result.hits.map(hit => ({ id: hit.id, score: hit.score ?? Number.NaN })))
  }
  process.stdout.write(`ANSWERS ${JSON.stringify(answers)}\n`)
  await narsil.shutdown()
  process.exit(0)
}

main().catch(err => {
  process.stderr.write(`child error: ${err instanceof Error ? err.stack : String(err)}\n`)
  process.exit(1)
})
