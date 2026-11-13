import { createInterface } from 'node:readline'
import { MEMORY_MEASURED_LINE, MEMORY_READY_LINE, type MeasuredPhase, type VerifiedAnswer } from '../runner-output'

export interface Answer {
  count: number
  countExact: boolean
  hits: Array<{ id: string; score?: number }>
}

export function nowNs(): bigint {
  return process.hrtime.bigint()
}

export function elapsedNs(since: bigint): number {
  return Number(nowNs() - since)
}

export function verifiedAnswer(answer: Answer): VerifiedAnswer {
  return {
    count: answer.count,
    countExact: answer.countExact,
    hits: answer.hits.map(hit => {
      if (typeof hit.score !== 'number') throw new Error(`hit ${hit.id} carries no score`)
      return [hit.id, hit.score]
    }),
  }
}

function sameAnswer(answer: Answer, expected: VerifiedAnswer): boolean {
  if (
    answer.count !== expected.count ||
    answer.countExact !== expected.countExact ||
    answer.hits.length !== expected.hits.length
  )
    return false
  return answer.hits.every((hit, rank) => hit.id === expected.hits[rank][0] && hit.score === expected.hits[rank][1])
}

async function inParallel(threads: number, items: number, work: (item: number) => Promise<void>): Promise<void> {
  let next = 0
  const loops: Promise<void>[] = []
  for (let thread = 0; thread < threads; thread++) {
    loops.push(
      (async () => {
        for (;;) {
          const item = next
          if (item >= items) return
          next = item + 1
          await work(item)
        }
      })(),
    )
  }
  await Promise.all(loops)
}

export async function measurePhase(
  threads: number,
  warmupPasses: number,
  passes: number,
  expected: readonly VerifiedAnswer[],
  run: (query: number) => Promise<Answer>,
): Promise<MeasuredPhase> {
  const queries = expected.length
  await inParallel(threads, warmupPasses * queries, async item => {
    await run(item % queries)
  })
  const total = passes * queries
  const latencyNs = new Array<number>(total).fill(0)
  let mismatches = 0
  const start = nowNs()
  await inParallel(threads, total, async item => {
    const query = item % queries
    const began = nowNs()
    const answer = await run(query)
    latencyNs[item] = elapsedNs(began)
    if (!sameAnswer(answer, expected[query])) mismatches++
  })
  const wallNs = elapsedNs(start)
  return { queries, warmupPasses, passes, threads, wallNs, latencyNs, mismatches }
}

export async function verifyEach(queries: number, run: (query: number) => Promise<Answer>): Promise<VerifiedAnswer[]> {
  const answers: VerifiedAnswer[] = []
  for (let query = 0; query < queries; query++) answers.push(verifiedAnswer(await run(query)))
  return answers
}

export async function holdForMemoryReading(): Promise<void> {
  const lines = createInterface({ input: process.stdin })
  process.stdout.write(`${MEMORY_READY_LINE}\n`)
  for await (const line of lines) {
    if (line.trim() === MEMORY_MEASURED_LINE) {
      lines.close()
      return
    }
    throw new Error(`the driver answered ${JSON.stringify(line)} where the runner waits for ${MEMORY_MEASURED_LINE}`)
  }
  throw new Error('the driver closed stdin before it measured memory')
}
