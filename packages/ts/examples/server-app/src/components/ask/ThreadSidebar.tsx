import { Plus, Trash2 } from 'lucide-react'
import { useCallback } from 'react'
import { Button } from '#/components/ui/button'
import type { ThreadSummary } from '#/lib/chat/types'
import { cn } from '#/lib/utils'
import { TypingText } from './typing-text'

interface ThreadRowProps {
  thread: ThreadSummary
  active: boolean
  slideIn: boolean
  onSelect: (id: string) => void
  onDelete: (id: string) => void
}

function ThreadRow({ thread, active, slideIn, onSelect, onDelete }: ThreadRowProps) {
  const handleSelect = useCallback(() => {
    onSelect(thread.id)
  }, [onSelect, thread.id])

  const handleDelete = useCallback(() => {
    onDelete(thread.id)
  }, [onDelete, thread.id])

  return (
    <div
      className={cn(
        'group relative',
        slideIn && 'animate-in fade-in-0 slide-in-from-bottom-4 duration-300 motion-reduce:animate-none',
      )}
    >
      <button
        type="button"
        onClick={handleSelect}
        className={cn(
          'flex w-full flex-col gap-0.5 rounded-md px-2.5 py-2 pr-8 text-left transition-colors',
          active ? 'bg-muted' : 'hover:bg-muted/60',
        )}
      >
        <TypingText text={thread.title} className="truncate text-sm font-medium text-foreground" />
        <span className="truncate font-mono text-[11px] text-muted-foreground">{thread.indexName}</span>
      </button>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label="Delete conversation"
        onClick={handleDelete}
        className="absolute top-1.5 right-1 size-6 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:text-destructive"
      >
        <Trash2 className="size-3.5" />
      </Button>
    </div>
  )
}

interface ThreadSidebarProps {
  threads: ThreadSummary[]
  activeThreadId: string | null
  isThreadNew: (id: string) => boolean
  onSelect: (id: string) => void
  onNew: () => void
  onDelete: (id: string) => void
}

export function ThreadSidebar({ threads, activeThreadId, isThreadNew, onSelect, onNew, onDelete }: ThreadSidebarProps) {
  return (
    <aside className="flex h-full flex-col gap-3">
      <Button type="button" variant="outline" size="sm" onClick={onNew} className="justify-start">
        <Plus className="size-3.5" />
        New chat
      </Button>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {threads.length === 0 ? (
          <p className="px-2.5 py-2 text-xs leading-relaxed text-muted-foreground">
            Your conversations are saved here. Ask a question to start one.
          </p>
        ) : (
          <div className="flex flex-col gap-0.5">
            {threads.map(thread => (
              <ThreadRow
                key={thread.id}
                thread={thread}
                active={thread.id === activeThreadId}
                slideIn={isThreadNew(thread.id)}
                onSelect={onSelect}
                onDelete={onDelete}
              />
            ))}
          </div>
        )}
      </div>
    </aside>
  )
}
