import type { SuggestResult } from '@delali/narsil'
import { BarChart3, Database, FileText, FlaskConical, Inspect, MessagesSquare, Search } from 'lucide-react'
import type { ReactNode } from 'react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { CommandPaletteContext, type CommandPaletteControls, useCommandPalette } from '../context'
import { useSuggestRunner } from '../query-runner'
import type { LoadedIndex } from '../types'
import { useIndexWorkspace } from '../workspace'
import { CommandDialog, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator } from './ui/command'

const NAV_ITEMS = [
  { to: '/', label: 'Datasets', icon: Database, tabId: 'datasets' as const },
  { to: '/search', label: 'Search', icon: Search, tabId: 'search' as const },
  { to: '/ask', label: 'Ask', icon: MessagesSquare, tabId: 'ask' as const },
  { to: '/relevance', label: 'Relevance Lab', icon: FlaskConical, tabId: 'relevance' as const },
  { to: '/benchmark', label: 'Quality Benchmark', icon: BarChart3, tabId: 'benchmark' as const },
  { to: '/inspector', label: 'Index Inspector', icon: Inspect, tabId: 'inspector' as const },
  { to: '/documents', label: 'Documents', icon: FileText, tabId: 'documents' as const },
]

interface IndexSuggestions {
  indexName: string
  terms: SuggestResult['terms']
}

function PaletteNavRow({
  item,
  locked,
  onNavigate,
}: {
  item: (typeof NAV_ITEMS)[number]
  locked: boolean
  onNavigate: (to: string) => void
}) {
  const Icon = item.icon
  const handleSelect = useCallback(() => onNavigate(item.to), [onNavigate, item.to])
  return (
    <CommandItem value={item.to} disabled={locked} onSelect={handleSelect}>
      <Icon className="size-4" />
      <span>{item.label}</span>
      {locked && <span className="ml-auto text-[10px] text-muted-foreground">locked</span>}
    </CommandItem>
  )
}

function PaletteIndexRow({
  index,
  active,
  onSwitch,
}: {
  index: LoadedIndex
  active: boolean
  onSwitch: (name: string) => void
}) {
  const handleSelect = useCallback(() => onSwitch(index.name), [onSwitch, index.name])
  return (
    <CommandItem value={`index-${index.name}`} onSelect={handleSelect}>
      <span className="font-mono text-xs">{index.name}</span>
      <span className="ml-auto text-[10px] text-muted-foreground">{index.documentCount.toLocaleString()} docs</span>
      {active && <span className="ml-1 size-1.5 rounded-full bg-chart-2" />}
    </CommandItem>
  )
}

function PaletteSuggestionRow({
  indexName,
  term,
  documentFrequency,
  onPick,
}: {
  indexName: string
  term: string
  documentFrequency: number
  onPick: (indexName: string, term: string) => void
}) {
  const handleSelect = useCallback(() => onPick(indexName, term), [onPick, indexName, term])
  return (
    <CommandItem value={`${indexName}-${term}`} onSelect={handleSelect}>
      <Search className="size-3.5" />
      <span>{term}</span>
      <span className="ml-auto font-mono text-[10px] text-muted-foreground">{documentFrequency} docs</span>
    </CommandItem>
  )
}

function PaletteSearchRow({ term, onSearch }: { term: string; onSearch: (term: string) => void }) {
  const handleSelect = useCallback(() => onSearch(term), [onSearch, term])
  return (
    <CommandItem value={`search-${term}`} onSelect={handleSelect}>
      <Search className="size-3.5" />
      <span>
        Search for <span className="font-medium">{term}</span>
      </span>
    </CommandItem>
  )
}

interface CommandPaletteViewProps {
  navigate: (to: string) => void
  /** Runs a search for the given term on the Search page, passing it as a typed route search param. */
  onSearch: (term: string) => void
  /** Tabs the host app routes; nav items outside this list are hidden. */
  availableTabs?: readonly string[]
}

