const REQUEST_TIMEOUT_MS = 30_000
const REQUEST_ATTEMPTS = 3
const RETRY_DELAY_MS = 2_000
const API = process.env.GITHUB_API_URL ?? 'https://api.github.com'

async function request(path) {
  const token = process.env.GITHUB_TOKEN ?? ''
  if (token === '') throw new Error('GITHUB_TOKEN is empty')
  const headers = {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28',
  }
  for (let attempt = 1; ; attempt += 1) {
    let response = null
    let failure = null
    try {
      response = await fetch(`${API}${path}`, { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error)
    }
    if (response?.ok) return response.json()
    const retryable = response === null || response.status >= 500 || response.status === 429
    if (!retryable || attempt >= REQUEST_ATTEMPTS) {
      throw new Error(`the GitHub API answered ${response?.status ?? failure} to ${path}`)
    }
    await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS * attempt))
  }
}

module.exports = { request }
