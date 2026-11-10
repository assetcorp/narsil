import { X } from 'lucide-react'
import type { ReactNode } from 'react'
import { Button } from '#/components/ui/button'
import { cn } from '#/lib/utils'

export function Notice({
  icon,
  title,
  children,
  tone = 'neutral',
  urgent = false,
  onDismiss,
  className,
}: {
  icon: ReactNode
  title: ReactNode
  children?: ReactNode
  tone?: 'neutral' | 'destructive'
  urgent?: boolean
  onDismiss?: () => void
  className?: string
}) {
  return (
    <div
      role={urgent ? 'alert' : 'status'}
      className={cn(
        'flex items-start gap-3 rounded-lg border bg-card px-4 py-3 text-sm shadow-xs duration-300 animate-in fade-in-0 slide-in-from-bottom-1 motion-reduce:animate-none',
        tone === 'destructive' && 'border-destructive/30 text-destructive',
        className,
      )}
    >
      <span className="mt-0.5 shrink-0 [&_svg]:size-4" aria-hidden="true">
        {icon}
      </span>
      <div className="min-w-0 flex-1">
        <p className="font-medium">{title}</p>
        {children === undefined ? null : (
          <div className={cn('mt-1', tone === 'destructive' ? 'text-destructive/90' : 'text-muted-foreground')}>
            {children}
          </div>
        )}
      </div>
      {onDismiss === undefined ? null : (
        <Button type="button" variant="ghost" size="icon-xs" aria-label="Dismiss" onClick={onDismiss}>
          <X aria-hidden="true" />
        </Button>
      )}
    </div>
  )
}
