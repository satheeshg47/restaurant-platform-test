import { useEffect, useState, type FormEvent } from 'react'
import { ArrowRight, CheckCircle2, ShieldAlert } from 'lucide-react'
import { apiFetch } from './auth'
import SignIn from './SignIn'

type Props = {
  accessToken: string
  idToken: string
  apiBaseUrl: string
  onAuthenticated: () => void
  onSignOut: () => void
  onCompleted: () => void
}
type State = 'checking' | 'setup' | 'signin' | 'ready' | 'sending' | 'done' | 'error'

export default function OwnerTransferAcceptance({ accessToken, idToken, apiBaseUrl, onAuthenticated, onSignOut, onCompleted }: Props) {
  const [state, setState] = useState<State>('checking')
  const [token, setToken] = useState('')
  const [password, setPassword] = useState('')
  const [message, setMessage] = useState('')
  const base = apiBaseUrl.replace(/\/$/, '')

  useEffect(() => {
    const saved = sessionStorage.getItem('platformcore.owner.transfer.token') || ''
    if (/^[A-Za-z0-9_-]{43}$/.test(saved)) {
      setToken(saved)
      setState(accessToken || idToken ? 'ready' : 'setup')
    } else {
      setState('error')
      setMessage('This transfer invitation is missing or invalid. Contact the platform administrator.')
    }
  }, [])

  useEffect(() => {
    if (token && (accessToken || idToken) && (state === 'setup' || state === 'signin')) {
      setState('ready')
      setMessage('')
    }
  }, [accessToken, idToken, token, state])

  const accept = async (event?: FormEvent<HTMLFormElement>) => {
    event?.preventDefault()
    if (!token || !['ready', 'setup'].includes(state)) return
    if (!accessToken && !idToken && (password.length < 12 || password.length > 256)) {
      setState('error'); setMessage('Choose a password of at least 12 characters.'); return
    }
    setState('sending'); setMessage('')
    try {
      const headers: Record<string, string> = { Accept: 'application/json', 'Content-Type': 'application/json' }
      if (idToken) headers['X-OIDC-ID-Token'] = idToken
      const response = await apiFetch(base + '/owner/transfers/accept', {
        method: 'POST', headers, credentials: 'same-origin',
        body: JSON.stringify({ token, ...(!accessToken && !idToken ? { password } : {}) }), cache: 'no-store',
      })
      const payload = await response.json().catch(() => ({})) as { error?: string; transferred?: boolean }
      if (!response.ok || !payload.transferred) {
        if (payload.error === 'sign_in_to_existing_account') {
          setState('signin'); setMessage('An account already exists for this email. Sign in with that account to accept the transfer.'); return
        }
        const errors: Record<string, string> = {
          transfer_email_mismatch: 'Sign in with the email address that received this transfer invitation.',
          transfer_invitation_expired: 'This transfer invitation has expired. Ask the administrator to start a new transfer.',
          transfer_invitation_not_found: 'This transfer invitation is invalid, revoked or already used.',
          tenant_not_active: 'This restaurant is currently inactive.',
        }
        throw new Error(errors[payload.error || ''] || 'The ownership transfer could not be completed.')
      }
      sessionStorage.removeItem('platformcore.owner.transfer.token')
      setToken(''); setState('done')
      setMessage('Ownership has been transferred. The restaurant data and history remain with the business.')
    } catch (cause) {
      setState('error'); setMessage(cause instanceof Error ? cause.message : 'The ownership transfer could not be completed.')
    }
  }

  if (state === 'signin') return <SignIn role="owner" returnPath="/owner/transfers/accept" error={message} onAuthenticated={onAuthenticated}/>
  return <main className="signin-screen"><section className="signin-card">
    <div className="signin-brand"><div className="signin-mark"><CheckCircle2 size={23}/></div><div><b>platform<span>core</span></b><small>OWNERSHIP TRANSFER</small></div></div>
    {state === 'done' ? <>
      <div className="signin-icon"><CheckCircle2 size={22}/></div><span className="signin-eyebrow">TRANSFER COMPLETE</span><h1>Welcome as the new Owner</h1><p>{message}</p>
      <button className="signin-button" onClick={onCompleted}>Continue <ArrowRight size={16}/></button>
    </> : <>
      <div className="signin-icon"><ShieldAlert size={22}/></div><span className="signin-eyebrow">RESTAURANT OWNERSHIP</span><h1>Accept ownership transfer</h1>
      <p>{accessToken || idToken ? 'Confirm that you accept ownership of this restaurant.' : 'Create a password to accept ownership. If you already have an account, sign in instead.'}</p>
      {message && <p className="signin-error" role="alert">{message}</p>}
      {state === 'setup' && <form className="signin-form" onSubmit={event => void accept(event)}>
        <label>Create password<input value={password} onChange={event => setPassword(event.target.value)} type="password" required minLength={12} maxLength={256} autoComplete="new-password"/></label>
        <button className="signin-button" type="submit">Accept ownership <ArrowRight size={16}/></button>
      </form>}
      {state === 'ready' && <button className="signin-button" onClick={() => void accept()}>Accept ownership <ArrowRight size={16}/></button>}
      {state === 'sending' && <div className="owner-home-state">Completing secure ownership transfer…</div>}
      {state === 'error' && <button className="signin-button" onClick={() => setState(accessToken || idToken ? 'ready' : 'setup')}>Try again</button>}
      {(accessToken || idToken) && <button className="signin-link" type="button" onClick={onSignOut}>Sign out to switch account</button>}
    </>}
  </section></main>
}
