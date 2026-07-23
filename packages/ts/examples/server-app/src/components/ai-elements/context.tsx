'use client'

import type { LanguageModelUsage } from 'ai'
import { type ComponentProps, createContext, useContext } from 'react'
import { getUsage } from 'tokenlens'
import { openaiModels } from 'tokenlens/providers/openai'
import { Button } from '#/components/ui/button.tsx'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '#/components/ui/hover-card.tsx'
import { Progress } from '#/components/ui/progress.tsx'
import { cn } from '#/lib/utils.ts'

const PERCENT_MAX = 100
const ICON_RADIUS = 10
const ICON_VIEWBOX = 24
const ICON_CENTER = 12
const ICON_STROKE_WIDTH = 2

type ContextSchema = {
  usedTokens: number
  maxTokens: number
  usage?: LanguageModelUsage
  modelId?: string
}

const ContextContext = createContext<ContextSchema | null>(null)

function useContextValue(): ContextSchema {
  const context = useContext(ContextContext)
  if (!context) throw new Error('Context components must be used within Context')
  return context
}

function costUSD(modelId: string | undefined, usage: Record<string, number>): number | undefined {
  if (!modelId) return undefined
  return getUsage({ modelId, usage, providers: openaiModels }).costUSD?.totalUSD
}

function currency(value: number): string {
  const maximumFractionDigits = value > 0 && value < 0.01 ? 4 : 2
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits,
  }).format(value)
}

function compact(value: number): string {
  return new Intl.NumberFormat('en-US', { notation: 'compact' }).format(value)
}

function percent(value: number): string {
  return new Intl.NumberFormat('en-US', { style: 'percent', maximumFractionDigits: 1 }).format(value)
}

export type ContextProps = ComponentProps<typeof HoverCard> & ContextSchema

export function Context({ usedTokens, maxTokens, usage, modelId, ...props }: ContextProps) {
  return (
    <ContextContext.Provider value={{ usedTokens, maxTokens, usage, modelId }}>
      <HoverCard closeDelay={0} openDelay={0} {...props} />
    </ContextContext.Provider>
  )
}

function ContextIcon() {
  const { usedTokens, maxTokens } = useContextValue()
  const circumference = 2 * Math.PI * ICON_RADIUS
  const usedPercent = maxTokens > 0 ? usedTokens / maxTokens : 0
  const dashOffset = circumference * (1 - usedPercent)

  return (
    <svg
      aria-label="Model context usage"
      height="20"
      role="img"
      style={{ color: 'currentcolor' }}
      viewBox={`0 0 ${ICON_VIEWBOX} ${ICON_VIEWBOX}`}
      width="20"
    >
      <circle
        cx={ICON_CENTER}
        cy={ICON_CENTER}
        fill="none"
        opacity="0.25"
        r={ICON_RADIUS}
        stroke="currentColor"
        strokeWidth={ICON_STROKE_WIDTH}
      />
      <circle
        cx={ICON_CENTER}
        cy={ICON_CENTER}
        fill="none"
        opacity="0.7"
        r={ICON_RADIUS}
        stroke="currentColor"
        strokeDasharray={`${circumference} ${circumference}`}
        strokeDashoffset={dashOffset}
        strokeLinecap="round"
        strokeWidth={ICON_STROKE_WIDTH}
        style={{ transformOrigin: 'center', transform: 'rotate(-90deg)' }}
      />
    </svg>
  )
}

export type ContextTriggerProps = ComponentProps<typeof Button>

export function ContextTrigger({ children, ...props }: ContextTriggerProps) {
  const { usedTokens, maxTokens } = useContextValue()
  const usedPercent = maxTokens > 0 ? usedTokens / maxTokens : 0

  return (
    <HoverCardTrigger asChild>
      {children ?? (
        <Button type="button" variant="ghost" {...props}>
          <span className="font-medium text-muted-foreground">{percent(usedPercent)}</span>
          <ContextIcon />
        </Button>
      )}
    </HoverCardTrigger>
  )
}

export type ContextContentProps = ComponentProps<typeof HoverCardContent>

