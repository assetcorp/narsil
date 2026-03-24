import { createContext, useContext, type Dispatch } from 'react'
import type { NarsilBackend } from './backend'
import type { AppState, AppAction } from './types'

export const BackendContext = createContext<NarsilBackend | null>(null)

export const AppStateContext = createContext<AppState | null>(null)

export const AppDispatchContext = createContext<Dispatch<AppAction> | null>(null)

export function useBackend(): NarsilBackend {
  const backend = useContext(BackendContext)
  if (backend === null) {
    throw new Error('useBackend must be used within a BackendContext.Provider')
  }
  return backend
}

export function useAppState(): AppState {
  const state = useContext(AppStateContext)
  if (state === null) {
    throw new Error('useAppState must be used within an AppStateContext.Provider')
  }
  return state
}

export function useAppDispatch(): Dispatch<AppAction> {
  const dispatch = useContext(AppDispatchContext)
  if (dispatch === null) {
    throw new Error('useAppDispatch must be used within an AppDispatchContext.Provider')
  }
  return dispatch
}
