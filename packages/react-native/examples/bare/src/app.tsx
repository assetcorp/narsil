import { createNarsil, type PhoneNarsil } from '@delali/narsil-react-native/worklets'
import { useEffect, useState } from 'react'
import { Platform, SafeAreaView, Settings, StyleSheet, Text } from 'react-native'
import { nextTask, readHarnessUrlWith, report } from '../../expo/src/harness'
import { runSearchTask } from '../../expo/src/tasks/search'
import { runTimerTask, type TimerOptions } from '../../expo/src/tasks/timer'
import { runEngineErrorsTask } from './engine-errors'
import { runRuntimeCostsTask } from './runtime-costs'
import { restoreServerSnapshotFromMemory, sendPhoneSnapshotFromMemory } from './snapshots'

const BARE_TASKS = ['search', 'timer', 'snapshot-out', 'snapshot-in', 'runtime-costs', 'engine-errors'] as const

type BareTask = (typeof BARE_TASKS)[number]

function isBareTask(kind: string): kind is BareTask {
  return (BARE_TASKS as readonly string[]).includes(kind)
}

const TIMER_ON_ENGINE_RUNTIME: TimerOptions = { probesAppThread: false }
const IDLE_POLL_MS = 1_000
const HARNESS_URL_LAUNCH_ARGUMENT = 'NarsilHarnessURL'

function readLaunchedHarnessUrl(): string | null {
  if (Platform.OS !== 'ios') return null
  const url: unknown = Settings.get(HARNESS_URL_LAUNCH_ARGUMENT)
  return typeof url === 'string' && url.length > 0 ? url : null
}

readHarnessUrlWith(readLaunchedHarnessUrl)

function openOnEngineRuntime(directory: string): Promise<PhoneNarsil> {
  return createNarsil({ durability: { directory } })
}

function pause(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function openInMemory(): Promise<PhoneNarsil> {
  return createNarsil({ durability: null })
}

function runOnEngineRuntime(kind: BareTask): Promise<unknown> {
  switch (kind) {
    case 'search':
      return runSearchTask(openOnEngineRuntime)
    case 'timer':
      return runTimerTask(createNarsil, TIMER_ON_ENGINE_RUNTIME)
    case 'snapshot-out':
      return sendPhoneSnapshotFromMemory(openInMemory)
    case 'snapshot-in':
      return restoreServerSnapshotFromMemory(openInMemory)
    case 'runtime-costs':
      return runRuntimeCostsTask()
    case 'engine-errors':
      return runEngineErrorsTask()
  }
}

async function followHarness(isStopped: () => boolean, show: (status: string) => void): Promise<void> {
  while (!isStopped()) {
    try {
      const task = await nextTask()
      if (!isBareTask(task.kind)) {
        show(`Waiting for one of these tasks: ${BARE_TASKS.join(', ')}`)
        await pause(IDLE_POLL_MS)
        continue
      }
      show(`Running the ${task.kind} task on the engine's own runtime`)
      try {
        await report(task.kind, { passed: true, result: await runOnEngineRuntime(task.kind) })
        show(`Finished the ${task.kind} task`)
      } catch (error) {
        await report(task.kind, { passed: false, error: { message: messageOf(error) } }).catch(() => undefined)
        show(`The ${task.kind} task failed: ${messageOf(error)}`)
      }
    } catch (error) {
      show(`Waiting for the harness: ${messageOf(error)}`)
      await pause(IDLE_POLL_MS)
    }
  }
}

export function App() {
  const [status, setStatus] = useState('Starting')

  useEffect(() => {
    let stopped = false
    followHarness(() => stopped, setStatus).catch(error => setStatus(`The harness loop stopped: ${messageOf(error)}`))
    return () => {
      stopped = true
    }
  }, [])

  return (
    <SafeAreaView style={styles.screen}>
      <Text style={styles.status}>{status}</Text>
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, backgroundColor: '#ffffff' },
  status: { fontSize: 16, textAlign: 'center', color: '#111111' },
})
