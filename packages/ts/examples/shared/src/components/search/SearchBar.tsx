import { useState, useRef } from 'react'
import { Search, Loader2 } from 'lucide-react'
import { Input } from '../ui/input'
import type { SuggestResponse } from '../../backend'

interface SearchBarProps {
  term: string
  onTermChange: (term: string) => void
  resultCount: number | null
  elapsed: number | null
  isLoading: boolean
  suggestions: SuggestResponse | null
}

export function SearchBar({
  term,
  onTermChange,
  resultCount,
  elapsed,
  isLoading,
  suggestions,
}: SearchBarProps) {
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

  const hasSuggestions = showSuggestions && suggestions && suggestions.terms.length > 0 && term.length >= 2

  return (
    <div className="relative">
      <div className="relative">
        <Search className="pointer-events-none absolute top-1/2 left-3 z-10 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          type="text"
          placeholder="Search documents..."
          value={term}
          onChange={(e) => onTermChange(e.target.value)}
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
        {elapsed !== null && (
          <span className="font-mono">{elapsed.toFixed(1)}ms</span>
        )}
      </div>

      {hasSuggestions && (
        <div className="absolute top-10 z-50 w-full rounded-md border bg-popover p-1 shadow-lg">
          {suggestions.terms.map((s) => (
            <button
              key={s.term}
              type="button"
              className="flex w-full items-center justify-between rounded-sm px-3 py-1.5 text-sm hover:bg-accent"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => handleSelect(s.term)}
            >
              <span>{s.term}</span>
              <span className="text-xs text-muted-foreground">{s.documentFrequency} docs</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
