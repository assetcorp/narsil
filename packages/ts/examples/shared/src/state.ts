import type { AppState, AppAction, TabId, TabStatus } from './types'

function computeTabStatus(state: AppState): Record<TabId, TabStatus> {
  const hasAnyIndex = state.indexes.length > 0
  const hasNonCranfieldDocs = state.indexes.some(
    (idx) => idx.datasetId !== 'cranfield' && idx.documentCount > 0
  )
  const hasCranfield = state.cranfieldLoaded

  return {
    datasets: 'ready',
    search: hasNonCranfieldDocs ? 'ready' : 'locked',
    relevance: hasNonCranfieldDocs ? 'ready' : 'locked',
    benchmark: hasCranfield ? 'ready' : 'locked',
    inspector: hasAnyIndex ? 'ready' : 'locked',
  }
}

export function createInitialState(): AppState {
  return {
    indexes: [],
    activeIndexName: null,
    loadingDatasets: new Map(),
    cranfieldLoaded: false,
    restoring: true,
    tabStatus: {
      datasets: 'ready',
      search: 'locked',
      relevance: 'locked',
      benchmark: 'locked',
      inspector: 'locked',
    },
  }
}

export function appReducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case 'SET_LOADING': {
      const next = { ...state, loadingDatasets: new Map(state.loadingDatasets) }
      next.loadingDatasets.set(action.payload.datasetId, action.payload)
      return next
    }

    case 'INDEX_READY': {
      const existing = state.indexes.filter((i) => i.name !== action.payload.name)
      const indexes = [...existing, action.payload]
      const loadingDatasets = new Map(state.loadingDatasets)
      loadingDatasets.delete(action.payload.datasetId)
      const cranfieldLoaded = state.cranfieldLoaded || action.payload.datasetId === 'cranfield'
      const next: AppState = {
        ...state,
        indexes,
        activeIndexName: state.activeIndexName ?? action.payload.name,
        loadingDatasets,
        cranfieldLoaded,
        tabStatus: state.tabStatus,
      }
      next.tabStatus = computeTabStatus(next)
      return next
    }

    case 'REMOVE_INDEX': {
      const indexes = state.indexes.filter((i) => i.name !== action.payload)
      const activeIndexName =
        state.activeIndexName === action.payload
          ? (indexes[0]?.name ?? null)
          : state.activeIndexName
      const next: AppState = { ...state, indexes, activeIndexName, tabStatus: state.tabStatus }
      next.tabStatus = computeTabStatus(next)
      return next
    }

    case 'SET_ACTIVE_INDEX': {
      return { ...state, activeIndexName: action.payload }
    }

    case 'CRANFIELD_LOADED': {
      const next: AppState = { ...state, cranfieldLoaded: true, tabStatus: state.tabStatus }
      next.tabStatus = computeTabStatus(next)
      return next
    }

    case 'LOADING_ERROR': {
      const loadingDatasets = new Map(state.loadingDatasets)
      loadingDatasets.set(action.payload.datasetId, {
        datasetId: action.payload.datasetId,
        phase: 'error',
        error: action.payload.error,
      })
      return { ...state, loadingDatasets }
    }

    case 'SET_RESTORING': {
      return { ...state, restoring: action.payload }
    }

    default:
      return state
  }
}
