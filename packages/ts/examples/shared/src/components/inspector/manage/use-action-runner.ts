import { useCallback, useEffect, useRef, useState } from 'react'

export type ActionState =
  | { kind: 'idle' }
  | { kind: 'running'; label: string }
  | { kind: 'done'; message: string }
  | { kind: 'failed'; message: string }

export interface ActionRunner {
  state: ActionState
  isRunning: boolean
  run: (label: string, action: () => Promise<string>) => Promise<void>
}

const IDLE: ActionState = { kind: 'idle' }

export function useActionRunner(): ActionRunner {
  const [state, setState] = useState<ActionState>(IDLE)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const run = useCallback(async (label: string, action: () => Promise<string>) => {
    setState({ kind: 'running', label })
    try {
      const message = await action()
      if (mounted.current) setState({ kind: 'done', message })
    } catch (err) {
      if (mounted.current) setState({ kind: 'failed', message: err instanceof Error ? err.message : String(err) })
    }
  }, [])

  return { state, isRunning: state.kind === 'running', run }
}
