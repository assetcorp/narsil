import { useEffect, useRef, useState } from 'react'

const TYPING_INTERVAL_MS = 24

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return true
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

export function useTypewriter(text: string): string {
  const [visible, setVisible] = useState(text)
  const mountedText = useRef(text)
  useEffect(() => {
    if (text === mountedText.current) return
    mountedText.current = text
    if (prefersReducedMotion()) {
      setVisible(text)
      return
    }
    setVisible('')
    let length = 0
    const timer = setInterval(() => {
      length += 1
      setVisible(text.slice(0, length))
      if (length >= text.length) clearInterval(timer)
    }, TYPING_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [text])
  return visible
}

interface TypingTextProps {
  text: string
  className?: string
}

export function TypingText({ text, className }: TypingTextProps) {
  const visible = useTypewriter(text)
  return <span className={className}>{visible}</span>
}
