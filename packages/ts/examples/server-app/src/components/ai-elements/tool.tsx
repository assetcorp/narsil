'use client'

import type { ToolUIPart } from 'ai'
import { CheckCircle2Icon, ChevronDownIcon, CircleIcon, Loader2Icon, WrenchIcon, XCircleIcon } from 'lucide-react'
import type { ComponentProps, ReactNode } from 'react'
import { Badge } from '#/components/ui/badge.tsx'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '#/components/ui/collapsible.tsx'
import { cn } from '#/lib/utils.ts'

export type ToolProps = ComponentProps<typeof Collapsible>

export const Tool = ({ className, ...props }: ToolProps) => (
  <Collapsible className={cn('not-prose group w-full rounded-lg border bg-card/40', className)} {...props} />
)

type ToolState = ToolUIPart['state']

const STATUS_LABEL: Record<ToolState, string> = {
  'input-streaming': 'Pending',
  'input-available': 'Running',
  'approval-requested': 'Awaiting approval',
  'approval-responded': 'Approved',
  'output-available': 'Done',
  'output-error': 'Error',
  'output-denied': 'Denied',
}

function StatusBadge({ state }: { state: ToolState }) {
  const Icon =
    state === 'output-available'
      ? CheckCircle2Icon
      : state === 'output-error'
        ? XCircleIcon
        : state === 'input-streaming'
          ? CircleIcon
          : Loader2Icon
  const spinning = state === 'input-available' || state === 'approval-requested'

  return (
    <Badge
      variant="secondary"
      className={cn('gap-1 rounded-full text-[10px] font-normal', state === 'output-error' && 'text-destructive')}
    >
      <Icon className={cn('size-3', spinning && 'animate-spin')} />
      {STATUS_LABEL[state]}
    </Badge>
  )
}

export type ToolHeaderProps = Omit<ComponentProps<typeof CollapsibleTrigger>, 'title'> & {
  state: ToolState
  type?: ToolUIPart['type']
  title?: ReactNode
  icon?: ReactNode
}

export const ToolHeader = ({ className, state, type, title, icon, ...props }: ToolHeaderProps) => (
  <CollapsibleTrigger
    className={cn('flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm', className)}
    {...props}
  >
    <span className="flex min-w-0 items-center gap-2">
      <span className="shrink-0 text-muted-foreground">{icon ?? <WrenchIcon className="size-4" />}</span>
      <span className="min-w-0 truncate font-medium">{title ?? type}</span>
    </span>
    <span className="flex shrink-0 items-center gap-2">
      <StatusBadge state={state} />
      <ChevronDownIcon className="size-4 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
    </span>
  </CollapsibleTrigger>
)

export type ToolContentProps = ComponentProps<typeof CollapsibleContent>

export const ToolContent = ({ className, ...props }: ToolContentProps) => (
  <CollapsibleContent
    className={cn(
      'overflow-hidden outline-none data-[state=closed]:animate-out data-[state=open]:animate-in',
      className,
    )}
    {...props}
  />
)

export type ToolInputProps = {
  input: ToolUIPart['input']
}

export const ToolInput = ({ input }: ToolInputProps) => (
  <div className="space-y-1.5 border-t px-3 py-2">
    <h4 className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Parameters</h4>
    <pre className="overflow-x-auto rounded-md bg-muted/50 p-2 font-mono text-[11px] leading-relaxed">
      {JSON.stringify(input, null, 2)}
    </pre>
  </div>
)

export type ToolOutputProps = {
  output: ReactNode
  errorText?: ToolUIPart['errorText']
}

export const ToolOutput = ({ output, errorText }: ToolOutputProps) => {
  if (!output && !errorText) return null
  return (
    <div className="space-y-1.5 border-t px-3 py-2">
      <h4 className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Result</h4>
      <div className={cn('text-xs leading-relaxed', errorText ? 'text-destructive' : 'text-muted-foreground')}>
        {errorText ?? output}
      </div>
    </div>
  )
}
