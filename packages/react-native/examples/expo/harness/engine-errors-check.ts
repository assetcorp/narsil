import type { Checked } from './checks.ts'
import type { Finding } from './oracle.ts'

const SETUP_REFUSAL = 'The setup worklet refused to start this engine'
const AFTERWARDS_DOCUMENTS = 2_000

interface CallAnswer {
  settled: boolean
  raised: boolean
  typed: boolean
  code: string | null
  message: string | null
}

interface HostileBatch {
  sent: number
  badDocuments: number
  answer: CallAnswer
  succeeded: number | null
  failed: number | null
  storedAfterwards: number | null
}

function requireRefusal(findings: Finding[], check: string, answer: CallAnswer | undefined, typed: boolean): void {
  if (answer === undefined) findings.push({ check, detail: 'the app reported nothing' })
  else if (!answer.settled) findings.push({ check, detail: 'the call never settled' })
  else if (!answer.raised) findings.push({ check, detail: 'the call resolved where it should have rejected' })
  else if (typed && !answer.typed) {
    findings.push({ check, detail: `rejected with an untyped ${answer.code ?? 'error'}: ${answer.message}` })
  }
}

function checkHostileBatch(findings: Finding[], batch: HostileBatch | undefined): void {
  const check = 'batch holding bad documents'
  if (batch === undefined) {
    findings.push({ check, detail: 'the app reported nothing' })
    return
  }
  if (!batch.answer.settled) {
    findings.push({ check, detail: 'the call never settled' })
    return
  }
  if (batch.answer.raised) {
    if (!batch.answer.typed) findings.push({ check, detail: `rejected untyped: ${batch.answer.message}` })
    if (batch.storedAfterwards !== 0) {
      findings.push({ check, detail: `rejected, yet ${batch.storedAfterwards} documents were stored` })
    }
    return
  }
  const good = batch.sent - batch.badDocuments
  if (batch.succeeded !== good || batch.failed !== batch.badDocuments) {
    findings.push({
      check,
      detail: `expected ${good} stored and ${batch.badDocuments} refused, got ${batch.succeeded} and ${batch.failed}`,
    })
  }
  if (batch.storedAfterwards !== batch.succeeded) {
    findings.push({ check, detail: `reported ${batch.succeeded} stored, counted ${batch.storedAfterwards}` })
  }
}

export function checkEngineErrors(result: Record<string, unknown>): Checked {
  const findings: Finding[] = []
  const setup = result.setupThrows as CallAnswer | undefined
  requireRefusal(findings, 'setup worklet that throws', setup, false)
  if (setup?.raised && setup.message !== SETUP_REFUSAL) {
    findings.push({ check: 'setup worklet that throws', detail: `lost the message, got: ${setup.message}` })
  }
  requireRefusal(findings, 'batch that is not a list', result.batchNotAList as CallAnswer | undefined, true)
  requireRefusal(findings, 'query on a missing index', result.missingIndex as CallAnswer | undefined, true)
  checkHostileBatch(findings, result.hostileBatch as HostileBatch | undefined)
  const afterwards = result.answersAfterwards as
    | { stored: number | null; matched: number | null; answer: CallAnswer }
    | undefined
  if (afterwards?.answer.settled !== true || afterwards.answer.raised) {
    findings.push({ check: 'engine afterwards', detail: 'a valid batch did not insert after the hostile calls' })
  } else if (afterwards.stored !== AFTERWARDS_DOCUMENTS || afterwards.matched === null || afterwards.matched < 1) {
    findings.push({
      check: 'engine afterwards',
      detail: `stored ${afterwards.stored} of ${AFTERWARDS_DOCUMENTS}, and a title search matched ${afterwards.matched}`,
    })
  }
  return { passed: findings.length === 0, findings, measured: result }
}
