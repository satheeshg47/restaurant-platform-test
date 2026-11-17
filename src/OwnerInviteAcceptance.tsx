import { useEffect, useState } from 'react'
import { ArrowRight, CheckCircle2, ShieldAlert } from 'lucide-react'

type Props = { accessToken: string; idToken: string; apiBaseUrl: string; onAccepted: () => void; onSignOut: () => void }

export default function OwnerInviteAcceptance({ accessToken, idToken, apiBaseUrl, onAccepted, onSignOut }: Props) {
  const [state, setState] = useState<'checking' | 'ready' | 'sending' | 'accepted' | 'error'>('checking')
  const [token, setToken] = useState('')
  const [message, setMessage] = useState('')
  const base = apiBaseUrl.replace(/\/$/, '')

  useEffect(() => {
    const saved = sessionStorage.getItem('platformcore.owner.invitation.token') || ''
    if (/^[A-Za-z0-9_-]{43}$/.test(saved)) {
      setToken(saved)
      setState('ready')
    } else {
      setState('error')
      setMessage('This invitation link is missing or invalid. Ask the platform administrator to send a new link.')
    }
  }, [])

  const accept = async () => {
    if (!token || state !== 'ready') return
    if (!idToken) { setState('error'); setMessage('Your verified sign-in session is missing. Sign in again to accept this invitation.'); return }
    setState('sending'); setMessage('')
    try {
      const response = await fetch(base + '/owner/invitations/accept', {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: 'Bearer ' + accessToken, 'X-OIDC-ID-Token': idToken },
        body: JSON.stringify({ token }),
        cache: 'no-store',
      })
      const payload = await response.json().catch(() => ({})) as { error?: string; tenant?: { name?: string } }
      if (!response.ok) {
        const errors: Record<string, string> = {
          invitation_not_found: 'This invitation is invalid, already used or has been revoked.',
          invitation_expired: 'This invitation has expired. Ask the platform administrator for a new one.',
          invitation_email_mismatch: 'Sign in with the verified email address that received this invitation.',
          verified_email_required: 'Your identity provider must return a verified email address.',
          active_owner_already_exists: 'This restaurant already has an active owner.',
          tenant_not_active: 'This restaurant is currently inactive.',
        }
        throw new Error(errors[payload.error || ''] || payload.error || 'The invitation could not be accepted.')
      }
      sessionStorage.removeItem('platformcore.owner.invitation.token')
      setToken('')
      setState('accepted')
      setMessage('You are now the owner of ' + (payload.tenant?.name || 'this restaurant') + '.')
    } catch (cause) {
      setState('error')
      setMessage(cause instanceof Error ? cause.message : 'The invitation could not be accepted.')
    }
  }

  return <main className="signin-screen"><section className="signin-card">
    <div className="signin-brand"><div className="signin-mark"><CheckCircle2 size={23}/></div><div><b>platform<span>core</span></b><small>OWNER INVITATION</small></div></div>
    {state === 'accepted' ? <><div className="signin-icon"><CheckCircle2 size={22}/></div><span className="signin-eyebrow">INVITATION ACCEPTED</span><h1>Welcome aboard</h1><p>{message}</p><button className="signin-button" onClick={onAccepted}>Open owner support <ArrowRight size={16}/></button></> :
      <><div className="signin-icon"><ShieldAlert size={22}/></div><span className="signin-eyebrow">RESTAURANT OWNER ACCESS</span><h1>Accept your invitation</h1><p>Confirm your invitation to link your verified account to this restaurant.</p>{message && <p className="signin-error" role="alert">{message}</p>}{state === 'error' && token && <div className="modal-actions"><button className="button secondary" onClick={() => setState('ready')}>Try again</button><button className="button secondary" onClick={onSignOut}>Sign out to switch account</button></div>}<button className="signin-button" onClick={() => void accept()} disabled={state !== 'ready'}>{state === 'sending' ? 'Accepting invitation…' : state === 'checking' ? 'Checking invitation…' : 'Accept invitation'}{state === 'ready' && <ArrowRight size={16}/>}</button></>}
    <div className="signin-foot">The invitation is one-time use and must match the verified email address it was issued to.</div>
  </section></main>
}