export function ContextContent({ className, ...props }: ContextContentProps) {
  return <HoverCardContent className={cn('min-w-60 divide-y overflow-hidden p-0', className)} {...props} />
}

export type ContextContentHeaderProps = ComponentProps<'div'>

export function ContextContentHeader({ children, className, ...props }: ContextContentHeaderProps) {
  const { usedTokens, maxTokens } = useContextValue()
  const usedPercent = maxTokens > 0 ? usedTokens / maxTokens : 0

  return (
    <div className={cn('w-full space-y-2 p-3', className)} {...props}>
      {children ?? (
        <>
          <div className="flex items-center justify-between gap-3 text-xs">
            <p>{percent(usedPercent)}</p>
            <p className="font-mono text-muted-foreground">
              {compact(usedTokens)} / {compact(maxTokens)}
            </p>
          </div>
          <div className="space-y-2">
            <Progress className="bg-muted" value={usedPercent * PERCENT_MAX} />
          </div>
        </>
      )}
    </div>
  )
}

export type ContextContentBodyProps = ComponentProps<'div'>

export function ContextContentBody({ children, className, ...props }: ContextContentBodyProps) {
  return (
    <div className={cn('w-full p-3', className)} {...props}>
      {children}
    </div>
  )
}

export type ContextContentFooterProps = ComponentProps<'div'>

export function ContextContentFooter({ children, className, ...props }: ContextContentFooterProps) {
  const { modelId, usage } = useContextValue()
  const total = costUSD(modelId, { input: usage?.inputTokens ?? 0, output: usage?.outputTokens ?? 0 })

  return (
    <div
      className={cn('flex w-full items-center justify-between gap-3 bg-secondary p-3 text-xs', className)}
      {...props}
    >
      {children ?? (
        <>
          <span className="text-muted-foreground">Total cost</span>
          <span>{currency(total ?? 0)}</span>
        </>
      )}
    </div>
  )
}

type UsageRowProps = ComponentProps<'div'> & { label: string; tokens: number; cost?: number }

function UsageRow({ label, tokens, cost, className, ...props }: UsageRowProps) {
  return (
    <div className={cn('flex items-center justify-between text-xs', className)} {...props}>
      <span className="text-muted-foreground">{label}</span>
      <span>
        {compact(tokens)}
        {cost !== undefined ? <span className="ml-2 text-muted-foreground">• {currency(cost)}</span> : null}
      </span>
    </div>
  )
}

export type ContextUsageProps = ComponentProps<'div'>

export function ContextInputUsage({ children, ...props }: ContextUsageProps) {
  const { usage, modelId } = useContextValue()
  const tokens = usage?.inputTokens ?? 0
  if (children) return <>{children}</>
  if (!tokens) return null
  return <UsageRow label="Input" tokens={tokens} cost={costUSD(modelId, { input: tokens, output: 0 })} {...props} />
}

export function ContextOutputUsage({ children, ...props }: ContextUsageProps) {
  const { usage, modelId } = useContextValue()
  const tokens = usage?.outputTokens ?? 0
  if (children) return <>{children}</>
  if (!tokens) return null
  return <UsageRow label="Output" tokens={tokens} cost={costUSD(modelId, { input: 0, output: tokens })} {...props} />
}

export function ContextReasoningUsage({ children, ...props }: ContextUsageProps) {
  const { usage, modelId } = useContextValue()
  const tokens = usage?.outputTokenDetails?.reasoningTokens ?? 0
  if (children) return <>{children}</>
  if (!tokens) return null
  return <UsageRow label="Reasoning" tokens={tokens} cost={costUSD(modelId, { reasoningTokens: tokens })} {...props} />
}

export function ContextCacheUsage({ children, ...props }: ContextUsageProps) {
  const { usage, modelId } = useContextValue()
  const tokens = usage?.inputTokenDetails?.cacheReadTokens ?? 0
  if (children) return <>{children}</>
  if (!tokens) return null
  return (
    <UsageRow
      label="Cache"
      tokens={tokens}
      cost={costUSD(modelId, { cacheReads: tokens, input: 0, output: 0 })}
      {...props}
    />
  )
}
