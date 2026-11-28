import { useEffect, useState, type FormEvent } from 'react'
import { ArrowRight, CheckCircle2, ShieldAlert } from 'lucide-react'
import { apiFetch } from './auth'
import SignIn from './SignIn'

type Props = {
  accessToken: string
  apiBaseUrl: string
  onAccepted: () => void
  onSignOut: () => void
  onAuthenticated: () => void
}
type State = 'checking' | 'setup' | 'signin' | 'ready' | 'sending' | 'accepted' | 'error'

export default function OwnerInviteAcceptance({ accessToken, apiBaseUrl, onAccepted, onSignOut, onAuthenticated }: Props) {
  const [state, setState] = useState<State>('checking')
  const [token, setToken] = useState('')
  const [loginId, setLoginId] = useState('')
  const [password, setPassword] = useState('')
  const [message, setMessage] = useState('')
  const [accountCreated, setAccountCreated] = useState(false)
  const base = apiBaseUrl.replace(/\/$/, '')

  useEffect(() => {
    const saved = sessionStorage.getItem('platformcore.owner.invitation.token') || ''
    if (/^[A-Za-z0-9_-]{43}$/.test(saved)) {
      setToken(saved)
      setState(accessToken ? 'ready' : 'setup')
    } else {
      setState('error')
      setMessage('This invitation link is missing or invalid. Ask the platform administrator to send a new link.')
    }
  }, [])

  useEffect(() => {
    if (token && accessToken && (state === 'setup' || state === 'signin')) {
      setState('ready')
      setMessage('')
    }
  }, [accessToken, token, state])

  const accept = async (event?: FormEvent<HTMLFormElement>) => {
    event?.preventDefault()
    if (!token || state !== 'ready' && state !== 'setup') return
    const creatingAccount = !accessToken
    if (creatingAccount && (!/^[A-Za-z0-9._-]{3,64}$/.test(loginId.trim()) || password.length < 12 || password.length > 256)) {
      setState('error')
      setMessage('Choose a login ID (3–64 letters, numbers, dots, underscores or hyphens) and a password of at least 12 characters.')
      return
    }
    setState('sending')
    setMessage('')
    try {
      const headers: Record<string, string> = { Accept: 'application/json', 'Content-Type': 'application/json' }
      const response = await apiFetch(base + '/owner/invitations/accept', {
        method: 'POST',
        headers,
        credentials: 'same-origin',
        body: JSON.stringify({
          token,
          ...(creatingAccount ? { login_id: loginId.trim(), password } : {}),
        }),
        cache: 'no-store',
      })
      const payload = await response.json().catch(() => ({})) as { error?: string; tenant?: { name?: string }; account_created?: boolean }
      if (!response.ok) {
        const errors: Record<string, string> = {
          invitation_not_found: 'This invitation is invalid, already used or has been revoked.',
          invitation_expired: 'This invitation has expired. Ask the platform administrator for a new one.',
          invitation_email_mismatch: 'Sign in with the account that matches the invited email address.',
          active_owner_already_exists: 'This restaurant already has an active owner.',
          tenant_not_active: 'This restaurant is currently inactive.',
          owner_auth_not_configured: 'Owner account setup is temporarily unavailable because the Worker encryption key is not configured.',
          native_account_exists_sign_in: 'An owner account already exists for this email. Sign in to that account, then accept the invitation.',
          login_id_unavailable: 'That login ID is already in use. Choose another one.',
          invalid_account_details: 'Check the login ID and password requirements.',
        }
        if (payload.error === 'native_account_exists_sign_in') {
          setState('signin')
          setMessage(errors[payload.error])
          return
        }
        throw new Error(errors[payload.error || ''] || payload.error || 'The invitation could not be accepted.')
      }
      sessionStorage.removeItem('platformcore.owner.invitation.token')
      setToken('')
      setAccountCreated(payload.account_created === true)
      setState('accepted')
      setMessage(payload.account_created
        ? 'Your owner login has been created for ' + (payload.tenant?.name || 'this restaurant') + '. Sign in using your email or username and password.'
        : 'You are now the owner of ' + (payload.tenant?.name || 'this restaurant') + '.')
    } catch (cause) {
      setState('error')
      setMessage(cause instanceof Error ? cause.message : 'The invitation could not be accepted.')
    }
  }

  if (state === 'signin') {
    return <SignIn role="owner" returnPath="/owner/invitations/accept" error={message} onAuthenticated={onAuthenticated}/>
  }

  return <main className="signin-screen"><section className="signin-card">
    <div className="signin-brand"><div className="signin-mark"><CheckCircle2 size={23}/></div><div><b>platform<span>core</span></b><small>OWNER INVITATION</small></div></div>
    {state === 'accepted' ? <>
      <div className="signin-icon"><CheckCircle2 size={22}/></div>
      <span className="signin-eyebrow">INVITATION ACCEPTED</span>
      <h1>{accountCreated ? 'Your owner account is ready' : 'Welcome aboard'}</h1>
      <p>{message}</p>
      <button className="signin-button" onClick={onAccepted}>{accountCreated ? 'Continue to sign in' : 'Open owner workspace'} <ArrowRight size={16}/></button>
    </> : <>
      <div className="signin-icon"><ShieldAlert size={22}/></div>
      <span className="signin-eyebrow">RESTAURANT OWNER ACCESS</span>
      <h1>{state === 'setup' ? 'Create your owner account' : 'Accept your invitation'}</h1>
      <p>{state === 'setup'
        ? 'Create an individual login using the one-time invitation sent by the platform administrator. The invitation verifies the invited email address; use your email or username and password to sign in.'
        : 'Confirm your invitation to link your account to this restaurant.'}</p>
      {message && <p className="signin-error" role="alert">{message}</p>}
      {state === 'setup' && <form className="signin-form" onSubmit={event => void accept(event)}>
        <label>Choose a login ID<input value={loginId} onChange={event => setLoginId(event.target.value)} required minLength={3} maxLength={64} autoComplete="username"/></label>
        <label>Create password<input value={password} onChange={event => setPassword(event.target.value)} type="password" required minLength={12} maxLength={256} autoComplete="new-password"/><small>Use at least 12 characters.</small></label>
        <button className="signin-button" type="submit">Create account & accept invitation <ArrowRight size={16}/></button>
      </form>}
      {state === 'ready' && <button className="signin-button" onClick={() => void accept()}>Accept invitation <ArrowRight size={16}/></button>}
      {state === 'sending' && <div className="owner-home-state">Verifying invitation and creating your secure owner account…</div>}
      {state === 'error' && <button className="signin-button" onClick={() => setState(accessToken || idToken ? 'ready' : 'setup')}>Try again</button>}
      {accessToken && <button className="signin-link" type="button" onClick={onSignOut}>Sign out to switch account</button>}
    </>}
    <div className="signin-foot">The invitation is one-time use and expires after 48 hours. Sign in with email or username and password.</div>
  </section></main>
}
