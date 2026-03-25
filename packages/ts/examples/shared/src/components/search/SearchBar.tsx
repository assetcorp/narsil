import { Loader2, Search } from 'lucide-react'
import { useCallback, useRef, useState } from 'react'
import type { SuggestResponse } from '../../backend'
import { Input } from '../ui/input'

interface SearchBarProps {
  term: string
  onTermChange: (term: string) => void
  resultCount: number | null
  elapsed: number | null
  isLoading: boolean
  suggestions: SuggestResponse | null
}

function SuggestionItem({
  term,
  documentFrequency,
  onSelect,
}: {
  term: string
  documentFrequency: number
  onSelect: (value: string) => void
}) {
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
  }, [])

  const handleClick = useCallback(() => {
    onSelect(term)
  }, [onSelect, term])

  return (
    <button
      type="button"
      className="flex w-full items-center justify-between rounded-sm px-3 py-1.5 text-sm hover:bg-accent"
      onMouseDown={handleMouseDown}
      onClick={handleClick}
    >
      <span>{term}</span>
      <span className="text-xs text-muted-foreground">{documentFrequency} docs</span>
    </button>
  )
}

export function SearchBar({ term, onTermChange, resultCount, elapsed, isLoading, suggestions }: SearchBarProps) {
  const [showSuggestions, setShowSuggestions] = useState(false)
  const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  function handleFocus() {
    if (blurTimer.current) {
      clearTimeout(blurTimer.current)
      blurTimer.current = null
    }
    setShowSuggestions(true)
  }

  function handleBlur() {
    blurTimer.current = setTimeout(() => setShowSuggestions(false), 150)
  }

  function handleSelect(value: string) {
    setShowSuggestions(false)
    onTermChange(value)
  }

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      onTermChange(e.target.value)
    },
    [onTermChange],
  )

  const hasSuggestions = showSuggestions && suggestions && suggestions.terms.length > 0 && term.length >= 2

  return (
    <div className="relative">
      <div className="relative">
        <Search className="pointer-events-none absolute top-1/2 left-3 z-10 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          type="text"
          placeholder="Search documents..."
          value={term}
          onChange={handleChange}
          onFocus={handleFocus}
          onBlur={handleBlur}
          className="pl-10 pr-10"
        />
        {isLoading && (
          <Loader2 className="pointer-events-none absolute top-1/2 right-3 z-10 size-4 -translate-y-1/2 animate-spin text-muted-foreground" />
        )}
      </div>

      <div className="mt-2 flex items-center gap-3 text-xs text-muted-foreground">
        {resultCount !== null && (
          <span>
            {resultCount.toLocaleString()} result{resultCount !== 1 ? 's' : ''}
          </span>
        )}
        {elapsed !== null && <span className="font-mono">{elapsed.toFixed(1)}ms</span>}
      </div>

      {hasSuggestions && (
        <div className="absolute top-10 z-50 w-full rounded-md border bg-popover p-1 shadow-lg">
          {suggestions.terms.map(s => (
            <SuggestionItem
              key={s.term}
              term={s.term}
              documentFrequency={s.documentFrequency}
              onSelect={handleSelect}
            />
          ))}
        </div>
      )}
    </div>
  )
}
