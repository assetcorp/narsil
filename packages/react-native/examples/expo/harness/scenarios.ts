import type { PhoneDriver } from './devices.ts'
import type { Harness, PhoneReport } from './server.ts'

const START_TIMEOUT_MS = 180_000
const TASK_PICKUP_TIMEOUT_MS = 90_000
const VERIFY_TIMEOUT_MS = 600_000
const WRITES_BEFORE_ENDING = 300
const LONG_LOG_DOCUMENTS = 20_000
const ROUNDS = 3
const MOST_CHECKPOINT_ATTEMPTS = 10
const WRITTEN_ID = /^w-(\d{8})$/

export interface DurabilityRound {
  round: number
  acknowledged: number
  stored: number
  missing: string[]
  unexpected: string[]
  gaps: number
  openMs: number
  endedDuringCheckpoint: boolean | null
}

function resultOf(report: PhoneReport): Record<string, unknown> {
  if (!report.payload.passed) throw new Error(`The ${report.kind} task failed: ${JSON.stringify(report.payload.error)}`)
  return report.payload.result as Record<string, unknown>
}

export async function runTask(
  harness: Harness,
  task: Record<string, unknown>,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  const kind = String(task.kind)
  const report = harness.nextReport(kind, timeoutMs)
  const pickup = harness.nextPickup(kind, TASK_PICKUP_TIMEOUT_MS)
  harness.queue(task)
  try {
    await pickup
  } catch (error) {
    harness.unqueue(kind)
    harness.note('harness-step-failed', { kind, reason: `no pickup within ${TASK_PICKUP_TIMEOUT_MS} ms of launch` })
    report.catch(() => undefined)
    throw error
  }
  return resultOf(await report)
}

function writtenId(sequence: number): string {
  return `w-${String(sequence).padStart(8, '0')}`
}

async function verifyRound(
  harness: Harness,
  phone: PhoneDriver,
  directory: string,
  acknowledged: ReadonlySet<string>,
  round: number,
  endedDuringCheckpoint: boolean | null,
): Promise<{ checked: DurabilityRound; nextId: number }> {
  await phone.launch()
  const result = await runTask(harness, { kind: 'verify', directory }, VERIFY_TIMEOUT_MS)
  const ids = result.ids as string[]
  const stored = new Set(ids)
  let highest = -1
  const unexpected: string[] = []
  for (const id of ids) {
    const match = WRITTEN_ID.exec(id)
    if (match === null) unexpected.push(id)
    else highest = Math.max(highest, Number(match[1]))
  }
  let gaps = 0
  for (let sequence = 0; sequence <= highest; sequence++) {
    if (!stored.has(writtenId(sequence))) gaps++
  }
  const checked: DurabilityRound = {
    round,
    acknowledged: acknowledged.size,
    stored: stored.size,
    missing: [...acknowledged].filter(id => !stored.has(id)),
    unexpected,
    gaps,
    openMs: Number(result.openMs),
    endedDuringCheckpoint,
  }
  return { checked, nextId: highest + 1 }
}

export async function endDuringWrites(harness: Harness, phone: PhoneDriver): Promise<DurabilityRound[]> {
  const directory = `writes-${Date.now()}`
  const acknowledged = new Set<string>()
  const rounds: DurabilityRound[] = []
  let firstId = 0
  for (let round = 1; round <= ROUNDS; round++) {
    harness.forgetAcks()
    const since = Date.now()
    await phone.launch()
    harness.queue({ kind: 'writes', directory, firstId })
    await harness.nextEvent('writing', START_TIMEOUT_MS, since)
    await harness.acksReach(WRITES_BEFORE_ENDING, START_TIMEOUT_MS)
    await phone.kill()
    for (const id of harness.acknowledged()) acknowledged.add(id)
    const { checked, nextId } = await verifyRound(harness, phone, directory, acknowledged, round, null)
    rounds.push(checked)
    firstId = nextId
  }
  return rounds
}

export interface LongLogRound {
  logged: number
  loggedInMs: number
  durability: DurabilityRound
}

export async function endAfterLongLog(harness: Harness, phone: PhoneDriver): Promise<LongLogRound> {
  const directory = `long-log-${Date.now()}`
  harness.forgetAcks()
  const since = Date.now()
  await phone.launch()
  harness.queue({ kind: 'long-log-writes', directory, documents: LONG_LOG_DOCUMENTS })
  const written = await harness.nextEvent('long-log-written', VERIFY_TIMEOUT_MS, since)
  await harness.nextEvent('writing', START_TIMEOUT_MS, since)
  await harness.acksReach(WRITES_BEFORE_ENDING, START_TIMEOUT_MS)
  await phone.kill()
  const acknowledged = new Set(harness.acknowledged())
  const { checked } = await verifyRound(harness, phone, directory, acknowledged, 1, null)
  return {
    logged: Number(written.details.documents),
    loggedInMs: Number(written.details.insertMs),
    durability: checked,
  }
}

export async function endDuringCheckpoints(harness: Harness, phone: PhoneDriver): Promise<DurabilityRound[]> {
  const directory = `checkpoint-${Date.now()}`
  const acknowledged = new Set<string>()
  const rounds: DurabilityRound[] = []
  let firstId = 0
  for (let attempt = 1; rounds.filter(round => round.endedDuringCheckpoint === true).length < ROUNDS; attempt++) {
    if (attempt > MOST_CHECKPOINT_ATTEMPTS) {
      throw new Error(`No checkpoint lasted long enough to end the app inside it in ${MOST_CHECKPOINT_ATTEMPTS} tries`)
    }
    harness.forgetAcks()
    const since = Date.now()
    await phone.launch()
    harness.queue({ kind: 'checkpoint', directory, firstId })
    const started = await harness.nextEvent('checkpoint-started', VERIFY_TIMEOUT_MS, since)
    await phone.kill()
    const finishedFirst = harness
      .events()
      .some(event => event.event === 'checkpoint-finished' && event.details.sequence === started.details.sequence)
    for (const id of harness.acknowledged()) acknowledged.add(id)
    const { checked, nextId } = await verifyRound(harness, phone, directory, acknowledged, attempt, !finishedFirst)
    rounds.push(checked)
    firstId = nextId
  }
  return rounds
}
