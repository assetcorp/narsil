import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { type Checked, checkErrors, checkRestoredSnapshot, checkSearch, checkTimer } from './checks.ts'
import { androidDriver, iosDriver, type PhoneDriver } from './devices.ts'
import { endDuringCheckpoints, endDuringWrites, runTask } from './scenarios.ts'
import { type Harness, startHarness } from './server.ts'

const HARNESS_PORT = 8787
const TASK_TIMEOUT_MS = 1_800_000
const SCENARIOS = ['search', 'writes', 'checkpoint', 'snapshot-out', 'snapshot-in', 'errors', 'timer'] as const

type Scenario = (typeof SCENARIOS)[number]

const { values } = parseArgs({
  options: {
    platform: { type: 'string' },
    device: { type: 'string' },
    out: { type: 'string' },
    fixtures: { type: 'string' },
    only: { type: 'string' },
    'phone-host': { type: 'string' },
  },
})

function required(name: string, value: string | undefined): string {
  if (value === undefined || value.length === 0) throw new Error(`Pass --${name}`)
  return value
}

const platform = required('platform', values.platform)
const device = required('device', values.device)
const out = required('out', values.out)
const fixtures = required('fixtures', values.fixtures)
const chosen = (values.only?.split(',') ?? [...SCENARIOS]) as Scenario[]

function driverFor(): PhoneDriver {
  if (platform === 'android') return androidDriver(device)
  if (platform === 'ios') return iosDriver(device, required('phone-host', values['phone-host']), HARNESS_PORT)
  throw new Error(`--platform must be ios or android, not ${platform}`)
}

function durabilityChecked(rounds: Awaited<ReturnType<typeof endDuringWrites>>): Checked {
  const findings = rounds.flatMap(round => [
    ...round.missing.map(id => ({ check: `round ${round.round}`, detail: `acknowledged ${id} is missing` })),
    ...round.unexpected.map(id => ({ check: `round ${round.round}`, detail: `unexpected document ${id}` })),
    ...(round.gaps > 0 ? [{ check: `round ${round.round}`, detail: `${round.gaps} gaps in the stored ids` }] : []),
  ])
  return { passed: findings.length === 0, findings, measured: { rounds } }
}

async function runScenario(scenario: Scenario, harness: Harness, phone: PhoneDriver): Promise<Checked> {
  switch (scenario) {
    case 'search': {
      const reference = JSON.parse(readFileSync(join(fixtures, 'node-reference.json'), 'utf8')) as {
        recallAt10: number
      }
      await phone.launch()
      return checkSearch(await runTask(harness, { kind: 'search' }, TASK_TIMEOUT_MS), reference.recallAt10)
    }
    case 'writes':
      return durabilityChecked(await endDuringWrites(harness, phone))
    case 'checkpoint':
      return durabilityChecked(await endDuringCheckpoints(harness, phone))
    case 'snapshot-out': {
      await phone.launch()
      const result = await runTask(harness, { kind: 'snapshot-out' }, TASK_TIMEOUT_MS)
      return { passed: true, findings: [], measured: result }
    }
    case 'snapshot-in':
      await phone.launch()
      return checkRestoredSnapshot(await runTask(harness, { kind: 'snapshot-in' }, TASK_TIMEOUT_MS))
    case 'errors':
      await phone.launch()
      return checkErrors(await runTask(harness, { kind: 'errors' }, TASK_TIMEOUT_MS))
    case 'timer':
      await phone.launch()
      return checkTimer(await runTask(harness, { kind: 'timer' }, TASK_TIMEOUT_MS))
  }
}

const harness = await startHarness(HARNESS_PORT, out, fixtures)
const phone = driverFor()
const summary: Record<string, Checked | { passed: false; error: string }> = {}
try {
  for (const scenario of chosen) {
    if (!SCENARIOS.includes(scenario)) throw new Error(`Unknown scenario ${scenario}`)
    console.log(`${platform} ${scenario}: started`)
    try {
      summary[scenario] = await runScenario(scenario, harness, phone)
    } catch (error) {
      summary[scenario] = { passed: false, error: error instanceof Error ? error.message : String(error) }
    }
    writeFileSync(join(out, 'summary.json'), JSON.stringify(summary, null, 2))
    console.log(`${platform} ${scenario}: ${summary[scenario]?.passed ? 'passed' : 'FAILED'}`)
  }
} finally {
  await harness.close()
}
process.exitCode = Object.values(summary).every(result => result.passed) ? 0 : 1
