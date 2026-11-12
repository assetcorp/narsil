let latestStartedAtMs = 0

export function nextStartedAt(): string {
  latestStartedAtMs = Math.max(Date.now(), latestStartedAtMs + 1)
  return new Date(latestStartedAtMs).toISOString()
}
