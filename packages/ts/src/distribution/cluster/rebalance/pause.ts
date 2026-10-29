export function pause(milliseconds: number): Promise<void> {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, milliseconds)
    timer.unref?.()
  })
}
