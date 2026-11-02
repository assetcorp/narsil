import { useEffect, useState } from 'react'
import { SafeAreaView, StyleSheet, Text } from 'react-native'
import { nextTask, report } from '../../expo/src/harness'
import { runSearchTask } from '../../expo/src/tasks/search'

const IDLE_POLL_MS = 1_000

function pause(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function followHarness(isStopped: () => boolean, show: (status: string) => void): Promise<void> {
  while (!isStopped()) {
    try {
      const task = await nextTask()
      if (task.kind !== 'search') {
        show('Waiting for a search task')
        await pause(IDLE_POLL_MS)
        continue
      }
      show('Running the keyword, vector, and hybrid searches')
      try {
        await report('search', { passed: true, result: await runSearchTask() })
        show('Finished the searches')
      } catch (error) {
        await report('search', { passed: false, error: { message: messageOf(error) } }).catch(() => undefined)
        show(`The searches failed: ${messageOf(error)}`)
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
  screen: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  status: { fontSize: 16, textAlign: 'center' },
})
