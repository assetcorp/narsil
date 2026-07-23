'use client'

import { useControllableState } from '@radix-ui/react-use-controllable-state'
import { BrainIcon, ChevronDownIcon, DotIcon, type LucideIcon } from 'lucide-react'
import { type ComponentProps, createContext, memo, type ReactNode, useContext, useMemo } from 'react'
import { Badge } from '#/components/ui/badge.tsx'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '#/components/ui/collapsible.tsx'
import { cn } from '#/lib/utils.ts'

interface ChainOfThoughtContextValue {
  isOpen: boolean
  setIsOpen: (open: boolean) => void
}

const ChainOfThoughtContext = createContext<ChainOfThoughtContextValue | null>(null)

function useChainOfThought(): ChainOfThoughtContextValue {
  const context = useContext(ChainOfThoughtContext)
  if (!context) throw new Error('ChainOfThought components must be used within ChainOfThought')
  return context
}

export type ChainOfThoughtProps = ComponentProps<'div'> & {
  open?: boolean
  defaultOpen?: boolean
  onOpenChange?: (open: boolean) => void
}

export const ChainOfThought = memo(function ChainOfThought({
  className,
  open,
  defaultOpen = false,
  onOpenChange,
  children,
  ...props
}: ChainOfThoughtProps) {
  const [isOpen, setIsOpen] = useControllableState({ prop: open, defaultProp: defaultOpen, onChange: onOpenChange })
  const value = useMemo(() => ({ isOpen, setIsOpen }), [isOpen, setIsOpen])

  return (
    <ChainOfThoughtContext.Provider value={value}>
      <div className={cn('not-prose max-w-prose space-y-4', className)} {...props}>
        {children}
      </div>
    </ChainOfThoughtContext.Provider>
  )
})

export type ChainOfThoughtHeaderProps = ComponentProps<typeof CollapsibleTrigger>

export const ChainOfThoughtHeader = memo(function ChainOfThoughtHeader({
  className,
  children,
  ...props
}: ChainOfThoughtHeaderProps) {
  const { isOpen, setIsOpen } = useChainOfThought()

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen}>
      <CollapsibleTrigger
        className={cn(
          'flex w-full items-center gap-2 text-muted-foreground text-sm transition-colors hover:text-foreground',
          className,
        )}
        {...props}
      >
        <BrainIcon className="size-4" />
        <span className="flex-1 text-left">{children ?? 'Chain of Thought'}</span>
        <ChevronDownIcon className={cn('size-4 transition-transform', isOpen ? 'rotate-180' : 'rotate-0')} />
      </CollapsibleTrigger>
    </Collapsible>
  )
})

export type ChainOfThoughtStepProps = ComponentProps<'div'> & {
  icon?: LucideIcon
  label: ReactNode
  description?: ReactNode
  status?: 'complete' | 'active' | 'pending'
}

const stepStatusStyles: Record<NonNullable<ChainOfThoughtStepProps['status']>, string> = {
  complete: 'text-muted-foreground',
  active: 'text-foreground',
  pending: 'text-muted-foreground/50',
}

export const ChainOfThoughtStep = memo(function ChainOfThoughtStep({
  className,
  icon: Icon = DotIcon,
  label,
  description,
  status = 'complete',
  children,
  ...props
}: ChainOfThoughtStepProps) {
  return (
    <div
      className={cn(
        'flex gap-2 text-sm',
        stepStatusStyles[status],
        'fade-in-0 slide-in-from-top-2 animate-in',
        className,
      )}
      {...props}
    >
      <div className="relative mt-0.5">
        <Icon className="size-4" />
        <div className="-mx-px absolute top-7 bottom-0 left-1/2 w-px bg-border" />
      </div>
      <div className="flex-1 space-y-2 overflow-hidden">
        <div>{label}</div>
        {description && <div className="text-muted-foreground text-xs">{description}</div>}
        {children}
      </div>
    </div>
  )
})

export type ChainOfThoughtSearchResultsProps = ComponentProps<'div'>

export const ChainOfThoughtSearchResults = memo(function ChainOfThoughtSearchResults({
  className,
  ...props
}: ChainOfThoughtSearchResultsProps) {
  return <div className={cn('flex flex-wrap items-center gap-2', className)} {...props} />
})

export type ChainOfThoughtSearchResultProps = ComponentProps<typeof Badge>

export const ChainOfThoughtSearchResult = memo(function ChainOfThoughtSearchResult({
  className,
  children,
  ...props
}: ChainOfThoughtSearchResultProps) {
  return (
    <Badge className={cn('gap-1 px-2 py-0.5 font-normal text-xs', className)} variant="secondary" {...props}>
      {children}
    </Badge>
  )
})

export type ChainOfThoughtContentProps = ComponentProps<typeof CollapsibleContent>

export const ChainOfThoughtContent = memo(function ChainOfThoughtContent({
  className,
  children,
  ...props
}: ChainOfThoughtContentProps) {
  const { isOpen } = useChainOfThought()

  return (
    <Collapsible open={isOpen}>
      <CollapsibleContent
        className={cn(
          'mt-2 space-y-3',
          'data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-top-2 data-[state=open]:slide-in-from-top-2 text-popover-foreground outline-none data-[state=closed]:animate-out data-[state=open]:animate-in',
          className,
        )}
        {...props}
      >
        {children}
      </CollapsibleContent>
    </Collapsible>
  )
})
