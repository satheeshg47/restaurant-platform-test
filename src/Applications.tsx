import { apiFetch } from './auth'
import { useCallback, useEffect, useState } from 'react'
import { Activity, AppWindow, RefreshCw, ShieldAlert } from 'lucide-react'

type Application = {
  id: string
  app_key: string
  name: string
  status: string
  created_at: string
  updated_at: string
}

type ViewState = 'loading' | 'ready' | 'auth_not_configured' | 'sign_in_required' | 'forbidden' | 'database_unavailable' | 'unavailable'

const API_BASE = (import.meta.env.VITE_API_BASE_URL || '/api').replace(/\/$/, '')

export default function Applications() {
  const [state, setState] = useState<ViewState>('loading')
  const [applications, setApplications] = useState<Application[]>([])
  const [error, setError] = useState('')
  const [refreshing, setRefreshing] = useState(false)

  const refresh = useCallback(async () => {
    setRefreshing(true)
    setError('')
    try {
      const sessionResponse = await apiFetch(`${API_BASE}/admin/session`, {
        headers: { Accept: 'application/json' },
        cache: 'no-store',
      })
      if (sessionResponse.status === 503) {
        setState('auth_not_configured')
        setApplications([])
        return
      }
      if (sessionResponse.status === 401) {
        setState('sign_in_required')
        setApplications([])
        return
      }
      if (sessionResponse.status === 403) {
        setState('forbidden')
        setApplications([])
        return
      }
      if (!sessionResponse.ok) throw new Error('The administrator session check failed.')

      const response = await apiFetch(`${API_BASE}/admin/applications`, {
        headers: { Accept: 'application/json' },
        cache: 'no-store',
      })
      if (response.status === 503) {
        setState('database_unavailable')
        setApplications([])
        return
      }
      if (response.status === 401) {
        setState('sign_in_required')
        setApplications([])
        return
      }
      if (response.status === 403) {
        setState('forbidden')
        setApplications([])
        return
      }
      if (!response.ok) throw new Error('The application registry could not be loaded.')
      const payload = await response.json()
      if (!Array.isArray(payload.applications)) throw new Error('The API returned an invalid application list.')
      setApplications(payload.applications)
      setState('ready')
    } catch (cause) {
      setState('unavailable')
      setApplications([])
      setError(cause instanceof Error ? cause.message : 'Unexpected API error.')
    } finally {
      setRefreshing(false)
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  const messages: Record<Exclude<ViewState, 'loading' | 'ready'>, { title: string; description: string }> = {
    auth_not_configured: {
      title: 'Administrator sign-in is not configured',
      description: 'The API is intentionally blocking registry access until an owner-only identity provider is configured. No sample applications are shown here.',
    },
    sign_in_required: {
      title: 'Owner sign-in is required',
      description: 'The API did not accept an administrator session. The browser sign-in flow is not connected yet; no application data was loaded.',
    },
    forbidden: {
      title: 'Owner access denied',
      description: 'This identity is not authorized to manage the platform registry.',
    },
    database_unavailable: {
      title: 'Platform database is not available',
      description: 'Administrator authentication passed, but the registry database is not configured or available.',
    },
    unavailable: {
      title: 'Application registry unavailable',
      description: error || 'The API could not be reached. Check that the backend is running and the /api proxy is configured.',
    },
  }

  return (
    <section className="panel live-applications" aria-live="polite">
      <div className="panel-heading">
        <div><h2>Applications</h2><p>Registered products loaded from the protected Platform Core API.</p></div>
        <button className="button secondary small" onClick={() => void refresh()} disabled={refreshing}>
          <RefreshCw size={14} className={refreshing ? 'spin' : ''}/>{refreshing ? 'Checking' : 'Refresh'}
        </button>
      </div>
      {state === 'loading' && <div className="registry-state"><Activity size={20}/><b>Checking owner access and loading applications…</b></div>}
      {state !== 'loading' && state !== 'ready' && <div className="registry-state registry-blocked">
        <div className="registry-state-icon"><ShieldAlert size={20}/></div>
        <div><b>{messages[state].title}</b><p>{messages[state].description}</p></div>
      </div>}
      {state === 'ready' && (applications.length === 0
        ? <div className="registry-empty"><div className="empty-icon"><AppWindow size={21}/></div><b>No applications registered</b><p>Once the owner sign-in flow is connected, applications created through the protected API will appear here.</p></div>
        : <div className="app-list">{applications.map(app => <div className="app-row" key={app.id}>
          <div className="app-icon violet">{app.name.slice(0, 2).toUpperCase()}</div>
          <div className="app-info"><b>{app.name}</b><small>{app.app_key} · Added {new Date(app.created_at).toLocaleDateString()}</small></div>
          <span className={`status ${app.status.toLowerCase()}`}>{app.status}</span>
          {app.app_key === 'restaurant' && app.status === 'active' && <a className="app-open-workspace" href="/owner?demo=1" target="_blank" rel="noreferrer">Open demo workspace <span aria-hidden="true">↗</span></a>}
        </div>)}</div>)}
      <div className="registry-footnote">Read-only registry view · No browser token storage · No sample records</div>
    </section>
  )
}
