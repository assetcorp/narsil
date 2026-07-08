'use client'

import { BrainIcon, ChevronDownIcon } from 'lucide-react'
import { type ComponentProps, createContext, memo, useCallback, useContext, useEffect, useRef, useState } from 'react'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '#/components/ui/collapsible.tsx'
import { cn } from '#/lib/utils.ts'
import { MessageResponse } from './message'

const AUTO_CLOSE_DELAY_MS = 1000

interface ReasoningContextValue {
  isStreaming: boolean
  duration: number
}

const ReasoningContext = createContext<ReasoningContextValue | null>(null)

function useReasoning(): ReasoningContextValue {
  const context = useContext(ReasoningContext)
  if (!context) throw new Error('Reasoning components must be used within Reasoning')
  return context
}

export type ReasoningProps = ComponentProps<typeof Collapsible> & {
  isStreaming?: boolean
}

export const Reasoning = memo(function Reasoning({
  className,
  isStreaming = false,
  defaultOpen = true,
  children,
  ...props
}: ReasoningProps) {
  const [isOpen, setIsOpen] = useState(defaultOpen)
  const [duration, setDuration] = useState(0)
  const startedAt = useRef<number | null>(null)

  useEffect(() => {
    if (isStreaming) {
      if (startedAt.current === null) startedAt.current = Date.now()
      setIsOpen(true)
      return
    }
    if (startedAt.current !== null) {
      setDuration(Math.round((Date.now() - startedAt.current) / 1000))
      startedAt.current = null
    }
    const timer = setTimeout(() => setIsOpen(false), AUTO_CLOSE_DELAY_MS)
    return () => clearTimeout(timer)
  }, [isStreaming])

  const handleOpenChange = useCallback((open: boolean) => {
    setIsOpen(open)
  }, [])

  return (
    <ReasoningContext.Provider value={{ isStreaming, duration }}>
      <Collapsible
        className={cn('not-prose group', className)}
        open={isOpen}
        onOpenChange={handleOpenChange}
        {...props}
      >
        {children}
      </Collapsible>
    </ReasoningContext.Provider>
  )
})

export type ReasoningTriggerProps = ComponentProps<typeof CollapsibleTrigger>

export const ReasoningTrigger = ({ className, children, ...props }: ReasoningTriggerProps) => {
  const { isStreaming, duration } = useReasoning()

  return (
    <CollapsibleTrigger className={cn('flex items-center gap-1.5 text-xs text-muted-foreground', className)} {...props}>
      {children ?? (
        <>
          <BrainIcon className="size-3.5" />
          {isStreaming || duration === 0 ? (
            <span className="shimmer">Thinking</span>
          ) : (
            <span>Thought for {duration <= 1 ? 'a moment' : `${duration} seconds`}</span>
          )}
          <ChevronDownIcon className="size-3.5 transition-transform group-data-[state=open]:rotate-180" />
        </>
      )}
    </CollapsibleTrigger>
  )
}

export type ReasoningContentProps = Omit<ComponentProps<typeof CollapsibleContent>, 'children'> & {
  children: string
}

export const ReasoningContent = ({ className, children, ...props }: ReasoningContentProps) => (
  <CollapsibleContent
    className={cn(
      'mt-2 border-muted border-l-2 pl-3 text-xs text-muted-foreground',
      'data-[state=closed]:animate-out data-[state=open]:animate-in',
      className,
    )}
    {...props}
  >
    <MessageResponse className="text-xs [&_*]:text-xs [&_*]:text-muted-foreground">{children}</MessageResponse>
  </CollapsibleContent>
)
