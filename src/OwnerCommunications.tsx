import { useCallback, useEffect, useState } from 'react'
import { ArrowLeft, MessageCircle, Plus, RefreshCw, Send, ShieldAlert } from 'lucide-react'

type Tenant = { tenant_id: string; tenant_name: string; tenant_slug: string }
type Conversation = {
  id: string
  kind: 'support' | 'group' | 'announcement'
  subject: string
  status: 'open' | 'in_progress' | 'resolved'
  last_message?: string
  unread_count?: number
}
type Message = { id: string; sender_role: 'admin' | 'owner'; sender_subject: string; body: string; created_at: string }

type Props = {
  accessToken: string
  apiBaseUrl?: string
  title?: string
}

export default function OwnerCommunications({
  accessToken,
  apiBaseUrl = '/api',
  title = 'Messages & support',
}: Props) {
  const base = apiBaseUrl.replace(/\/$/, '')
  const [tenants, setTenants] = useState<Tenant[]>([])
  const [tenantId, setTenantId] = useState('')
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [selected, setSelected] = useState('')
  const [messages, setMessages] = useState<Message[]>([])
  const [showNew, setShowNew] = useState(false)
  const [subject, setSubject] = useState('')
  const [draft, setDraft] = useState('')
  const [reply, setReply] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const request = useCallback(async (path: string, init: RequestInit = {}) => {
    const response = await fetch(base + path, {
      ...init,
      headers: {
        Accept: 'application/json',
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        Authorization: 'Bearer ' + accessToken,
        ...init.headers,
      },
      cache: 'no-store',
    })
    const payload = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(payload.error || 'Messages could not be loaded.')
    return payload
  }, [base, accessToken])

  const withTenant = useCallback((path: string) => {
    const separator = path.includes('?') ? '&' : '?'
    return path + separator + 'tenant_id=' + encodeURIComponent(tenantId)
  }, [tenantId])

  const loadTenants = useCallback(async () => {
    if (!accessToken) return
    setLoading(true); setError('')
    try {
      const result = await request('/owner/communications/tenants')
      const available = Array.isArray(result.tenants) ? result.tenants as Tenant[] : []
      setTenants(available)
      setTenantId(current => available.some(item => item.tenant_id === current)
        ? current
        : available.length === 1 ? available[0].tenant_id : '')
      setConversations([]); setSelected(''); setMessages([])
      if (!available.length) setError('No active restaurant owner membership was found for this account.')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Restaurant memberships could not be loaded.')
    } finally { setLoading(false) }
  }, [accessToken, request])

  const refresh = useCallback(async () => {
    if (!accessToken || !tenantId) return
    setLoading(true); setError('')
    try {
      const result = await request(withTenant('/owner/communications'))
      setConversations(Array.isArray(result.conversations) ? result.conversations : [])
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Messages unavailable.')
    } finally { setLoading(false) }
  }, [accessToken, request, withTenant])

  useEffect(() => { void loadTenants() }, [loadTenants])
  useEffect(() => { void refresh() }, [refresh])

  const changeTenant = (nextTenantId: string) => {
    setTenantId(nextTenantId)
    setConversations([]); setSelected(''); setMessages([])
    setShowNew(false); setReply(''); setError('')
  }

  const openThread = async (id: string) => {
    setSelected(id); setShowNew(false); setMessages([]); setError('')
    try {
      const result = await request(withTenant('/owner/communications/' + encodeURIComponent(id)))
      setMessages(Array.isArray(result.messages) ? result.messages : [])
      await refresh()
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Conversation unavailable.') }
  }

  const startConversation = async () => {
    if (!tenantId || !subject.trim() || !draft.trim()) return
    setLoading(true); setError('')
    try {
      const result = await request(withTenant('/owner/communications'), {
        method: 'POST',
        body: JSON.stringify({ subject: subject.trim(), message: draft.trim() }),
      })
      setSubject(''); setDraft(''); setShowNew(false)
      await refresh()
      if (result.message?.conversation_id) await openThread(result.message.conversation_id)
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Message could not be sent.') }
    finally { setLoading(false) }
  }

  const sendReply = async () => {
    if (!tenantId || !selected || !reply.trim()) return
    setLoading(true); setError('')
    try {
      await request(withTenant('/owner/communications/' + encodeURIComponent(selected) + '/messages'), {
        method: 'POST', body: JSON.stringify({ message: reply.trim() }),
      })
      setReply('')
      const result = await request(withTenant('/owner/communications/' + encodeURIComponent(selected)))
      setMessages(result.messages || [])
      await refresh()
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Reply could not be sent.') }
    finally { setLoading(false) }
  }

  if (!accessToken) return <section className="owner-comms"><div className="owner-comms-state"><ShieldAlert size={20}/><b>Sign in to view messages</b><p>Your app must pass the signed-in owner's short-lived access token to this component.</p></div></section>

  return <section className="owner-comms" aria-live="polite">
    <header className="owner-comms-header"><div><span className="owner-comms-kicker">OWNER SUPPORT</span><h2>{title}</h2><p>Contact the platform team, follow requests and receive announcements.</p></div><button type="button" onClick={() => void (tenantId ? refresh() : loadTenants())} disabled={loading} aria-label="Refresh messages"><RefreshCw size={17} className={loading ? 'owner-comms-spin' : ''}/></button></header>
    {tenants.length > 1 && <label className="owner-comms-tenant">Restaurant
      <select value={tenantId} onChange={event => changeTenant(event.target.value)}>
        <option value="">Choose a restaurant</option>
        {tenants.map(tenant => <option key={tenant.tenant_id} value={tenant.tenant_id}>{tenant.tenant_name}</option>)}
      </select>
    </label>}
    {tenants.length > 1 && !tenantId ? <div className="owner-comms-empty"><MessageCircle size={23}/><b>Select a restaurant</b><p>Choose which restaurant you need help with. Messages stay separated by restaurant.</p></div> :
    !tenants.length ? <div className="owner-comms-state"><ShieldAlert size={20}/><b>Restaurant access unavailable</b><p>We could not find an active owner membership for this account.</p></div> :
    selected ? <div className="owner-comms-thread">
      <button type="button" className="owner-comms-back" onClick={() => { setSelected(''); setMessages([]) }}><ArrowLeft size={15}/> All messages</button>
      <div className="owner-comms-thread-title"><b>{conversations.find(item => item.id === selected)?.subject || 'Conversation'}</b><span>{(conversations.find(item => item.id === selected)?.status || 'open').replace('_', ' ')}</span></div>
      <div className="owner-comms-messages">{messages.map(message => <article key={message.id} className={'owner-comms-message ' + message.sender_role}><small>{message.sender_role === 'admin' ? 'Platform team' : 'You'} · {new Date(message.created_at).toLocaleString()}</small><p>{message.body}</p></article>)}</div>
      {conversations.find(item => item.id === selected)?.status !== 'resolved' && <form onSubmit={event => { event.preventDefault(); void sendReply() }} className="owner-comms-compose"><textarea value={reply} onChange={event => setReply(event.target.value)} maxLength={5000} rows={3} placeholder="Write a message…"/><button type="submit" disabled={loading || !reply.trim()}><Send size={15}/> Send</button></form>}
    </div> : showNew ? <form className="owner-comms-new" onSubmit={event => { event.preventDefault(); void startConversation() }}>
      <button type="button" className="owner-comms-back" onClick={() => setShowNew(false)}><ArrowLeft size={15}/> Back to inbox</button>
      <label>Subject<input value={subject} onChange={event => setSubject(event.target.value)} maxLength={180} required placeholder="Bug report, improvement request…"/></label>
      <label>Message<textarea value={draft} onChange={event => setDraft(event.target.value)} maxLength={5000} rows={5} required placeholder="Tell us what happened or what you would like improved…"/></label>
      <button type="submit" disabled={loading || !subject.trim() || !draft.trim()}><Send size={15}/> Send to platform team</button>
    </form> : <>
      <div className="owner-comms-actions"><span>{conversations.length} conversations</span><button type="button" onClick={() => setShowNew(true)}><Plus size={15}/> New message</button></div>
      {conversations.length === 0 ? <div className="owner-comms-empty"><MessageCircle size={23}/><b>No messages yet</b><p>Send a bug report, ask a question or request an improvement.</p><button type="button" onClick={() => setShowNew(true)}>Start a conversation</button></div> : <div className="owner-comms-list">{conversations.map(item => <button type="button" key={item.id} onClick={() => void openThread(item.id)}><span className="owner-comms-item-icon"><MessageCircle size={17}/></span><span className="owner-comms-item-copy"><b>{item.subject}</b><small>{item.kind === 'announcement' ? 'Announcement' : item.kind === 'group' ? 'Group conversation' : item.last_message || 'Support conversation'}</small></span><span className="owner-comms-item-meta">{item.unread_count ? <i>{item.unread_count}</i> : null}<small>{item.status.replace('_', ' ')}</small></span></button>)}</div>}
    </>}
    {error && <p className="owner-comms-error" role="alert">{error}</p>}
  </section>
}
