import { createContext, useContext } from 'react'

/* 'checking' exists only in the browser before the first status response, so
 * the UI never claims the engine is recovering when it is already up. */
export type EngineStatusPhase = 'checking' | 'starting' | 'ready' | 'error'

export interface EngineStatus {
  phase: EngineStatusPhase
  error?: string
}

export const EngineStatusContext = createContext<EngineStatus>({ phase: 'checking' })

export function useEngineStatus(): EngineStatus {
  return useContext(EngineStatusContext)
}

export async function fetchEngineStatus(signal?: AbortSignal): Promise<EngineStatus> {
  const response = await fetch('/api/engine-status', { signal, cache: 'no-store' })
  if (!response.ok) {
    /* Without the dev middleware (a production preview, for example) there is
     * no bundled engine to wait for. */
    return { phase: 'ready' }
  }
  const body = (await response.json()) as { phase?: string; error?: string }
  if (body.phase === 'starting' || body.phase === 'error') {
    return { phase: body.phase, error: body.error }
  }
  return { phase: 'ready' }
}
