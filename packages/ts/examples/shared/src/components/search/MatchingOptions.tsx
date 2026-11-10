import { useCallback } from 'react'
import type { SearchFormValues } from '../../hooks/use-search-form'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Slider } from '../ui/slider'

type ValueSetter = <K extends keyof SearchFormValues>(key: K, value: SearchFormValues[K]) => void

interface MatchingOptionsProps {
  values: SearchFormValues
  searchableFields: string[]
  onFieldsChange: (fields: string[]) => void
  onBoostChange: (field: string, value: number) => void
  onValueChange: ValueSetter
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

function TermMatchButton({
  mode,
  active,
  onValueChange,
}: {
  mode: 'any' | 'all'
  active: boolean
  onValueChange: ValueSetter
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

type BooleanOptionKey = 'exact' | 'prefix' | 'partialWords'

function BooleanOption({
  label,
  optionKey,
  active,
  onValueChange,
}: {
  label: string
  optionKey: BooleanOptionKey
  active: boolean
  onValueChange: ValueSetter
}) {
  const handleClick = useCallback(() => {
    onValueChange(optionKey, !active)
  }, [onValueChange, optionKey, active])

  return (
    <div>
      <span className="mb-1.5 block text-xs font-medium">{label}</span>
      <Button
        variant={active ? 'default' : 'outline'}
        size="xs"
        aria-pressed={active}
        aria-label={label}
        onClick={handleClick}
      >
        {active ? 'On' : 'Off'}
      </Button>
    </div>
  )
}

export function MatchingOptions({
  values,
  searchableFields,
  onFieldsChange,
  onBoostChange,
  onValueChange,
}: MatchingOptionsProps) {
  const handleToleranceChange = useCallback(
    ([v]: number[]) => {
      onValueChange('tolerance', v)
    },
    [onValueChange],
  )

  const handleMinScoreChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      onValueChange('minScore', parseFloat(e.target.value) || 0)
    },
    [onValueChange],
  )

  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3" data-testid="matching-options">
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
            <FieldBoostRow key={field} field={field} boost={values.boost[field] ?? 1} onBoostChange={onBoostChange} />
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
            <TermMatchButton key={mode} mode={mode} active={values.termMatch === mode} onValueChange={onValueChange} />
          ))}
        </div>
        <p className="mt-1.5 text-xs text-muted-foreground">
          Put words in double quotes, such as "new york", to match them as a phrase.
        </p>
      </div>

      <BooleanOption label="Exact match" optionKey="exact" active={values.exact} onValueChange={onValueChange} />
      <BooleanOption label="Prefix match" optionKey="prefix" active={values.prefix} onValueChange={onValueChange} />
      <BooleanOption
        label="Partial words"
        optionKey="partialWords"
        active={values.partialWords}
        onValueChange={onValueChange}
      />

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
    </div>
  )
}
