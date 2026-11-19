import { useState, type FormEvent } from 'react'
import { ArrowRight, KeyRound } from 'lucide-react'

const API_BASE = (import.meta.env.VITE_API_BASE_URL || '/api').replace(/\/$/, '')

export default function PasswordReset() {
  const token = new URLSearchParams(window.location.search).get('token') || ''
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)
  const [error, setError] = useState('')

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setError('')
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) { setError('This reset link is invalid or expired.'); return }
    if (password.length < 12 || password.length > 256) { setError('Use a password between 12 and 256 characters.'); return }
    if (password !== confirm) { setError('The passwords do not match.'); return }
    setBusy(true)
    try {
      const response = await fetch(API_BASE + '/auth/password-reset/complete', {
        method: 'POST', credentials: 'same-origin',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, password }), cache: 'no-store',
      })
      const payload = await response.json().catch(() => ({})) as { error?: string; password_reset?: boolean }
      if (!response.ok || !payload.password_reset) throw new Error(payload.error === 'invalid_or_expired_reset_link' ? 'This reset link has expired or has already been used. Request a new one.' : 'Password reset could not be completed.')
      setDone(true)
      window.history.replaceState({}, document.title, '/owner/reset-password')
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Password reset failed.') }
    finally { setBusy(false) }
  }

  return <main className="signin-screen"><section className="signin-card">
    <div className="signin-brand"><div className="signin-mark"><KeyRound size={23}/></div><div><b>platform<span>core</span></b><small>ACCOUNT RECOVERY</small></div></div>
    {done ? <>
      <div className="signin-icon"><KeyRound size={22}/></div><span className="signin-eyebrow">PASSWORD UPDATED</span>
      <h1>You are all set</h1><p>Your password has been changed and existing sessions have been signed out. Sign in with your new password.</p>
      <a className="signin-button" href="/owner">Continue to sign in <ArrowRight size={16}/></a>
    </> : <>
      <div className="signin-icon"><KeyRound size={22}/></div><span className="signin-eyebrow">ACCOUNT RECOVERY</span>
      <h1>Create a new password</h1><p>Choose a new password of at least 12 characters.</p>
      {error && <p className="signin-error" role="alert">{error}</p>}
      <form className="signin-form" onSubmit={submit}>
        <label>New password<input value={password} onChange={event => setPassword(event.target.value)} type="password" autoComplete="new-password" minLength={12} maxLength={256} required/></label>
        <label>Confirm new password<input value={confirm} onChange={event => setConfirm(event.target.value)} type="password" autoComplete="new-password" minLength={12} maxLength={256} required/></label>
        <button className="signin-button" type="submit" disabled={busy}>{busy ? 'Updating…' : 'Reset password'} <ArrowRight size={16}/></button>
      </form>
    </>}
  </section></main>
}
