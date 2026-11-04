import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { type Checked, checkErrors, checkRestoredSnapshot, checkSearch, checkTimer } from './checks.ts'
import { androidDriver, BARE_APP, EXPO_APP, iosDriver, type PhoneApp, type PhoneDriver } from './devices.ts'
import { checkEngineErrors } from './engine-errors-check.ts'
import { recallOfAnIndexNodeBuilds } from './node-built-recall.ts'
import { answersOnRestoredSnapshot, type RestoredReference } from './restored-reference.ts'
import { endAfterLongLog, endDuringCheckpoints, endDuringWrites, type LongLogRound, runTask } from './scenarios.ts'
import { type Harness, startHarness } from './server.ts'
import { restorePhoneSnapshotOnServer, writeServerSnapshot } from './server-snapshots.ts'

const TASK_TIMEOUT_MS = 1_800_000
const SEARCHED_INDEX_SNAPSHOT = 'searched-index.nrsl'
const PHONE_SNAPSHOT = 'phone.nrsl'
const SCENARIOS = [
  'search',
  'writes',
  'long-log',
  'checkpoint',
  'snapshot-out',
  'snapshot-in',
  'errors',
  'timer',
  'timer-unprobed',
  'runtime-costs',
  'engine-errors',
] as const

type Scenario = (typeof SCENARIOS)[number]

const MEASUREMENT_SCENARIOS: readonly Scenario[] = ['timer-unprobed', 'runtime-costs']

const APPS: Record<string, { app: PhoneApp; scenarios: readonly Scenario[] }> = {
  expo: {
    app: EXPO_APP,
    scenarios: [
      'search',
      'writes',
      'long-log',
      'checkpoint',
      'snapshot-out',
      'snapshot-in',
      'errors',
      'timer',
      'timer-unprobed',
    ],
  },
  bare: {
    app: BARE_APP,
    scenarios: ['search', 'snapshot-out', 'snapshot-in', 'engine-errors', 'timer', 'runtime-costs'],
  },
}

