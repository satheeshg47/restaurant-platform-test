import { useEffect, useState, type FormEvent } from 'react'
import { ArrowRight, LockKeyhole, ShieldCheck, Store, Copy, KeyRound } from 'lucide-react'
import QRCode from 'qrcode'
import { beginOidcLogin, getOidcSettings } from './auth'

type Props = {
  role: 'admin' | 'owner' | 'staff'
  error?: string
  returnPath?: string
  bootstrapAvailable?: boolean
  encryptionReady?: boolean
  onAuthenticated?: () => void
}
type Phase = 'credentials' | 'bootstrap' | 'mfa' | 'enroll' | 'recovery'

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
  const [challengeToken, setChallengeToken] = useState('')
  const [code, setCode] = useState('')
  const [provisioningUri, setProvisioningUri] = useState('')
  const [qrDataUrl, setQrDataUrl] = useState('')
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([])
  const configured = Boolean(getOidcSettings())
  const isAdmin = role === 'admin'
  const isOwner = role === 'owner'
  const totpSecret = (() => {
    try { return provisioningUri ? new URL(provisioningUri).searchParams.get('secret') || '' : '' }
    catch { return '' }
  })()

  useEffect(() => {
    setPhase(bootstrapAvailable ? 'bootstrap' : 'credentials')
  }, [bootstrapAvailable])

  useEffect(() => {
    let active = true
    if (!provisioningUri) { setQrDataUrl(''); return }
    QRCode.toDataURL(provisioningUri, { width: 190, margin: 1, errorCorrectionLevel: 'M' })
      .then(value => { if (active) setQrDataUrl(value) })
      .catch(() => { if (active) setQrDataUrl('') })
    return () => { active = false }
  }, [provisioningUri])

  const signInOidc = async () => {
    setBusy(true)
    setError('')
    try { await beginOidcLogin(returnPath || (isAdmin ? '/' : role === 'staff' ? '/staff' : '/owner')) }
    catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Sign-in could not be started.')
      setBusy(false)
    }
  }

  const startLogin = async (id: string, secret: string) => {
    const response = await fetch(API_BASE + '/auth/login', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ login_id: id, password: secret }),
      cache: 'no-store',
    })
    const payload = await response.json().catch(() => ({})) as {
      error?: string
      authenticated?: boolean
      mfa_required?: boolean
      totp_enrollment_required?: boolean
      challenge_token?: string
      provisioning_uri?: string
    }
    if (!response.ok) {
      const errors: Record<string, string> = {
        invalid_credentials: 'The login ID or password is incorrect.',
        too_many_attempts: 'Too many attempts. Wait a while before trying again.',
        totp_encryption_not_configured: 'The administrator security key is not configured yet.',
      }
      throw new Error(errors[payload.error || ''] || payload.error || 'Sign-in failed.')
    }
    if (payload.authenticated) { onAuthenticated?.(); return }
    if (payload.challenge_token && payload.totp_enrollment_required && payload.provisioning_uri) {
      setChallengeToken(payload.challenge_token)
      setProvisioningUri(payload.provisioning_uri)
      setCode('')
      setPhase('enroll')
      return
    }
    if (payload.challenge_token && payload.mfa_required) {
      setChallengeToken(payload.challenge_token)
      setCode('')
      setPhase('mfa')
      return
    }
    throw new Error('The authentication server returned an unexpected response.')
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
    if (!encryptionReady) { setError('The AUTH_ENCRYPTION_KEY secret must be configured before creating the first administrator.'); return }
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
          bootstrap_not_configured: 'The AUTH_BOOTSTRAP_SECRET secret is not configured on the Worker.',
          totp_encryption_not_configured: 'The AUTH_ENCRYPTION_KEY secret is not configured on the Worker.',
        }
        throw new Error(errors[payload.error || ''] || payload.error || 'Administrator setup failed.')
      }
      setBootstrapSecret('')
      setNotice('Administrator created. Complete the authenticator setup to finish sign-in.')
      await startLogin(loginId.trim(), password)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Administrator setup failed.')
    } finally { setBusy(false) }
  }

  const verifyCode = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setBusy(true); setError(''); setNotice('')
    try {
      const enrollment = phase === 'enroll'
      const response = await fetch(API_BASE + (enrollment ? '/auth/totp/enroll/verify' : '/auth/totp/verify'), {
        method: 'POST',
        credentials: 'same-origin',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ challenge_token: challengeToken, code: code.trim() }),
        cache: 'no-store',
      })
      const payload = await response.json().catch(() => ({})) as { error?: string; authenticated?: boolean; recovery_codes?: string[] }
      if (!response.ok || !payload.authenticated) {
        const errors: Record<string, string> = {
          invalid_code: 'That code is not valid. Check your authenticator and try again.',
          invalid_or_expired_challenge: 'This security challenge expired. Sign in again.',
          challenge_already_used: 'This challenge has already been used. Sign in again.',
        }
        throw new Error(errors[payload.error || ''] || payload.error || 'Verification failed.')
      }
      if (enrollment && Array.isArray(payload.recovery_codes) && payload.recovery_codes.length) {
        setRecoveryCodes(payload.recovery_codes)
        setPhase('recovery')
      } else {
        onAuthenticated?.()
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Verification failed.')
    } finally { setBusy(false) }
  }

  const copyRecoveryCodes = async () => {
    try {
      await navigator.clipboard.writeText(recoveryCodes.join('\n'))
      setNotice('Recovery codes copied. Store them somewhere private.')
    } catch { setNotice('Copy is unavailable on this browser. Save the codes shown below manually.') }
  }

  const finishRecovery = () => {
    setRecoveryCodes([])
    onAuthenticated?.()
  }

  return <main className="signin-screen">
    <section className="signin-card">
      <div className="signin-brand"><div className="signin-mark">{isAdmin ? <ShieldCheck size={23}/> : <Store size={23}/>}</div><div><b>platform<span>core</span></b><small>{isAdmin ? 'CONTROL PLANE' : isOwner ? 'RESTAURANT OWNER' : 'STAFF ACCOUNT'}</small></div></div>
      <div className="signin-icon">{phase === 'recovery' ? <KeyRound size={22}/> : <LockKeyhole size={22}/>}</div>
      <span className="signin-eyebrow">{phase === 'recovery' ? 'SAVE YOUR RECOVERY CODES' : isAdmin ? 'SUPER ADMIN ACCESS' : isOwner ? 'OWNER ACCOUNT ACCESS' : 'STAFF ACCOUNT ACCESS'}</span>
      <h1>{phase === 'bootstrap' ? 'Set up the first administrator' : phase === 'enroll' ? 'Secure your account' : phase === 'mfa' ? 'Verify your identity' : phase === 'recovery' ? 'Keep these codes safe' : isAdmin ? 'Sign in to Platform Core' : isOwner ? 'Welcome back' : 'Staff sign in'}</h1>
      <p>{phase === 'bootstrap'
        ? 'Create the first Super Admin account. This one-time setup requires the two Worker secrets configured by the platform operator.'
        : phase === 'enroll'
          ? 'Scan this QR code with Google Authenticator or another compatible authenticator, then enter the six-digit code.'
          : phase === 'mfa'
            ? 'Enter the six-digit code from your authenticator. A single-use recovery code also works.'
            : phase === 'recovery'
              ? 'These recovery codes are shown only once. Save them privately before continuing.'
              : isAdmin
                ? 'Sign in with your individual administrator login ID and password.'
                : isOwner ? 'Sign in with your individual owner login ID and password.' : 'Sign in with the individual login ID and password assigned by your restaurant owner.'}
      </p>

      {phase === 'credentials' && <form className="signin-form" onSubmit={submitCredentials}>
        <label>Login ID<input value={loginId} onChange={event => setLoginId(event.target.value)} autoComplete="username" required minLength={3} maxLength={64}/></label>
        <label>Password<input value={password} onChange={event => setPassword(event.target.value)} type="password" autoComplete="current-password" required maxLength={256}/></label>
        <button className="signin-button" type="submit" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}{!busy && <ArrowRight size={16}/>}</button>
        {bootstrapAvailable && isAdmin && <button className="signin-link" type="button" onClick={() => { setPhase('bootstrap'); setError('') }}>Set up the first Super Admin account</button>}
      </form>}

      {phase === 'bootstrap' && <form className="signin-form" onSubmit={submitBootstrap}>
        {!encryptionReady && <div className="signin-setup"><b>Security key required</b><p>Configure AUTH_ENCRYPTION_KEY and AUTH_BOOTSTRAP_SECRET as Worker secrets before continuing.</p></div>}
        <label>One-time bootstrap secret<input value={bootstrapSecret} onChange={event => setBootstrapSecret(event.target.value)} type="password" autoComplete="off" required/></label>
        <label>Administrator login ID<input value={loginId} onChange={event => setLoginId(event.target.value)} autoComplete="username" required minLength={3} maxLength={64}/></label>
        <label>Email (optional)<input value={email} onChange={event => setEmail(event.target.value)} type="email" autoComplete="email"/></label>
        <label>Create password<input value={password} onChange={event => setPassword(event.target.value)} type="password" autoComplete="new-password" required minLength={12} maxLength={256}/><small>Use at least 12 characters.</small></label>
        <button className="signin-button" type="submit" disabled={busy || !encryptionReady}>{busy ? 'Creating administrator…' : 'Create Super Admin'}{!busy && <ArrowRight size={16}/>}</button>
        <button className="signin-link" type="button" onClick={() => { setPhase('credentials'); setError('') }}>Back to sign in</button>
      </form>}

      {(phase === 'mfa' || phase === 'enroll') && <form className="signin-form" onSubmit={verifyCode}>
        {phase === 'enroll' && <div className="totp-enrollment">
          {qrDataUrl ? <img src={qrDataUrl} alt="Authenticator setup QR code"/> : <div className="totp-qr-placeholder">Preparing secure QR code…</div>}
          <small>Can’t scan? Enter this setup key manually:</small><code>{totpSecret || 'Loading setup key…'}</code>
        </div>}
        <label>{phase === 'enroll' ? 'Authenticator code' : 'Authenticator or recovery code'}<input value={code} onChange={event => setCode(event.target.value)} inputMode="text" autoComplete="one-time-code" autoFocus required maxLength={24} placeholder={phase === 'enroll' ? '123456' : '6-digit or recovery code'}/></label>
        <button className="signin-button" type="submit" disabled={busy || !code.trim()}>{busy ? 'Verifying…' : phase === 'enroll' ? 'Enable two-factor authentication' : 'Verify and sign in'}{!busy && <ArrowRight size={16}/>}</button>
      </form>}

      {phase === 'recovery' && <div className="signin-recovery">
        <div className="recovery-code-list">{recoveryCodes.map(item => <code key={item}>{item}</code>)}</div>
        <button className="signin-button" type="button" onClick={() => void copyRecoveryCodes()}><Copy size={15}/> Copy recovery codes</button>
        <button className="signin-button" type="button" onClick={finishRecovery}>I’ve saved my codes <ArrowRight size={16}/></button>
      </div>}

      {error && <p className="signin-error" role="alert">{error}</p>}
      {notice && <p className="signin-notice" role="status">{notice}</p>}
      {phase === 'credentials' && configured && role !== 'staff' && <div className="signin-alternative"><span>OR</span><button className="signin-button secondary" type="button" onClick={() => void signInOidc()} disabled={busy}>{busy ? 'Connecting securely…' : 'Continue with existing identity provider'}{!busy && <ArrowRight size={16}/>}</button></div>}
      <div className="signin-foot"><LockKeyhole size={13}/> Native sessions use secure HTTP-only cookies. Native administrator and owner accounts require authenticator verification. Legacy identity-provider sign-in remains available during migration.</div>
    </section>
  </main>
}
