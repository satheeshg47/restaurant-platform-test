import { useState } from 'react'
import { ArrowRight, LockKeyhole, ShieldCheck, Store } from 'lucide-react'
import { beginOidcLogin, getOidcSettings } from './auth'

type Props = { role: 'admin' | 'owner'; error?: string; returnPath?: string }

export default function SignIn({ role, error: initialError = '', returnPath }: Props) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(initialError)
  const configured = Boolean(getOidcSettings())
  const isAdmin = role === 'admin'

  const signIn = async () => {
    setBusy(true); setError('')
    try { await beginOidcLogin(returnPath || (isAdmin ? '/' : '/owner')) }
    catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Sign-in could not be started.')
      setBusy(false)
    }
  }

  return <main className="signin-screen">
    <section className="signin-card">
      <div className="signin-brand"><div className="signin-mark">{isAdmin ? <ShieldCheck size={23}/> : <Store size={23}/>}</div><div><b>platform<span>core</span></b><small>{isAdmin ? 'CONTROL PLANE' : 'RESTAURANT OWNER'}</small></div></div>
      <div className="signin-icon"><LockKeyhole size={22}/></div>
      <span className="signin-eyebrow">{isAdmin ? 'SUPER ADMIN ACCESS' : 'OWNER ACCOUNT ACCESS'}</span>
      <h1>{isAdmin ? 'Sign in to Platform Core' : 'Welcome back'}</h1>
      <p>{isAdmin ? 'Secure access for the platform administrator.' : 'Sign in to contact the platform team and manage your restaurant account.'}</p>
      {configured ? <button className="signin-button" onClick={() => void signIn()} disabled={busy}>{busy ? 'Connecting securely…' : 'Continue with secure sign-in'}{!busy && <ArrowRight size={16}/>}</button> : <div className="signin-setup"><b>Identity provider setup required</b><p>Configure the OIDC issuer, public client ID and API audience in the frontend environment, then match the issuer, API audience and JWKS URL in the API environment.</p></div>}
      {error && <p className="signin-error" role="alert">{error}</p>}
      <div className="signin-foot"><LockKeyhole size={13}/> Uses OpenID Connect authorization code flow with PKCE. Tokens are kept in memory only.</div>
    </section>
  </main>
}
