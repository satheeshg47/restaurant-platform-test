import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { apiFetch } from './auth'
import { AlertCircle, Check, KeyRound, Plus, RefreshCw, ShieldCheck, UserRound, UserX } from 'lucide-react'

type Staff = {
  staff_id: string
  user_id: string
  login_id: string
  display_name: string
  role: 'cook' | 'waiter' | 'manager'
  active: boolean
  last_login_at: string | null
}
type Props = { tenantId: string; apiBaseUrl?: string }

const ROLES = [
  { value: 'manager', label: 'Manager', description: 'Menu, tables, operations, settings and reports' },
  { value: 'cook', label: 'Cook', description: 'Kitchen queue and preparation workflow' },
  { value: 'waiter', label: 'Waiter', description: 'Service board, tables and order hand-off' },
] as const

export default function OwnerStaff({ tenantId, apiBaseUrl = '/api' }: Props) {
  const base = apiBaseUrl.replace(/\/$/, '')
  const [staff, setStaff] = useState<Staff[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [showCreate, setShowCreate] = useState(false)
  const [loginId, setLoginId] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [password, setPassword] = useState('')
  const [role, setRole] = useState<'cook' | 'waiter' | 'manager'>('waiter')
  const [resetFor, setResetFor] = useState('')
  const [resetPassword, setResetPassword] = useState('')

  const request = useCallback(async (path: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers)
    headers.set('Accept', 'application/json')
    if (init?.body) headers.set('Content-Type', 'application/json')
    const response = await apiFetch(base + path, {
      ...init,
      credentials: 'same-origin',
      cache: 'no-store',
      headers,
    })
    const payload = await response.json().catch(() => ({})) as { error?: string; staff?: Staff[]; password_reset?: boolean }
    if (!response.ok) throw new Error(payload.error || 'staff_request_failed')
    return payload
  }, [base])

  const load = useCallback(async () => {
    if (!tenantId) return
    setLoading(true); setError('')
    try {
      const payload = await request('/owner/staff?tenant_id=' + encodeURIComponent(tenantId))
      setStaff(Array.isArray(payload.staff) ? payload.staff as Staff[] : [])
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not load staff accounts.')
    } finally { setLoading(false) }
  }, [request, tenantId])

  useEffect(() => { void load() }, [load])

  const createStaff = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setBusy('create'); setError(''); setNotice('')
    try {
      await request('/owner/staff', {
        method: 'POST',
        body: JSON.stringify({ tenant_id: tenantId, login_id: loginId.trim(), display_name: displayName.trim(), password, role }),
      })
      setLoginId(''); setDisplayName(''); setPassword(''); setShowCreate(false)
      setNotice('Staff account created. Share the login ID and password with the staff member through a private channel.')
      await load()
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not create staff account.') }
    finally { setBusy('') }
  }

  const toggleActive = async (person: Staff) => {
    setBusy(person.staff_id); setError(''); setNotice('')
    try {
      await request('/owner/staff/' + encodeURIComponent(person.staff_id), {
        method: 'PATCH', body: JSON.stringify({ tenant_id: tenantId, active: !person.active }),
      })
      setNotice(person.active ? 'Staff account suspended and active sessions revoked.' : 'Staff account reactivated.')
      await load()
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not update staff account.') }
    finally { setBusy('') }
  }

  const changeRole = async (person: Staff, nextRole: Staff['role']) => {
    if (person.role === nextRole) return
    setBusy(person.staff_id); setError(''); setNotice('')
    try {
      await request('/owner/staff/' + encodeURIComponent(person.staff_id), {
        method: 'PATCH', body: JSON.stringify({ tenant_id: tenantId, role: nextRole }),
      })
      setNotice('Staff role updated.')
      await load()
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not update staff role.') }
    finally { setBusy('') }
  }

  const savePassword = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!resetFor) return
    setBusy(resetFor); setError(''); setNotice('')
    try {
      await request('/owner/staff/' + encodeURIComponent(resetFor) + '/password', {
        method: 'POST', body: JSON.stringify({ tenant_id: tenantId, password: resetPassword }),
      })
      setResetFor(''); setResetPassword('')
      setNotice('Password reset. All existing sessions for this staff account have been revoked.')
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not reset password.') }
    finally { setBusy('') }
  }

  return <section className="panel owner-staff">
    <div className="panel-heading">
      <div><h2>Staff accounts</h2><p>Create individual logins and assign restaurant roles. Staff sign in at /staff; shared accounts are not used.</p></div>
      <ShieldCheck size={20}/>
    </div>
    <div className="owner-staff-toolbar">
      <span>{staff.length} account{staff.length === 1 ? '' : 's'}</span>
      <div>
        <button type="button" className="owner-staff-secondary" onClick={() => void load()} disabled={loading}><RefreshCw size={14}/> Refresh</button>
        <button type="button" className="owner-staff-primary" onClick={() => setShowCreate(value => !value)}><Plus size={15}/> Add staff</button>
      </div>
    </div>
    {showCreate && <form className="owner-staff-form" onSubmit={createStaff}>
      <h3>Create individual staff login</h3>
      <div className="owner-staff-fields">
        <label>Staff name<input value={displayName} onChange={event => setDisplayName(event.target.value)} required maxLength={100}/></label>
        <label>Login ID<input value={loginId} onChange={event => setLoginId(event.target.value)} required minLength={3} maxLength={64} autoCapitalize="none"/><small>3–64 letters, numbers, dots, underscores or hyphens</small></label>
        <label>Temporary password<input value={password} onChange={event => setPassword(event.target.value)} type="password" required minLength={12} maxLength={256}/><small>At least 12 characters</small></label>
        <label>Role<select value={role} onChange={event => setRole(event.target.value as Staff['role'])}>{ROLES.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>
      </div>
      <p className="owner-staff-role-description">{ROLES.find(item => item.value === role)?.description}</p>
      <div className="owner-staff-actions"><button type="button" className="owner-staff-secondary" onClick={() => setShowCreate(false)}>Cancel</button><button type="submit" className="owner-staff-primary" disabled={busy === 'create'}>{busy === 'create' ? 'Creating…' : 'Create account'}</button></div>
    </form>}
    {error && <div className="owner-staff-error"><AlertCircle size={15}/>{error}</div>}
    {notice && <div className="owner-staff-notice"><Check size={15}/>{notice}</div>}
    {loading ? <div className="owner-home-state">Loading staff accounts…</div> :
      staff.length === 0 ? <div className="owner-home-state"><UserRound size={22}/><b>No staff accounts yet</b><p>Add each team member with their own login ID and role.</p></div> :
      <div className="owner-staff-list">{staff.map(person => <article className="owner-staff-row" key={person.staff_id}>
        <div className="owner-staff-avatar"><UserRound size={18}/></div>
        <div className="owner-staff-details"><b>{person.display_name}</b><span>{person.login_id}</span><small>{person.last_login_at ? 'Last login ' + new Date(person.last_login_at).toLocaleString() : 'Never signed in'}</small></div>
        <div className="owner-staff-controls">
          <select aria-label={'Role for ' + person.display_name} value={person.role} onChange={event => void changeRole(person, event.target.value as Staff['role'])} disabled={busy === person.staff_id || !person.active}>
            {ROLES.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}
          </select>
          <button type="button" className="owner-staff-secondary" onClick={() => { setResetFor(resetFor === person.staff_id ? '' : person.staff_id); setResetPassword('') }}><KeyRound size={13}/> Reset password</button>
          <button type="button" className={person.active ? 'owner-staff-danger' : 'owner-staff-primary'} onClick={() => void toggleActive(person)} disabled={busy === person.staff_id}>{person.active ? <><UserX size={13}/> Suspend</> : <><Check size={13}/> Reactivate</>}</button>
        </div>
        {resetFor === person.staff_id && <form className="owner-staff-reset" onSubmit={savePassword}>
          <label>New password<input value={resetPassword} onChange={event => setResetPassword(event.target.value)} type="password" minLength={12} maxLength={256} required/></label>
          <button className="owner-staff-primary" type="submit" disabled={busy === person.staff_id}>Save password</button>
        </form>}
      </article>)}</div>}
  </section>
}
