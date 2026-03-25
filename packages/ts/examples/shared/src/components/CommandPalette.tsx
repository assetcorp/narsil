import { BarChart3, Database, FlaskConical, Inspect, Search } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import type { SuggestResponse } from '../backend'
import { useAppDispatch, useAppState, useBackend } from '../context'
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from './ui/command'

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

    const timeout = setTimeout(async () => {
      try {
        const result = await backend.suggest({
          indexName: state.activeIndexName,
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
        navigate('/search')
        return
      }
    },
    [navigate, dispatch],
  )

  return (
    <CommandDialog open={open} onOpenChange={setOpen}>
      <CommandInput
        placeholder="Search commands, navigate, or find content..."
        value={query}
        onValueChange={setQuery}
      />
      <CommandList>
        <CommandEmpty>No results found.</CommandEmpty>

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
                  {idx.name === state.activeIndexName && <span className="ml-1 size-1.5 rounded-full bg-green-500" />}
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}

        {suggestions.length > 0 && (
          <>
            <CommandSeparator />
            <CommandGroup heading="Quick Search">
              {suggestions.map(s => (
                <CommandItem key={s.term} value={`search:${s.term}`} onSelect={handleSelect}>
                  <Search className="size-3.5" />
                  <span>{s.term}</span>
                  <span className="ml-auto font-mono text-[10px] text-muted-foreground">
                    {s.documentFrequency} docs
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}
      </CommandList>
    </CommandDialog>
  )
}
