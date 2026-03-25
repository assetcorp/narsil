import { ChevronDown } from 'lucide-react'
import { useCallback } from 'react'
import type { SearchParams } from '../../hooks/use-search'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../ui/collapsible'
import { Input } from '../ui/input'
import { Slider } from '../ui/slider'

interface AdvancedOptionsProps {
  params: SearchParams
  searchableFields: string[]
  allFields: string[]
  onFieldsChange: (fields: string[]) => void
  onBoostChange: (field: string, value: number) => void
  onSortChange: (field: string, direction: 'asc' | 'desc' | null) => void
  onParamChange: <K extends keyof SearchParams>(key: K, value: SearchParams[K]) => void
}

function SearchFieldBadge({
  field,
  active,
  params,
  searchableFields,
  onFieldsChange,
}: {
  field: string
  active: boolean
  params: SearchParams
  searchableFields: string[]
  onFieldsChange: (fields: string[]) => void
}) {
  const handleClick = useCallback(() => {
    if (params.fields.length === 0) {
      onFieldsChange(searchableFields.filter(f => f !== field))
    } else if (params.fields.includes(field)) {
      const next = params.fields.filter(f => f !== field)
      onFieldsChange(next.length === searchableFields.length ? [] : next)
    } else {
      onFieldsChange([...params.fields, field])
    }
  }, [params.fields, searchableFields, field, onFieldsChange])

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
  onParamChange,
}: {
  mode: 'any' | 'all'
  active: boolean
  onParamChange: <K extends keyof SearchParams>(key: K, value: SearchParams[K]) => void
}) {
  const handleClick = useCallback(() => {
    onParamChange('termMatch', mode)
  }, [onParamChange, mode])

  return (
    <Button variant={active ? 'default' : 'outline'} size="xs" onClick={handleClick}>
      {mode}
    </Button>
  )
}

function LimitButton({
  n,
  active,
  onParamChange,
}: {
  n: number
  active: boolean
  onParamChange: <K extends keyof SearchParams>(key: K, value: SearchParams[K]) => void
}) {
  const handleClick = useCallback(() => {
    onParamChange('limit', n)
  }, [onParamChange, n])

  return (
    <Button variant={active ? 'default' : 'outline'} size="xs" onClick={handleClick}>
      {n}
    </Button>
  )
}

export function AdvancedOptions({
  params,
  searchableFields,
  allFields,
  onFieldsChange,
  onBoostChange,
  onSortChange,
  onParamChange,
}: AdvancedOptionsProps) {
  const handleToleranceChange = useCallback(
    ([v]: number[]) => {
      onParamChange('tolerance', v)
    },
    [onParamChange],
  )

  const handleExactToggle = useCallback(() => {
    onParamChange('exact', !params.exact)
  }, [onParamChange, params.exact])

  const handleMinScoreChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      onParamChange('minScore', parseFloat(e.target.value) || 0)
    },
    [onParamChange],
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
                const active = params.fields.length === 0 || params.fields.includes(field)
                return (
                  <SearchFieldBadge
                    key={field}
                    field={field}
                    active={active}
                    params={params}
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
                  boost={params.boost[field] ?? 1}
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
                value={[params.tolerance]}
                onValueChange={handleToleranceChange}
                className="flex-1"
              />
              <span className="w-4 text-right font-mono text-xs">{params.tolerance}</span>
            </div>
          </div>

          <div>
            <span className="mb-1.5 block text-xs font-medium">Term match</span>
            <div className="flex gap-1">
              {(['any', 'all'] as const).map(mode => (
                <TermMatchButton
                  key={mode}
                  mode={mode}
                  active={params.termMatch === mode}
                  onParamChange={onParamChange}
                />
              ))}
            </div>
          </div>

          <div>
            <span className="mb-1.5 block text-xs font-medium">Exact match</span>
            <Button variant={params.exact ? 'default' : 'outline'} size="xs" onClick={handleExactToggle}>
              {params.exact ? 'On' : 'Off'}
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
              value={params.minScore || ''}
              onChange={handleMinScoreChange}
              className="h-7 text-xs"
              placeholder="0"
            />
          </div>

          <div>
            <span className="mb-1.5 block text-xs font-medium">Sort by</span>
            <div className="flex flex-wrap gap-1">
              {allFields
                .filter(f => !searchableFields.includes(f))
                .map(field => {
                  const dir = params.sort[field]
                  return <SortBadge key={field} field={field} dir={dir} onSortChange={onSortChange} />
                })}
            </div>
          </div>

          <div>
            <span className="mb-1.5 block text-xs font-medium">Results per page</span>
            <div className="flex gap-1">
              {[10, 20, 50].map(n => (
                <LimitButton key={n} n={n} active={params.limit === n} onParamChange={onParamChange} />
              ))}
            </div>
          </div>
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}
