import { Blend, Sparkles, WholeWord } from 'lucide-react'
import { useCallback } from 'react'
import { Tabs, TabsList, TabsTrigger } from '#/components/ui/tabs'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '#/components/ui/tooltip'
import { RETRIEVAL_MODE_OPTIONS, type RetrievalModeOption } from '#/lib/ask/client'
import type { RetrievalMode } from '#/lib/ask/types'

const MODE_ICONS: Record<RetrievalMode, typeof WholeWord> = {
  keyword: WholeWord,
  semantic: Sparkles,
  hybrid: Blend,
}

interface ModeTriggerProps {
  option: RetrievalModeOption
  disabled: boolean
  disabledReason: string | null
}

function ModeTrigger({ option, disabled, disabledReason }: ModeTriggerProps) {
  const Icon = MODE_ICONS[option.id]

  const trigger = (
    <TabsTrigger value={option.id} disabled={disabled} className="gap-1.5 px-3 text-xs">
      <Icon className="size-3.5" />
      {option.label}
    </TabsTrigger>
  )

  return (
    <Tooltip>
      {/* A disabled trigger fires no pointer events, so the tooltip wraps a span */}
      <TooltipTrigger asChild>
        <span className="inline-flex">{trigger}</span>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="max-w-64">
        <p>{disabled && disabledReason ? disabledReason : option.description}</p>
      </TooltipContent>
    </Tooltip>
  )
}

interface ModeToggleProps {
  mode: RetrievalMode
  onModeChange: (mode: RetrievalMode) => void
  /** Explanation for why vector modes are unavailable; null when they work. */
  vectorModesDisabledReason: string | null
}

export function ModeToggle({ mode, onModeChange, vectorModesDisabledReason }: ModeToggleProps) {
  const handleValueChange = useCallback(
    (value: string) => {
      onModeChange(value as RetrievalMode)
    },
    [onModeChange],
  )

  return (
    <TooltipProvider delayDuration={150}>
      <Tabs value={mode} onValueChange={handleValueChange}>
        <TabsList>
          {RETRIEVAL_MODE_OPTIONS.map(option => (
            <ModeTrigger
              key={option.id}
              option={option}
              disabled={option.id !== 'keyword' && vectorModesDisabledReason !== null}
              disabledReason={vectorModesDisabledReason}
            />
          ))}
        </TabsList>
      </Tabs>
    </TooltipProvider>
  )
}
