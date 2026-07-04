import type { LoadedIndex } from '@delali/narsil-example-shared'
import type { ChatStatus } from 'ai'
import { Database } from 'lucide-react'
import { useCallback } from 'react'
import {
  PromptInput,
  PromptInputBody,
  PromptInputFooter,
  type PromptInputMessage,
  PromptInputSelect,
  PromptInputSelectContent,
  PromptInputSelectItem,
  PromptInputSelectTrigger,
  PromptInputSelectValue,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
} from '#/components/ai-elements/prompt-input'
import { MAX_QUESTION_CHARS } from '#/lib/ask/messages'

interface AskPromptInputProps {
  indexes: LoadedIndex[]
  indexName: string
  onIndexChange: (indexName: string) => void
  status: ChatStatus
  disabled: boolean
  onSubmitText: (text: string) => void
  onStop: () => void
}

export function AskPromptInput({
  indexes,
  indexName,
  onIndexChange,
  status,
  disabled,
  onSubmitText,
  onStop,
}: AskPromptInputProps) {
  const handleSubmit = useCallback(
    (message: PromptInputMessage) => {
      const text = message.text.trim()
      if (text.length === 0 || text.length > MAX_QUESTION_CHARS) return
      if (status === 'submitted' || status === 'streaming') return
      onSubmitText(text)
    },
    [onSubmitText, status],
  )

  return (
    <PromptInput onSubmit={handleSubmit} className="shrink-0 [&>div]:rounded-xl [&>div]:shadow-sm">
      <PromptInputBody>
        <PromptInputTextarea
          placeholder={`Ask ${indexName} anything...`}
          maxLength={MAX_QUESTION_CHARS}
          disabled={disabled}
        />
      </PromptInputBody>
      <PromptInputFooter>
        <PromptInputTools>
          <PromptInputSelect value={indexName} onValueChange={onIndexChange}>
            <PromptInputSelectTrigger size="sm" className="gap-1.5 text-xs">
              <Database className="size-3.5" />
              <PromptInputSelectValue placeholder="Pick an index" />
            </PromptInputSelectTrigger>
            <PromptInputSelectContent>
              {indexes.map(index => (
                <PromptInputSelectItem key={index.name} value={index.name} className="text-xs">
                  <span className="font-mono">{index.name}</span>
                  <span className="text-muted-foreground">{index.documentCount.toLocaleString()} docs</span>
                </PromptInputSelectItem>
              ))}
            </PromptInputSelectContent>
          </PromptInputSelect>
        </PromptInputTools>
        <PromptInputSubmit status={status} onStop={onStop} disabled={disabled} />
      </PromptInputFooter>
    </PromptInput>
  )
}
