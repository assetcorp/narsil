import { generateText, type LanguageModel } from 'ai'

const TITLE_MAX_OUTPUT_TOKENS = 1024
const TITLE_MAX_CHARS = 80

export function provisionalTitle(question: string): string {
  const firstLine = question.split('\n', 1)[0].trim()
  const base = firstLine.length > 0 ? firstLine : question.trim()
  return base.slice(0, TITLE_MAX_CHARS)
}

const TITLE_INSTRUCTIONS =
  "Write a short, specific title that summarizes the user's question for a chat sidebar. Use at most 8 words. No quotes, no colons, no trailing punctuation. Return only the title text."

function normalizeTitle(raw: string): string | null {
  const cleaned = raw
    .trim()
    .replace(/^["'`]+/, '')
    .replace(/["'`]+$/, '')
    .replace(/[\s:.,;]+$/, '')
    .trim()
  if (cleaned.length === 0) return null
  return cleaned.slice(0, TITLE_MAX_CHARS)
}

export async function generateThreadTitle(
  model: LanguageModel,
  question: string,
  signal: AbortSignal,
): Promise<string | null> {
  try {
    const result = await generateText({
      model,
      instructions: TITLE_INSTRUCTIONS,
      prompt: question,
      maxOutputTokens: TITLE_MAX_OUTPUT_TOKENS,
      providerOptions: { openai: { reasoningEffort: 'low' } },
      abortSignal: signal,
    })
    return normalizeTitle(result.text)
  } catch {
    return null
  }
}
