import { useCallback, useEffect, useState } from 'react'
import { BellRing, MessageCircle, RefreshCw, Send, ShieldAlert, Users } from 'lucide-react'

const API_BASE = (import.meta.env.VITE_API_BASE_URL || '/api').replace(/\/$/, '')
type Conversation = { id: string; kind: 'support' | 'group' | 'announcement'; subject: string; status: string; last_message?: string; participant_count?: number; unread_count?: number }
type Owner = { user_id: string; email: string | null; tenant_names: string[] }
type Message = { id: string; sender_role: string; sender_subject: string; body: string; created_at: string }

export default function Communications() {
  const [state, setState] = useState<'loading' | 'ready' | 'blocked' | 'unavailable'>('loading')
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [owners, setOwners] = useState<Owner[]>([])
  const [selected, setSelected] = useState('')
  const [messages, setMessages] = useState<Message[]>([])
  const [reply, setReply] = useState('')
  const [subject, setSubject] = useState('')
  const [announcement, setAnnouncement] = useState('')
  const [kind, setKind] = useState<'group' | 'announcement'>('announcement')
  const [selectedOwners, setSelectedOwners] = useState<string[]>([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const request = async (path: string, init: RequestInit = {}) => {
    const response = await fetch(API_BASE + path, {
      ...init,
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...init.headers },
      cache: 'no-store',
    })
    if (response.status === 401 || response.status === 403 || response.status === 503) {
      const payload = await response.json().catch(() => ({}))
      throw new Error(payload.error || (response.status === 401 ? 'Sign-in required' : 'Access or service unavailable'))
    }
    const payload = await response.json()
    if (!response.ok) throw new Error(payload.error || 'Request failed')
    return payload
  }

  const refresh = useCallback(async () => {
    setBusy(true); setError('')
    try {
      const session = await fetch(API_BASE + '/admin/session', { cache: 'no-store' })
      if (!session.ok) {
        const payload = await session.json().catch(() => ({}))
        throw new Error(payload.error || (session.status === 401 ? 'Sign-in required' : 'Administrator access is unavailable'))
      }
      const [inbox, directory] = await Promise.all([
        request('/admin/communications'),
        request('/admin/communications/owners'),
      ])
      setConversations(inbox.conversations || [])
      setOwners(directory.owners || [])
      setState('ready')
    } catch (cause) {
      setState('blocked')
      setConversations([]); setOwners([])
      setError(cause instanceof Error ? cause.message : 'Communication centre unavailable')
    } finally { setBusy(false) }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  const openConversation = async (id: string) => {
    setSelected(id); setMessages([])
    try { const result = await request('/admin/communications/' + id); setMessages(result.messages || []) }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not load messages') }
  }

  const sendReply = async () => {
    if (!selected || !reply.trim()) return
    setBusy(true)
    try {
      await request('/admin/communications/' + selected + '/messages', { method: 'POST', body: JSON.stringify({ message: reply.trim() }) })
      setReply('')
      await openConversation(selected)
      await refresh()
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Reply failed') }
    finally { setBusy(false) }
  }

  const createBroadcast = async () => {
    if (!subject.trim() || !announcement.trim() || selectedOwners.length === 0) return
    setBusy(true)
    try {
      await request('/admin/communications', { method: 'POST', body: JSON.stringify({ kind, subject: subject.trim(), message: announcement.trim(), user_ids: selectedOwners }) })
      setSubject(''); setAnnouncement(''); setSelectedOwners([])
      await refresh()
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not create message') }
    finally { setBusy(false) }
  }

  const changeStatus = async (status: string) => {
    if (!selected) return
    try {
      await request('/admin/communications/' + selected, { method: 'PATCH', body: JSON.stringify({ status }) })
      await refresh()
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Status update failed') }
  }

  if (state === 'loading') return <section className="panel registry-state"><RefreshCw size={18} className="spin"/> Checking administrator access…</section>
  if (state === 'blocked') return <section className="panel registry-state registry-blocked"><div className="registry-state-icon"><ShieldAlert size={20}/></div><div><b>Communication Centre is not connected yet</b><p>{error}. The API requires the configured owner-only sign-in and a live PostgreSQL database. No sample conversations are displayed.</p><button className="button secondary small" onClick={() => void refresh()}><RefreshCw size={14}/> Retry</button></div></section>
  return <div className="communication-layout">
    <section className="panel communication-inbox">
      <div className="panel-heading"><div><h2>Inbox</h2><p>Owner requests, bug reports and group threads.</p></div><button className="button secondary small" onClick={() => void refresh()} disabled={busy}><RefreshCw size={14} className={busy ? 'spin' : ''}/>Refresh</button></div>
      {conversations.length === 0 ? <div className="registry-empty"><MessageCircle size={22}/><b>No conversations yet</b><p>Owner messages will appear here when the owner app is connected.</p></div> : conversations.map(item => <button className={'communication-thread ' + (selected === item.id ? 'selected' : '')} key={item.id} onClick={() => void openConversation(item.id)}><span className="communication-thread-icon">{item.kind === 'announcement' ? <BellRing size={16}/> : item.kind === 'group' ? <Users size={16}/> : <MessageCircle size={16}/>}</span><span className="communication-thread-copy"><b>{item.subject}</b><small>{item.last_message || item.kind} · {item.status.replace('_', ' ')}</small></span><span className="communication-thread-count">{item.unread_count ? <i>{item.unread_count}</i> : item.participant_count ?? ''}</span></button>)}
    </section>
    <section className="panel communication-detail">
      <div className="panel-heading"><div><h2>{selected ? 'Conversation' : 'Create a group or announcement'}</h2><p>{selected ? 'Reply and manage the conversation status.' : 'Select owners who should receive the message.'}</p></div></div>
      {selected ? <>
        <div className="communication-status"><label htmlFor="conversation-status">Status</label><select id="conversation-status" value={conversations.find(item => item.id === selected)?.status || 'open'} onChange={event => void changeStatus(event.target.value)}><option value="open">Open</option><option value="in_progress">In progress</option><option value="resolved">Resolved</option></select></div>
        <div className="communication-messages">{messages.map(item => <div className={'communication-message ' + item.sender_role} key={item.id}><small>{item.sender_role === 'admin' ? 'You' : 'App owner'} · {new Date(item.created_at).toLocaleString()}</small><p>{item.body}</p></div>)}</div>
        <div className="communication-compose"><textarea value={reply} onChange={event => setReply(event.target.value)} maxLength={5000} placeholder="Write your reply…" rows={3}/><button className="button primary" onClick={() => void sendReply()} disabled={busy || !reply.trim()}><Send size={15}/> Reply</button></div>
      </> : <>
        <div className="communication-create">
          <div className="communication-kind"><button className={kind === 'announcement' ? 'active' : ''} onClick={() => setKind('announcement')}><BellRing size={15}/> Announcement</button><button className={kind === 'group' ? 'active' : ''} onClick={() => setKind('group')}><Users size={15}/> Group chat</button></div>
          <label>Subject<input value={subject} onChange={event => setSubject(event.target.value)} maxLength={180} placeholder="e.g. New offer for restaurant owners"/></label>
          <label>Message<textarea value={announcement} onChange={event => setAnnouncement(event.target.value)} maxLength={5000} rows={4} placeholder="Write your message…"/></label>
          <div className="communication-owner-list"><b>Recipients ({selectedOwners.length})</b>{owners.map(owner => <label key={owner.user_id}><input type="checkbox" checked={selectedOwners.includes(owner.user_id)} onChange={event => setSelectedOwners(current => event.target.checked ? [...current, owner.user_id] : current.filter(id => id !== owner.user_id))}/><span>{owner.tenant_names.join(', ') || 'Active restaurant owner'}</span><small>{owner.email || 'Owner account'}</small></label>)}</div>
          <button className="button primary" disabled={busy || !subject.trim() || !announcement.trim() || !selectedOwners.length} onClick={() => void createBroadcast()}><Send size={15}/> {kind === 'announcement' ? 'Send announcement' : 'Create group'}</button>
        </div>
      </>}
      {error && <p className="communication-error" role="alert">{error}</p>}
    </section>
  </div>
}
