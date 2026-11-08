import type { FacetResult, FieldFilter, FilterExpression } from '@delali/narsil'
import { useCallback } from 'react'
import type { FacetRange } from '../../lib/search-request'
import { Badge } from '../ui/badge'

interface FacetSidebarProps {
  facets: Record<string, FacetResult>
  ranges: Record<string, FacetRange[]>
  filters: FilterExpression
  onFilterChange: (filters: FilterExpression) => void
}

function FacetValueButton({
  field,
  value,
  count,
  selected,
  onToggle,
}: {
  field: string
  value: string
  count: number
  selected: boolean
  onToggle: (field: string, value: string) => void
}) {
  const handleClick = useCallback(() => {
    onToggle(field, value)
  }, [onToggle, field, value])

  return (
    <button
      type="button"
      aria-pressed={selected}
      className={`flex items-center justify-between rounded-sm px-2 py-1 text-xs transition-colors hover:bg-accent ${selected ? 'bg-accent font-medium' : ''}`}
      onClick={handleClick}
    >
      <span className="truncate">{value}</span>
      <Badge variant="secondary" className="ml-2 text-[10px]">
        {count}
      </Badge>
    </button>
  )
}

function rangeLabel(range: FacetRange): string {
  return `${range.from}-${range.to}`
}

function selectedValues(filters: FilterExpression, field: string): string[] {
  const values = (filters.fields?.[field] as { in?: unknown } | undefined)?.in
  return Array.isArray(values) ? values.map(String) : []
}

function selectedRange(filters: FilterExpression, field: string): string | null {
  const test = filters.fields?.[field] as { gte?: unknown; lt?: unknown } | undefined
  if (typeof test?.gte !== 'number' || typeof test.lt !== 'number') return null
  return rangeLabel({ from: test.gte, to: test.lt })
}

function withFieldTest(filters: FilterExpression, field: string, test: FieldFilter | null): FilterExpression {
  const fields = { ...filters.fields }
  if (test === null) {
    delete fields[field]
  } else {
    fields[field] = test
  }
  return Object.keys(fields).length === 0 ? {} : { fields }
}

export function FacetSidebar({ facets, ranges, filters, onFilterChange }: FacetSidebarProps) {
  const toggleFacetValue = useCallback(
    (field: string, value: string) => {
      const fieldRanges = ranges[field]
      if (fieldRanges !== undefined) {
        const range = fieldRanges.find(entry => rangeLabel(entry) === value)
        if (range === undefined) return
        const chosen = selectedRange(filters, field) === value
        onFilterChange(withFieldTest(filters, field, chosen ? null : { gte: range.from, lt: range.to }))
        return
      }
      const current = selectedValues(filters, field)
      const next = current.includes(value) ? current.filter(entry => entry !== value) : [...current, value]
      onFilterChange(withFieldTest(filters, field, next.length === 0 ? null : { in: next }))
    },
    [filters, onFilterChange, ranges],
  )

  return (
    <div className="flex flex-col gap-4" data-testid="facet-sidebar">
      {Object.entries(facets).map(([field, facet]) => {
        const isRange = ranges[field] !== undefined
        const entries = Object.entries(facet.values)
        if (!isRange) entries.sort(([, a], [, b]) => b - a)
        if (entries.length === 0) return null
        const chosenRange = isRange ? selectedRange(filters, field) : null
        const chosenValues = isRange ? [] : selectedValues(filters, field)

        return (
          <div key={field}>
            <h4 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">{field}</h4>
            <div className="flex flex-col gap-0.5">
              {entries.map(([value, count]) => (
                <FacetValueButton
                  key={value}
                  field={field}
                  value={value}
                  count={count}
                  selected={isRange ? chosenRange === value : chosenValues.includes(value)}
                  onToggle={toggleFacetValue}
                />
              ))}
            </div>
          </div>
        )
      })}
    </div>
  )
}
