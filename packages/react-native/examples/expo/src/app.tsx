import { createNarsil } from '@delali/narsil-react-native'
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake'
import { useEffect, useState } from 'react'
import { SafeAreaView, StyleSheet, Text } from 'react-native'
import { readCopiedHarnessUrl } from './copied-harness-url'
import { nextTask, type PhoneTask, readHarnessUrlWith, report } from './harness'
import { checkpointUntilEnded, storedIds, writeLongLogUntilEnded, writeUntilEnded } from './tasks/durability'
import { runErrorsTask } from './tasks/errors'
import { runSearchTask } from './tasks/search'
import { restoreServerSnapshot, sendPhoneSnapshot } from './tasks/snapshot'
import { runTimerTask } from './tasks/timer'

const IDLE_POLL_MS = 1_000
const UNREACHABLE_RETRY_MS = 2_000
const HARNESS_KEEP_AWAKE_TAG = 'narsil-harness'

readHarnessUrlWith(readCopiedHarnessUrl)

function pause(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function describe(error: unknown): { name: string; code: string | null; message: string } {
  const record = error as { name?: unknown; code?: unknown; message?: unknown } | null
  return {
    name: typeof record?.name === 'string' ? record.name : 'Error',
    code: typeof record?.code === 'string' ? record.code : null,
    message: typeof record?.message === 'string' ? record.message : String(error),
  }
}

async function perform(task: PhoneTask): Promise<unknown> {
  switch (task.kind) {
    case 'idle':
      await pause(IDLE_POLL_MS)
      return undefined
    case 'search':
      return runSearchTask()
    case 'writes':
      return writeUntilEnded(task.directory, task.firstId)
    case 'long-log-writes':
      return writeLongLogUntilEnded(task.directory, task.documents)
    case 'checkpoint':
      return checkpointUntilEnded(task.directory, task.firstId)
    case 'verify':
      return storedIds(task.directory)
    case 'snapshot-out':
      return sendPhoneSnapshot()
    case 'snapshot-in':
      return restoreServerSnapshot()
    case 'errors':
      return runErrorsTask()
    case 'timer':
      return runTimerTask(createNarsil, { probesAppThread: task.probesAppThread })
    case 'runtime-costs':
      throw new Error('Only the app without Expo measures runtime costs, because it alone starts a Worklets runtime')
  }
}

async function followHarness(isStopped: () => boolean, show: (status: string) => void): Promise<void> {
  await activateKeepAwakeAsync(HARNESS_KEEP_AWAKE_TAG)
  try {
    while (!isStopped()) {
      let task: PhoneTask
      try {
        task = await nextTask()
      } catch (error) {
        show(`Waiting for the harness: ${describe(error).message}`)
        await pause(UNREACHABLE_RETRY_MS)
        continue
      }
      if (task.kind === 'idle') {
        show('Waiting for a task')
        await perform(task)
        continue
      }
      show(`Running the ${task.kind} task`)
      try {
        const result = await perform(task)
        await report(task.kind, { passed: true, result })
        show(`Finished the ${task.kind} task`)
      } catch (error) {
        await report(task.kind, { passed: false, error: describe(error) }).catch(() => undefined)
        show(`The ${task.kind} task failed: ${describe(error).message}`)
      }
    }
  } finally {
    await deactivateKeepAwake(HARNESS_KEEP_AWAKE_TAG)
  }
}

export function App() {
  const [status, setStatus] = useState('Starting')

  useEffect(() => {
    let stopped = false
    followHarness(() => stopped, setStatus).catch(error => setStatus(`The harness loop stopped: ${String(error)}`))
    return () => {
      stopped = true
    }
  }, [])

  return (
    <SafeAreaView style={styles.screen}>
      <Text style={styles.status} testID="narsil-status">
        {status}
      </Text>
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, backgroundColor: '#ffffff' },
  status: { fontSize: 16, textAlign: 'center', color: '#111111' },
})