function CommandPaletteView({ navigate, onSearch, availableTabs }: CommandPaletteViewProps) {
  const { open, setOpen } = useCommandPalette()
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<IndexSuggestions[]>([])
  const [loading, setLoading] = useState(false)
  const { indexes, activeIndexName, setActiveIndexName, tabStatus } = useIndexWorkspace()
  const suggest = useSuggestRunner()

  useEffect(() => {
    if (!open) {
      setQuery('')
      setResults([])
      setLoading(false)
    }
  }, [open])

  useEffect(() => {
    const term = query.trim()
    if (!term || indexes.length === 0) {
      setResults([])
      setLoading(false)
      return
    }

    const controller = new AbortController()
    setLoading(true)
    const timeout = setTimeout(() => {
      Promise.all(
        indexes.map(index =>
          suggest(index.name, { prefix: term, limit: 5 }, controller.signal)
            .then(result => ({ indexName: index.name, terms: result.terms }))
            .catch(() => ({ indexName: index.name, terms: [] as SuggestResult['terms'] })),
        ),
      ).then(groups => {
        if (controller.signal.aborted) return
        setResults(groups.filter(group => group.terms.length > 0))
        setLoading(false)
      })
    }, 150)

    return () => {
      controller.abort()
      clearTimeout(timeout)
    }
  }, [query, indexes, suggest])

  const handleNavigate = useCallback(
    (to: string) => {
      setOpen(false)
      navigate(to)
    },
    [navigate, setOpen],
  )

  const handlePickSuggestion = useCallback(
    (indexName: string, term: string) => {
      setOpen(false)
      setActiveIndexName(indexName)
      onSearch(term)
    },
    [onSearch, setActiveIndexName, setOpen],
  )

  const handleSearchTerm = useCallback(
    (term: string) => {
      setOpen(false)
      onSearch(term)
    },
    [onSearch, setOpen],
  )

  const term = query.trim()
  const hasQuery = term.length > 0
  const visibleNav = NAV_ITEMS.filter(item => !availableTabs || availableTabs.includes(item.tabId))

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
              {visibleNav.map(item => (
                <PaletteNavRow
                  key={item.to}
                  item={item}
                  locked={tabStatus[item.tabId] === 'locked'}
                  onNavigate={handleNavigate}
                />
              ))}
            </CommandGroup>

            {indexes.length > 0 && (
              <>
                <CommandSeparator />
                <CommandGroup heading="Switch Index">
                  {indexes.map(index => (
                    <PaletteIndexRow
                      key={index.name}
                      index={index}
                      active={index.name === activeIndexName}
                      onSwitch={setActiveIndexName}
                    />
                  ))}
                </CommandGroup>
              </>
            )}
          </>
        )}

        {hasQuery && loading && results.length === 0 && (
          <div className="py-6 text-center text-sm text-muted-foreground">Searching…</div>
        )}

        {hasQuery && !loading && results.length === 0 && (
          <div className="py-6 text-center text-sm text-muted-foreground">
            {indexes.length === 0 ? 'Load a dataset to search' : `No matches for "${term}"`}
          </div>
        )}

        {hasQuery &&
          results.length > 0 &&
          results.map(group => (
            <CommandGroup key={group.indexName} heading={group.indexName}>
              {group.terms.map(suggestion => (
                <PaletteSuggestionRow
                  key={`${group.indexName}-${suggestion.term}`}
                  indexName={group.indexName}
                  term={suggestion.term}
                  documentFrequency={suggestion.documentFrequency}
                  onPick={handlePickSuggestion}
                />
              ))}
            </CommandGroup>
          ))}

        {hasQuery && (
          <CommandGroup>
            <PaletteSearchRow term={term} onSearch={handleSearchTerm} />
          </CommandGroup>
        )}
      </CommandList>
    </CommandDialog>
  )
}

interface CommandPaletteProviderProps extends CommandPaletteViewProps {
  children: ReactNode
}

export function CommandPaletteProvider({ navigate, onSearch, availableTabs, children }: CommandPaletteProviderProps) {
  const [open, setOpen] = useState(false)

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key === 'k') {
        event.preventDefault()
        setOpen(prev => !prev)
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [])

  const controls = useMemo<CommandPaletteControls>(() => ({ open, setOpen }), [open])

  return (
    <CommandPaletteContext value={controls}>
      {children}
      <CommandPaletteView navigate={navigate} onSearch={onSearch} availableTabs={availableTabs} />
    </CommandPaletteContext>
  )
}
