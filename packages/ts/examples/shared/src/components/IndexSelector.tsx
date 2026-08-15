import { useCallback } from 'react'
import type { LoadedIndex } from '../types'
import { useIndexWorkspace } from '../workspace'
import { Button } from './ui/button'

interface IndexButtonProps {
  index: LoadedIndex
  isActive: boolean
  onSelect: (indexName: string) => void
}

function IndexButton({ index, isActive, onSelect }: IndexButtonProps) {
  const handleClick = useCallback(() => {
    onSelect(index.name)
  }, [onSelect, index.name])

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

export function IndexSelector({ indexes }: { indexes?: LoadedIndex[] }) {
  const workspace = useIndexWorkspace()
  const shown = indexes ?? workspace.indexes
  if (shown.length < 2) return null

  return (
    <div className="mb-4 flex flex-wrap gap-1.5">
      {shown.map(index => (
        <IndexButton
          key={index.name}
          index={index}
          isActive={index.name === workspace.activeIndexName}
          onSelect={workspace.setActiveIndexName}
        />
      ))}
    </div>
  )
}
