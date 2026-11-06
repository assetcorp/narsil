import { Loader2 } from 'lucide-react'
import type { ReactNode } from 'react'
import type { ActionState } from './use-action-runner'

interface ManageSectionProps {
  title: string
  description: string
  state: ActionState
  testId: string
  children: ReactNode
}

export function ManageSection({ title, description, state, testId, children }: ManageSectionProps) {
  return (
    <section className="rounded-lg border p-4" data-testid={testId}>
      <h3 className="text-sm font-semibold">{title}</h3>
      <p className="mb-3 text-xs text-muted-foreground">{description}</p>
      {children}
      <output className="mt-2 block min-h-4 text-xs">
        {state.kind === 'running' ? (
          <span className="flex items-center gap-1.5 text-muted-foreground">
            <Loader2 className="size-3 animate-spin" />
            {state.label}
          </span>
        ) : null}
        {state.kind === 'done' ? <span className="text-foreground">{state.message}</span> : null}
        {state.kind === 'failed' ? <span className="text-destructive">{state.message}</span> : null}
      </output>
    </section>
  )
}
