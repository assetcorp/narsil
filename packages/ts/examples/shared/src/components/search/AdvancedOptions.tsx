import { ChevronDown } from 'lucide-react'
import { useCallback } from 'react'
import type { SearchFormValues } from '../../hooks/use-search-form'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../ui/collapsible'
import { Input } from '../ui/input'
import { Slider } from '../ui/slider'

interface AdvancedOptionsProps {
  values: SearchFormValues
  searchableFields: string[]
  sortableFields: string[]
  onFieldsChange: (fields: string[]) => void
  onBoostChange: (field: string, value: number) => void
  onSortChange: (field: string, direction: 'asc' | 'desc' | null) => void
  onValueChange: <K extends keyof SearchFormValues>(key: K, value: SearchFormValues[K]) => void
}

function SearchFieldBadge({
  field,
  active,
  values,
  searchableFields,
  onFieldsChange,
}: {
  field: string
  active: boolean
  values: SearchFormValues
  searchableFields: string[]
  onFieldsChange: (fields: string[]) => void
}) {
  const handleClick = useCallback(() => {
    if (values.fields.length === 0) {
      onFieldsChange(searchableFields.filter(f => f !== field))
    } else if (values.fields.includes(field)) {
      const next = values.fields.filter(f => f !== field)
      onFieldsChange(next.length === searchableFields.length ? [] : next)
    } else {
      onFieldsChange([...values.fields, field])
    }
  }, [values.fields, searchableFields, field, onFieldsChange])

  return (
    <Badge variant={active ? 'default' : 'outline'} className="cursor-pointer text-[10px]" onClick={handleClick}>
      {field}
    </Badge>
  )
}

function FieldBoostRow({
  field,
  boost,
  onBoostChange,
}: {
  field: string
  boost: number
  onBoostChange: (field: string, value: number) => void
}) {
  const handleValueChange = useCallback(
    ([v]: number[]) => {
      onBoostChange(field, v)
    },
    [onBoostChange, field],
  )

  return (
    <div className="flex items-center gap-2">
      <span className="w-16 truncate text-xs text-muted-foreground">{field}</span>
      <Slider min={0} max={5} step={0.5} value={[boost]} onValueChange={handleValueChange} className="flex-1" />
      <span className="w-6 text-right font-mono text-[10px]">{boost.toFixed(1)}</span>
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
      {field} {dir === 'asc' ? '\u2191' : dir === 'desc' ? '\u2193' : ''}
    </Badge>
  )
}

function TermMatchButton({
  mode,
  active,
  onValueChange,
}: {
  mode: 'any' | 'all'
  active: boolean
  onValueChange: <K extends keyof SearchFormValues>(key: K, value: SearchFormValues[K]) => void
}) {
  const handleClick = useCallback(() => {
    onValueChange('termMatch', mode)
  }, [onValueChange, mode])

  return (
    <Button variant={active ? 'default' : 'outline'} size="xs" onClick={handleClick}>
      {mode}
    </Button>
  )
}

function LimitButton({
  n,
  active,
  onValueChange,
}: {
  n: number
  active: boolean
  onValueChange: <K extends keyof SearchFormValues>(key: K, value: SearchFormValues[K]) => void
}) {
  const handleClick = useCallback(() => {
    onValueChange('limit', n)
  }, [onValueChange, n])

  return (
    <Button variant={active ? 'default' : 'outline'} size="xs" onClick={handleClick}>
      {n}
    </Button>
  )
}

export function AdvancedOptions({
  values,
  searchableFields,
  sortableFields,
  onFieldsChange,
  onBoostChange,
  onSortChange,
  onValueChange,
}: AdvancedOptionsProps) {
  const handleToleranceChange = useCallback(
    ([v]: number[]) => {
      onValueChange('tolerance', v)
    },
    [onValueChange],
  )

  const handleExactToggle = useCallback(() => {
    onValueChange('exact', !values.exact)
  }, [onValueChange, values.exact])

  const handleMinScoreChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      onValueChange('minScore', parseFloat(e.target.value) || 0)
    },
    [onValueChange],
  )

  return (
    <Collapsible className="mt-4">
      <CollapsibleTrigger className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground [&[data-state=open]>svg]:rotate-180">
        <ChevronDown className="size-3.5 transition-transform" />
        Advanced options
      </CollapsibleTrigger>

      <CollapsibleContent>
        <div className="mt-3 grid gap-4 rounded-lg border p-4 sm:grid-cols-2 lg:grid-cols-3">
          <div>
            <span className="mb-1.5 block text-xs font-medium">Search fields</span>
            <div className="flex flex-wrap gap-1">
              {searchableFields.map(field => {
                const active = values.fields.length === 0 || values.fields.includes(field)
                return (
                  <SearchFieldBadge
                    key={field}
                    field={field}
                    active={active}
                    values={values}
                    searchableFields={searchableFields}
                    onFieldsChange={onFieldsChange}
                  />
                )
              })}
            </div>
          </div>

          <div>
            <span className="mb-1.5 block text-xs font-medium">Field boosts</span>
            <div className="flex flex-col gap-2.5">
              {searchableFields.map(field => (
                <FieldBoostRow
                  key={field}
                  field={field}
                  boost={values.boost[field] ?? 1}
                  onBoostChange={onBoostChange}
                />
              ))}
            </div>
          </div>

          <div>
            <span className="mb-1.5 block text-xs font-medium">Fuzzy tolerance</span>
            <div className="flex items-center gap-2">
              <Slider
                min={0}
                max={3}
                step={1}
                value={[values.tolerance]}
                onValueChange={handleToleranceChange}
                className="flex-1"
              />
              <span className="w-4 text-right font-mono text-xs">{values.tolerance}</span>
            </div>
          </div>

          <div>
            <span className="mb-1.5 block text-xs font-medium">Term match</span>
            <div className="flex gap-1">
              {(['any', 'all'] as const).map(mode => (
                <TermMatchButton
                  key={mode}
                  mode={mode}
                  active={values.termMatch === mode}
                  onValueChange={onValueChange}
                />
              ))}
            </div>
          </div>

          <div>
            <span className="mb-1.5 block text-xs font-medium">Exact match</span>
            <Button variant={values.exact ? 'default' : 'outline'} size="xs" onClick={handleExactToggle}>
              {values.exact ? 'On' : 'Off'}
            </Button>
          </div>

          <div>
            <label htmlFor="min-score" className="mb-1.5 block text-xs font-medium">
              Min score
            </label>
            <Input
              id="min-score"
              type="number"
              min="0"
              step="0.1"
              value={values.minScore || ''}
              onChange={handleMinScoreChange}
              className="h-7 text-xs"
              placeholder="0"
            />
          </div>

          <div>
            <span className="mb-1.5 block text-xs font-medium">Sort by</span>
            <div className="flex flex-wrap gap-1">
              {sortableFields
                .filter(f => !searchableFields.includes(f))
                .map(field => {
                  const dir = values.sort[field]
                  return <SortBadge key={field} field={field} dir={dir} onSortChange={onSortChange} />
                })}
            </div>
          </div>

          <div>
            <span className="mb-1.5 block text-xs font-medium">Results per page</span>
            <div className="flex gap-1">
              {[10, 20, 50].map(n => (
                <LimitButton key={n} n={n} active={values.limit === n} onValueChange={onValueChange} />
              ))}
            </div>
          </div>
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}
