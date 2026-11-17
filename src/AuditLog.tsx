import { useEffect, useState } from 'react'
import { Activity, AlertCircle, CheckCircle2, LockKeyhole, RefreshCw, ScrollText } from 'lucide-react'

type AuthState = 'checking' | 'not_configured' | 'sign_in_required' | 'unavailable'
const API_BASE = (import.meta.env.VITE_API_BASE_URL || '/api').replace(/\/$/, '')

export default function AuditLog() {
  const [authState, setAuthState] = useState<AuthState>('checking')
  const [checkedAt, setCheckedAt] = useState('')
  const [refreshing, setRefreshing] = useState(false)

  async function checkAccess() {
    setRefreshing(true)
    try {
      const response = await fetch(`${API_BASE}/admin/session`, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        cache: 'no-store',
      })
      if (response.status === 503) setAuthState('not_configured')
      else if (response.status === 401 || response.status === 403) setAuthState('sign_in_required')
      else if (response.ok) setAuthState('sign_in_required')
      else setAuthState('unavailable')
    } catch {
      setAuthState('unavailable')
    } finally {
      setCheckedAt(new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))
      setRefreshing(false)
    }
  }

  useEffect(() => { void checkAccess() }, [])

  const stateCopy = {
    checking: { title: 'Checking administrator access', detail: 'Contacting the Platform Core API.', icon: Activity, tone: 'pending' },
    not_configured: { title: 'Owner sign-in is not configured', detail: 'Configure the OIDC issuer, audience, JWKS endpoint and owner identity before audit records can be viewed.', icon: LockKeyhole, tone: 'warning' },
    sign_in_required: { title: 'Owner sign-in is required', detail: 'The API is responding, but this preview has no interactive sign-in or secure token session yet. No audit data has been requested.', icon: LockKeyhole, tone: 'warning' },
    unavailable: { title: 'Audit service status unavailable', detail: 'The API could not be reached or returned an unexpected response. Check API availability and try again.', icon: AlertCircle, tone: 'error' },
  }[authState]
  const StateIcon = stateCopy.icon

  return (
    <section className="audit-screen">
      <div className="panel audit-intro">
        <div className="audit-heading-icon"><ScrollText size={21}/></div>
        <div className="audit-intro-copy">
          <span className="eyebrow">PLATFORM GOVERNANCE</span>
          <h2>Audit log</h2>
          <p>Designed to trace administrator actions across the control plane. Once configured, records will be stored centrally and exposed through an owner-protected, read-only API.</p>
        </div>
      </div>

      <div className={`panel audit-access-card ${stateCopy.tone}`} aria-live="polite">
        <div className="audit-access-icon"><StateIcon size={19}/></div>
        <div className="audit-access-copy">
          <b>{stateCopy.title}</b>
          <p>{stateCopy.detail}</p>
          {checkedAt && <small>Last checked at {checkedAt}</small>}
        </div>
        <button className="button secondary small" onClick={() => void checkAccess()} disabled={refreshing}>
          <RefreshCw size={14}/>{refreshing ? 'Checking' : 'Recheck'}
        </button>
      </div>

      <div className="panel audit-details">
        <div className="panel-heading">
          <div><h2>Audit storage readiness</h2><p>What is implemented and what still needs configuration.</p></div>
          <span className="coming">Setup required</span>
        </div>
        <div className="audit-check-row"><CheckCircle2 size={17}/><div><b>Central audit event schema</b><small>Migration 0003 defines actor, action, resource, metadata and timestamp fields.</small></div><span className="audit-state done">Code ready</span></div>
        <div className="audit-check-row"><CheckCircle2 size={17}/><div><b>Protected audit read API</b><small>Owner-authenticated GET endpoint with pagination and safe error responses.</small></div><span className="audit-state done">Code ready</span></div>
        <div className="audit-check-row"><AlertCircle size={17}/><div><b>Database migration</b><small>Migration 0003 has not been applied to a configured database.</small></div><span className="audit-state pending">Pending</span></div>
        <div className="audit-check-row"><AlertCircle size={17}/><div><b>Interactive owner sign-in</b><small>OIDC verification exists, but provider setup and browser sign-in are not connected.</small></div><span className="audit-state pending">Pending</span></div>
        <div className="audit-safety-note"><LockKeyhole size={16}/><span>No sample events are shown as real data. The event list will remain unavailable until authentication and database setup are complete.</span></div>
      </div>
    </section>
  )
}
