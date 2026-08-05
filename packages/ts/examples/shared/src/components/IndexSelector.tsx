import { type Dispatch, useCallback } from 'react'
import type { AppAction, LoadedIndex } from '../types'
import { Button } from './ui/button'

interface IndexButtonProps {
  index: LoadedIndex
  isActive: boolean
  dispatch: Dispatch<AppAction>
}

function IndexButton({ index, isActive, dispatch }: IndexButtonProps) {
  const handleClick = useCallback(() => {
    dispatch({ type: 'SET_ACTIVE_INDEX', payload: index.name })
  }, [dispatch, index.name])

  return (
    <Button
      type="button"
      variant={isActive ? 'default' : 'outline'}
      size="xs"
      className="font-mono text-xs"
      onClick={handleClick}
    >
      {index.name}
    </Button>
  )
}

interface IndexSelectorProps {
  indexes: LoadedIndex[]
  activeIndexName: string | null
  dispatch: Dispatch<AppAction>
}

export function IndexSelector({ indexes, activeIndexName, dispatch }: IndexSelectorProps) {
  if (indexes.length < 2) return null

  return (
    <div className="mb-4 flex flex-wrap gap-1.5">
      {indexes.map(index => (
        <IndexButton key={index.name} index={index} isActive={index.name === activeIndexName} dispatch={dispatch} />
      ))}
    </div>
  )
}