const { values } = parseArgs({
  options: {
    app: { type: 'string', default: 'expo,bare' },
    platform: { type: 'string' },
    device: { type: 'string' },
    out: { type: 'string' },
    fixtures: { type: 'string' },
    only: { type: 'string' },
    'phone-host': { type: 'string' },
    port: { type: 'string', default: '8787' },
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
const harnessPort = Number(values.port)
if (!Number.isInteger(harnessPort) || harnessPort < 1 || harnessPort > 65_535) {
  throw new Error(`--port takes a TCP port, not ${values.port}`)
}
const appNames = values.app.split(',')
const only = values.only?.split(',') as Scenario[] | undefined
const unknownScenarios = (only ?? []).filter(scenario => !SCENARIOS.includes(scenario))
if (unknownScenarios.length > 0) throw new Error(`Unknown scenario ${unknownScenarios.join(', ')}`)

interface AppPass {
  name: string
  app: PhoneApp
  scenarios: Scenario[]
}

const passes: AppPass[] = appNames.map(name => {
  const target = APPS[name]
  if (target === undefined) throw new Error(`--app takes ${Object.keys(APPS).join(' and ')}, not ${name}`)
  const scenarios =
    only === undefined
      ? target.scenarios.filter(scenario => !MEASUREMENT_SCENARIOS.includes(scenario))
      : only.filter(scenario => target.scenarios.includes(scenario))
  if (appNames.length === 1 && only !== undefined && scenarios.length < only.length) {
    throw new Error(`The ${name} app runs only ${target.scenarios.join(', ')}`)
  }
  return { name, app: target.app, scenarios }
})

function driverFor(app: PhoneApp): PhoneDriver {
  if (platform === 'android') return androidDriver(device, app, harnessPort)
  if (platform === 'ios') return iosDriver(device, app, required('phone-host', values['phone-host']), harnessPort)
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

function longLogChecked(round: LongLogRound): Checked {
  const checked = durabilityChecked([round.durability])
  if (round.durability.openMs > round.loggedInMs) {
    checked.findings.push({
      check: 'opening after a long log',
      detail: `reopening took ${Math.round(round.durability.openMs)} ms, longer than the ${Math.round(round.loggedInMs)} ms the app spent inserting the ${round.logged} logged documents`,
    })
  }
  checked.measured = { ...checked.measured, logged: round.logged, loggedInMs: round.loggedInMs }
  return { ...checked, passed: checked.findings.length === 0 }
}

function searchChecked(result: Record<string, unknown>, restored: RestoredReference, builtRecall: number): Checked {
  const checked = checkSearch(result, restored, builtRecall)
  const swapped = restored.statusBefore?.building === true && restored.statusAfter?.building === false
  if (swapped) {
    checked.findings.push({
      check: 'restored snapshot',
      detail: 'Node.js finished rebuilding the restored graph while it answered, so rerun the comparison',
    })
  }
  checked.measured.restoredGraph = { before: restored.statusBefore, after: restored.statusAfter }
  return { ...checked, passed: checked.findings.length === 0 }
}

let nodeBuiltRecall: Promise<number> | null = null

async function runScenario(scenario: Scenario, harness: Harness, phone: PhoneDriver): Promise<Checked> {
  switch (scenario) {
    case 'search': {
      nodeBuiltRecall ??= recallOfAnIndexNodeBuilds()
      await phone.launch()
      const result = await runTask(harness, { kind: 'search' }, TASK_TIMEOUT_MS)
      const restored = await answersOnRestoredSnapshot(readFileSync(join(out, SEARCHED_INDEX_SNAPSHOT)))
      return searchChecked(result, restored, await nodeBuiltRecall)
    }
    case 'writes':
      return durabilityChecked(await endDuringWrites(harness, phone))
    case 'long-log':
      return longLogChecked(await endAfterLongLog(harness, phone))
    case 'checkpoint':
      return durabilityChecked(await endDuringCheckpoints(harness, phone))
    case 'snapshot-out': {
      await phone.launch()
      const sent = await runTask(harness, { kind: 'snapshot-out' }, TASK_TIMEOUT_MS)
      const checked = await restorePhoneSnapshotOnServer(readFileSync(join(out, PHONE_SNAPSHOT)))
      return { ...checked, measured: { ...checked.measured, sent } }
    }
    case 'snapshot-in': {
      const written = await writeServerSnapshot(fixtures)
      await phone.launch()
      const checked = checkRestoredSnapshot(await runTask(harness, { kind: 'snapshot-in' }, TASK_TIMEOUT_MS))
      return { ...checked, measured: { ...checked.measured, serverSnapshot: written } }
    }
    case 'errors':
      await phone.launch()
      return checkErrors(await runTask(harness, { kind: 'errors' }, TASK_TIMEOUT_MS))
    case 'engine-errors':
      await phone.launch()
      return checkEngineErrors(await runTask(harness, { kind: 'engine-errors' }, TASK_TIMEOUT_MS))
    case 'timer':
      await phone.launch()
      return checkTimer(await runTask(harness, { kind: 'timer' }, TASK_TIMEOUT_MS))
    case 'timer-unprobed':
      await phone.launch()
      return checkTimer(await runTask(harness, { kind: 'timer', probesAppThread: false }, TASK_TIMEOUT_MS))
    case 'runtime-costs':
      await phone.launch()
      return {
        passed: true,
        findings: [],
        measured: await runTask(harness, { kind: 'runtime-costs' }, TASK_TIMEOUT_MS),
      }
  }
}

const harness = await startHarness(harnessPort, out, fixtures)
const summary: Record<string, Checked | { passed: false; error: string }> = {}
try {
  for (const [passIndex, pass] of passes.entries()) {
    const phone = driverFor(pass.app)
    const anotherAppFollows = passIndex < passes.length - 1
    try {
      for (const scenario of pass.scenarios) {
        const key = `${pass.name} ${scenario}`
        console.log(`${platform} ${key}: started`)
        try {
          summary[key] = await runScenario(scenario, harness, phone)
        } catch (error) {
          summary[key] = { passed: false, error: error instanceof Error ? error.message : String(error) }
          await phone.kill().catch(() => undefined)
        }
        writeFileSync(join(out, 'summary.json'), JSON.stringify(summary, null, 2))
        console.log(`${platform} ${key}: ${summary[key]?.passed ? 'passed' : 'FAILED'}`)
      }
    } finally {
      if (anotherAppFollows) await phone.kill().catch(() => undefined)
    }
  }
} finally {
  await harness.close()
}
process.exitCode = Object.values(summary).every(result => result.passed) ? 0 : 1
