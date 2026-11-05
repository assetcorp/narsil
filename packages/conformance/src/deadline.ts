export const CHECK_DEADLINE_MS = 60_000

export async function withinDeadline<T>(work: Promise<T>, what: string, deadlineMs = CHECK_DEADLINE_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${what} did not finish within ${deadlineMs} ms, so its reader waits on something`)),
      deadlineMs,
    )
  })
  try {
    return await Promise.race([work, deadline])
  } finally {
    clearTimeout(timer)
  }
}
