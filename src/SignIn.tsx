import { useState, type FormEvent } from 'react'
import { ArrowRight, LockKeyhole, ShieldCheck, Store } from 'lucide-react'

type Props = {
  role: 'admin' | 'owner' | 'staff'
  error?: string
  returnPath?: string
  bootstrapAvailable?: boolean
  encryptionReady?: boolean
  onAuthenticated?: () => void
}
type Phase = 'credentials' | 'bootstrap'

const API_BASE = (import.meta.env.VITE_API_BASE_URL || '/api').replace(/\/$/, '')

export default function SignIn({
  role,
  error: initialError = '',
  returnPath,
  bootstrapAvailable = false,
  encryptionReady = false,
  onAuthenticated,
}: Props) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(initialError)
  const [notice, setNotice] = useState('')
  const [phase, setPhase] = useState<Phase>(bootstrapAvailable ? 'bootstrap' : 'credentials')
  const [loginId, setLoginId] = useState('')
  const [password, setPassword] = useState('')
  const [bootstrapSecret, setBootstrapSecret] = useState('')
  const [email, setEmail] = useState('')
  const isAdmin = role === 'admin'
  const isOwner = role === 'owner'

  const startLogin = async (id: string, secret: string) => {
    const response = await fetch(API_BASE + '/auth/login', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ login_id: id, password: secret }),
      cache: 'no-store',
    })
    const payload = await response.json().catch(() => ({})) as { error?: string; authenticated?: boolean }
    if (!response.ok || !payload.authenticated) {
      const errors: Record<string, string> = {
        invalid_credentials: 'The email/username or password is incorrect.',
        too_many_attempts: 'Too many attempts. Wait a while before trying again.',
      }
      throw new Error(errors[payload.error || ''] || payload.error || 'Sign-in failed.')
    }
    onAuthenticated?.()
  }

  const submitCredentials = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setBusy(true); setError(''); setNotice('')
    try { await startLogin(loginId.trim(), password) }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Sign-in failed.') }
    finally { setBusy(false) }
  }

  const submitBootstrap = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setBusy(true); setError(''); setNotice('')
    try {
      const response = await fetch(API_BASE + '/auth/bootstrap-admin', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          bootstrap_secret: bootstrapSecret,
          login_id: loginId.trim(),
          password,
          email: email.trim(),
        }),
        cache: 'no-store',
      })
      const payload = await response.json().catch(() => ({})) as { error?: string; created?: boolean }
      if (!response.ok || !payload.created) {
        const errors: Record<string, string> = {
          unauthorized: 'The one-time bootstrap secret is incorrect.',
          bootstrap_already_used: 'The first administrator has already been created. Sign in instead.',
          login_id_unavailable: 'That login ID is already in use.',
          invalid_login_id_format: 'Login ID must be 3–64 characters and use only English letters, numbers, dot (.), underscore (_) or hyphen (-). Do not include spaces.',
          invalid_password_length: 'Password must contain at least 12 characters and no more than 256.',
          invalid_email_format: 'The optional email address is not valid. Leave it blank if you do not want to add one.',
          bootstrap_not_configured: 'The AUTH_BOOTSTRAP_SECRET secret is not configured on the Worker.',
        }
        throw new Error(errors[payload.error || ''] || payload.error || 'Administrator setup failed.')
      }
      setBootstrapSecret('')
      setNotice('Administrator created. Signing you in…')
      await startLogin(loginId.trim(), password)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Administrator setup failed.')
    } finally { setBusy(false) }
  }

  return <main className="signin-screen">
    <section className="signin-card">
      <div className="signin-brand"><div className="signin-mark">{isAdmin ? <ShieldCheck size={23}/> : <Store size={23}/>}</div><div><b>platform<span>core</span></b><small>{isAdmin ? 'CONTROL PLANE' : isOwner ? 'RESTAURANT OWNER' : 'STAFF ACCOUNT'}</small></div></div>
      <div className="signin-icon"><LockKeyhole size={22}/></div>
      <span className="signin-eyebrow">{isAdmin ? 'SUPER ADMIN ACCESS' : isOwner ? 'OWNER ACCOUNT ACCESS' : 'STAFF ACCOUNT ACCESS'}</span>
      <h1>{phase === 'bootstrap' ? 'Set up the first administrator' : isAdmin ? 'Sign in to Platform Core' : isOwner ? 'Welcome back' : 'Staff sign in'}</h1>
      <p>{phase === 'bootstrap'
        ? 'Create the first Super Admin account using the one-time setup secret, email or username, and password.'
        : 'Sign in using your email address or username and password.'}
      </p>

      {phase === 'credentials' && <form className="signin-form" onSubmit={submitCredentials}>
        <label>Email or username<input value={loginId} onChange={event => setLoginId(event.target.value)} autoComplete="username" required minLength={3} maxLength={320}/></label>
        <label>Password<input value={password} onChange={event => setPassword(event.target.value)} type="password" autoComplete="current-password" required maxLength={256}/></label>
        <button className="signin-button" type="submit" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}{!busy && <ArrowRight size={16}/>}</button>
        {bootstrapAvailable && isAdmin && <button className="signin-link" type="button" onClick={() => { setPhase('bootstrap'); setError('') }}>Set up the first Super Admin account</button>}
      </form>}

      {phase === 'bootstrap' && <form className="signin-form" onSubmit={submitBootstrap}>
        {!bootstrapAvailable && <div className="signin-setup"><b>Setup unavailable</b><p>The first administrator has already been created.</p></div>}
        <label>One-time bootstrap secret<input value={bootstrapSecret} onChange={event => setBootstrapSecret(event.target.value)} type="password" autoComplete="off" required/></label>
        <label>Administrator username<input value={loginId} onChange={event => setLoginId(event.target.value)} autoComplete="username" required minLength={3} maxLength={64}/></label>
        <label>Email (optional)<input value={email} onChange={event => setEmail(event.target.value)} type="email" autoComplete="email"/></label>
        <label>Create password<input value={password} onChange={event => setPassword(event.target.value)} type="password" autoComplete="new-password" required minLength={12} maxLength={256}/><small>Use at least 12 characters.</small></label>
        <button className="signin-button" type="submit" disabled={busy}>{busy ? 'Creating administrator…' : 'Create Super Admin'}{!busy && <ArrowRight size={16}/>}</button>
        <button className="signin-link" type="button" onClick={() => { setPhase('credentials'); setError('') }}>Back to sign in</button>
      </form>}



      {error && <p className="signin-error" role="alert">{error}</p>}
      {notice && <p className="signin-notice" role="status">{notice}</p>}
      <div className="signin-foot"><LockKeyhole size={13}/> Secure HTTP-only login session. Sign in with email or username and password.</div>
    </section>
  </main>
}
