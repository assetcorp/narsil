import { KeyRound, TriangleAlert } from 'lucide-react'
import type { AskCapabilities } from '#/lib/ask/types'

interface SetupNoticeProps {
  capabilities: AskCapabilities | null
  capabilitiesError: string | null
}

function EnvVar({ name }: { name: string }) {
  return <code className="rounded bg-primary/10 px-1 py-px font-mono text-[11px] text-foreground">{name}</code>
}

/**
 * Explains exactly what to configure when answer generation cannot run. The
 * page never hides behind a spinner or crashes; it says what is missing and
 * which environment variable fixes it.
 */
export function SetupNotice({ capabilities, capabilitiesError }: SetupNoticeProps) {
  if (capabilitiesError) {
    return (
      <div className="flex items-start gap-2.5 rounded-lg border border-destructive/40 bg-destructive/5 px-3.5 py-3 text-left">
        <TriangleAlert className="mt-0.5 size-4 shrink-0 text-destructive" />
        <div className="min-w-0 text-xs leading-relaxed">
          <p className="text-sm font-medium">The Ask configuration could not be read.</p>
          <p className="mt-0.5 text-muted-foreground">{capabilitiesError}</p>
        </div>
      </div>
    )
  }

  if (!capabilities || capabilities.llmConfigured) return null

  return (
    <div className="flex items-start gap-2.5 rounded-lg border border-primary/25 bg-primary/5 px-3.5 py-3 text-left">
      <KeyRound className="mt-0.5 size-4 shrink-0 text-primary" />
      <div className="min-w-0 text-xs leading-relaxed text-muted-foreground">
        <p className="text-sm font-medium text-foreground">Bring your own model to ask questions.</p>
        <p className="mt-0.5">
          Set <EnvVar name="OPENAI_API_KEY" /> in the app server environment and restart <EnvVar name="pnpm dev" />. Any
          OpenAI-compatible endpoint works via <EnvVar name="ASK_LLM_BASE_URL" /> and <EnvVar name="ASK_LLM_MODEL" />.
          The same key enables semantic and hybrid retrieval when you reload a dataset.
        </p>
      </div>
    </div>
  )
}
