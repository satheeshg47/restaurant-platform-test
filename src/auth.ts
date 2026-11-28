function isConfiguredApiRequest(input: RequestInfo | URL) {
  if (typeof window === 'undefined') return false
  try {
    const requestUrl = input instanceof Request ? input.url : input instanceof URL ? input.href : input
    const target = new URL(requestUrl, window.location.origin)
    const apiBase = new URL(import.meta.env.VITE_API_BASE_URL || '/api', window.location.origin)
    let basePath = apiBase.pathname
    while (basePath.length > 1 && basePath.endsWith('/')) basePath = basePath.slice(0, -1)
    const withinApiPath = basePath === '/' || target.pathname === basePath || target.pathname.startsWith(basePath + '/')
    return target.origin === apiBase.origin && withinApiPath
  } catch {
    return false
  }
}

export async function apiFetch(input: RequestInfo | URL, init: RequestInit = {}) {
  const headers = new Headers(input instanceof Request ? input.headers : undefined)
  new Headers(init.headers).forEach((value, key) => headers.set(key, value))
  const credentials = init.credentials || (isConfiguredApiRequest(input) ? 'same-origin' : undefined)
  return fetch(input, { ...init, headers, ...(credentials ? { credentials } : {}) })
}
