import { type ChangeEvent, useCallback, useMemo } from 'react'
import type { ListSortMode, SearchFormValues } from '../../hooks/use-search-form'
import { isArrayField, type SchemaField } from '../../lib/field-filters'
import { parseFacetRanges } from '../../lib/search-request'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'

type ValueSetter = <K extends keyof SearchFormValues>(key: K, value: SearchFormValues[K]) => void

interface ResultOptionsProps {
  values: SearchFormValues
  fields: SchemaField[]
  searchableFields: string[]
  sortableFields: string[]
  groupTotals: boolean
  canRerank: boolean
  onSortChange: (field: string, direction: 'asc' | 'desc' | null) => void
  onValueChange: ValueSetter
}

const NO_FIELD = 'none'
const LIST_SORT_MODES: ListSortMode[] = ['min', 'max', 'avg', 'median']
const MAX_PINNED_POSITION = 99
const RESULTS_PER_PAGE_CHOICES = [10, 20, 50]

function countable(field: SchemaField): boolean {
  if (field.type === 'string' || field.type === 'string[]') return field.pattern
  return true
}

function FieldSelect({
  label,
  value,
  paths,
  onChange,
}: {
  label: string
  value: string
  paths: string[]
  onChange: (path: string) => void
}) {
  const handleChange = useCallback(
    (next: string) => {
      onChange(next === NO_FIELD ? '' : next)
    },
    [onChange],
  )

  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs font-medium">{label}</span>
      <Select value={value.length === 0 ? NO_FIELD : value} onValueChange={handleChange}>
        <SelectTrigger className="h-7 w-full text-xs" aria-label={label}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NO_FIELD} className="text-xs">
            None
          </SelectItem>
          {paths.map(path => (
            <SelectItem key={path} value={path} className="font-mono text-xs">
              {path}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}

function SortBadge({
  field,
  dir,
  onSortChange,
}: {
  field: string
  dir: 'asc' | 'desc' | undefined
  onSortChange: (field: string, direction: 'asc' | 'desc' | null) => void
}) {
  const handleClick = useCallback(() => {
    if (!dir) onSortChange(field, 'desc')
    else if (dir === 'desc') onSortChange(field, 'asc')
    else onSortChange(field, null)
  }, [dir, field, onSortChange])

  return (
    <Badge variant={dir ? 'default' : 'outline'} className="cursor-pointer text-[10px]" onClick={handleClick}>
      {field} {dir === 'asc' ? '↑' : dir === 'desc' ? '↓' : ''}
    </Badge>
  )
}

function LimitButton({ n, active, onValueChange }: { n: number; active: boolean; onValueChange: ValueSetter }) {
  const handleClick = useCallback(() => {
    onValueChange('limit', n)
  }, [onValueChange, n])

  return (
    <Button variant={active ? 'default' : 'outline'} size="xs" onClick={handleClick}>
      {n}
    </Button>
  )
}

export function ResultOptions({
  values,
  fields,
  searchableFields,
  sortableFields,
  groupTotals,
  canRerank,
  onSortChange,
  onValueChange,
}: ResultOptionsProps) {
  const facetPaths = useMemo(() => fields.filter(countable).map(field => field.path), [fields])
  const rangePaths = useMemo(
    () =>
      new Set(fields.filter(field => field.type === 'number' || field.type === 'number[]').map(field => field.path)),
    [fields],
  )
  const groupPaths = useMemo(
    () => fields.filter(field => countable(field) && !isArrayField(field.type)).map(field => field.path),
    [fields],
  )
  const totalPaths = useMemo(() => fields.filter(field => field.type === 'number').map(field => field.path), [fields])
  const listPaths = useMemo(() => fields.filter(field => field.type === 'number[]').map(field => field.path), [fields])
  const sortPaths = useMemo(
    () => sortableFields.filter(field => !searchableFields.includes(field)),
    [sortableFields, searchableFields],
  )

  const rangeProblem = useMemo(() => {
    const parsed = parseFacetRanges(values.facetRanges)
    return typeof parsed === 'string' ? parsed : null
  }, [values.facetRanges])

  const handleFacetField = useCallback(
    (path: string) => {
      onValueChange('facetField', path)
      if (!rangePaths.has(path)) onValueChange('facetRanges', '')
    },
    [onValueChange, rangePaths],
  )

  const handleFacetRanges = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      onValueChange('facetRanges', event.target.value)
    },
    [onValueChange],
  )

  const handleGroupField = useCallback(
    (path: string) => {
      onValueChange('groupField', path)
      if (path.length === 0) onValueChange('groupTotalField', '')
    },
    [onValueChange],
  )

  const handleGroupTotal = useCallback(
    (path: string) => {
      onValueChange('groupTotalField', path)
    },
    [onValueChange],
  )

  const handleListField = useCallback(
    (path: string) => {
      onValueChange('listSort', path.length === 0 ? null : { field: path, direction: 'desc', mode: 'max' })
    },
    [onValueChange],
  )

  const handleListMode = useCallback(
    (mode: string) => {
      if (values.listSort === null) return
      onValueChange('listSort', { ...values.listSort, mode: mode as ListSortMode })
    },
    [onValueChange, values.listSort],
  )

  const handleListDirection = useCallback(() => {
    if (values.listSort === null) return
    const direction = values.listSort.direction === 'desc' ? 'asc' : 'desc'
    onValueChange('listSort', { ...values.listSort, direction })
  }, [onValueChange, values.listSort])

  const handlePinnedId = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      onValueChange('pinnedId', event.target.value)
    },
    [onValueChange],
  )

  const handlePinnedPosition = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const parsed = Math.round(Number(event.target.value))
      const position = Number.isFinite(parsed) ? Math.min(MAX_PINNED_POSITION, Math.max(0, parsed - 1)) : 0
      onValueChange('pinnedPosition', position)
    },
    [onValueChange],
  )

  const handleRerankToggle = useCallback(() => {
    onValueChange('rerank', !values.rerank)
  }, [onValueChange, values.rerank])

  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3" data-testid="ranking-options">
      <div className="flex flex-col gap-2">
        <FieldSelect label="Count values of" value={values.facetField} paths={facetPaths} onChange={handleFacetField} />
        {rangePaths.has(values.facetField) ? (
          <label htmlFor="facet-ranges" className="flex flex-col gap-1 text-xs">
            Ranges, such as 0 to 100000, 100000 to 1000000
            <Input
              id="facet-ranges"
              value={values.facetRanges}
              onChange={handleFacetRanges}
              aria-invalid={rangeProblem !== null}
              className="h-7 text-xs"
            />
            {rangeProblem === null ? null : <span className="text-destructive">{rangeProblem}</span>}
          </label>
        ) : null}
      </div>

      <div className="flex flex-col gap-2">
        <FieldSelect label="Group by" value={values.groupField} paths={groupPaths} onChange={handleGroupField} />
        {groupTotals && values.groupField.length > 0 ? (
          <FieldSelect
            label="Group total of"
            value={values.groupTotalField}
            paths={totalPaths}
            onChange={handleGroupTotal}
          />
        ) : null}
        {!groupTotals && values.groupField.length > 0 ? (
          <span className="text-xs text-muted-foreground">
            Group totals take a reduce function, which an HTTP request cannot carry, so try them in the browser app.
          </span>
        ) : null}
      </div>

      {sortPaths.length > 0 ? (
        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-medium">Sort by</span>
          <div className="flex flex-wrap gap-1">
            {sortPaths.map(field => (
              <SortBadge key={field} field={field} dir={values.sort[field]} onSortChange={onSortChange} />
            ))}
          </div>
        </div>
      ) : null}

      {listPaths.length > 0 ? (
        <div className="flex flex-col gap-2">
          <FieldSelect
            label="Sort by list field"
            value={values.listSort?.field ?? ''}
            paths={listPaths}
            onChange={handleListField}
          />
          {values.listSort === null ? null : (
            <div className="flex items-center gap-2">
              <Select value={values.listSort.mode} onValueChange={handleListMode}>
                <SelectTrigger className="h-7 w-28 text-xs" aria-label="List value to sort by">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {LIST_SORT_MODES.map(mode => (
                    <SelectItem key={mode} value={mode} className="text-xs">
                      {mode}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button variant="outline" size="xs" onClick={handleListDirection}>
                {values.listSort.direction === 'desc' ? 'Highest first' : 'Lowest first'}
              </Button>
            </div>
          )}
        </div>
      ) : null}

      <div className="flex flex-col gap-1.5">
        <span className="text-xs font-medium">Results per page</span>
        <div className="flex gap-1">
          {RESULTS_PER_PAGE_CHOICES.map(n => (
            <LimitButton key={n} n={n} active={values.limit === n} onValueChange={onValueChange} />
          ))}
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-xs font-medium">Pin a document</span>
        <div className="flex items-center gap-2">
          <Input
            value={values.pinnedId}
            onChange={handlePinnedId}
            placeholder="Document ID"
            aria-label="Pinned document ID"
            className="h-9 font-mono text-xs"
          />
          <Input
            type="number"
            min="1"
            max={MAX_PINNED_POSITION + 1}
            value={values.pinnedPosition + 1}
            onChange={handlePinnedPosition}
            aria-label="Pinned position"
            className="h-9 w-20 text-xs"
          />
        </div>
      </div>

      {canRerank ? (
        <div className="flex flex-col gap-2">
          <span className="text-xs font-medium">Rerank with a cross-encoder</span>
          <Button
            variant={values.rerank ? 'default' : 'outline'}
            size="xs"
            className="h-9 self-start px-3"
            aria-pressed={values.rerank}
            aria-label="Rerank with a cross-encoder"
            onClick={handleRerankToggle}
          >
            {values.rerank ? 'On' : 'Off'}
          </Button>
          <span className="text-[10px] text-muted-foreground">The model downloads on the first reranked search.</span>
        </div>
      ) : null}
    </div>
  )
}
