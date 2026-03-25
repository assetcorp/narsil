import { BarChart3, Database, FlaskConical, Inspect, Search } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import type { SuggestResponse } from '../backend'
import { useAppDispatch, useAppState, useBackend } from '../context'
import { CommandDialog, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator } from './ui/command'

const NAV_ITEMS = [
  { to: '/', label: 'Datasets', icon: Database, tabId: 'datasets' as const },
  { to: '/search', label: 'Search', icon: Search, tabId: 'search' as const },
  { to: '/relevance', label: 'Relevance Lab', icon: FlaskConical, tabId: 'relevance' as const },
  { to: '/benchmark', label: 'Quality Benchmark', icon: BarChart3, tabId: 'benchmark' as const },
  { to: '/inspector', label: 'Index Inspector', icon: Inspect, tabId: 'inspector' as const },
]

interface CommandPaletteProps {
  navigate: (to: string) => void
}

export function CommandPalette({ navigate }: CommandPaletteProps) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [suggestions, setSuggestions] = useState<SuggestResponse['terms']>([])
  const state = useAppState()
  const dispatch = useAppDispatch()
  const backend = useBackend()

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault()
        setOpen(prev => !prev)
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [])

  useEffect(() => {
    if (!open) {
      setQuery('')
      setSuggestions([])
    }
  }, [open])

  useEffect(() => {
    if (!query.trim() || !state.activeIndexName) {
      setSuggestions([])
      return
    }

    const activeIndex = state.activeIndexName
    const timeout = setTimeout(async () => {
      try {
        const result = await backend.suggest({
          indexName: activeIndex,
          prefix: query.trim(),
          limit: 5,
        })
        setSuggestions(result.terms)
      } catch {
        setSuggestions([])
      }
    }, 150)

    return () => clearTimeout(timeout)
  }, [query, state.activeIndexName, backend])

  const handleSelect = useCallback(
    (value: string) => {
      setOpen(false)

      const navItem = NAV_ITEMS.find(item => item.to === value)
      if (navItem) {
        navigate(value)
        return
      }

      if (value.startsWith('index:')) {
        const indexName = value.replace('index:', '')
        dispatch({ type: 'SET_ACTIVE_INDEX', payload: indexName })
        return
      }

      if (value.startsWith('search:')) {
        const term = value.replace('search:', '')
        navigate(`/search?q=${encodeURIComponent(term)}`)
        return
      }
    },
    [navigate, dispatch],
  )

  const hasQuery = query.trim().length > 0

  return (
    <CommandDialog open={open} onOpenChange={setOpen}>
      <CommandInput
        placeholder="Search commands, navigate, or find content..."
        value={query}
        onValueChange={setQuery}
        autoFocus
      />
      <CommandList>
        {!hasQuery && (
          <>
            <CommandGroup heading="Navigate">
              {NAV_ITEMS.map(item => {
                const status = state.tabStatus[item.tabId]
                const locked = status === 'locked'
                return (
                  <CommandItem key={item.to} value={item.to} disabled={locked} onSelect={handleSelect}>
                    <item.icon className="size-4" />
                    <span>{item.label}</span>
                    {locked && <span className="ml-auto text-[10px] text-muted-foreground">locked</span>}
                  </CommandItem>
                )
              })}
            </CommandGroup>

            {state.indexes.length > 0 && (
              <>
                <CommandSeparator />
                <CommandGroup heading="Switch Index">
                  {state.indexes.map(idx => (
                    <CommandItem key={idx.name} value={`index:${idx.name}`} onSelect={handleSelect}>
                      <span className="font-mono text-xs">{idx.name}</span>
                      <span className="ml-auto text-[10px] text-muted-foreground">
                        {idx.documentCount.toLocaleString()} docs
                      </span>
                      {idx.name === state.activeIndexName && (
                        <span className="ml-1 size-1.5 rounded-full bg-green-500" />
                      )}
                    </CommandItem>
                  ))}
                </CommandGroup>
              </>
            )}
          </>
        )}

        {hasQuery && suggestions.length === 0 && (
          <div className="py-6 text-center text-sm text-muted-foreground">
            {state.activeIndexName ? 'Searching...' : 'Load a dataset to search'}
          </div>
        )}

        {hasQuery && suggestions.length > 0 && (
          <CommandGroup heading="Search Results">
            {suggestions.map(s => (
              <CommandItem key={s.term} value={`search:${s.term}`} onSelect={handleSelect}>
                <Search className="size-3.5" />
                <span>{s.term}</span>
                <span className="ml-auto font-mono text-[10px] text-muted-foreground">{s.documentFrequency} docs</span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}

        {hasQuery && (
          <CommandGroup>
            <CommandItem value={`search:${query.trim()}`} onSelect={handleSelect}>
              <Search className="size-3.5" />
              <span>
                Search for <span className="font-medium">{query.trim()}</span>
              </span>
            </CommandItem>
          </CommandGroup>
        )}
      </CommandList>
    </CommandDialog>
  )
}
