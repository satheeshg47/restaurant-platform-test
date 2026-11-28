import { apiFetch } from './auth'
import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertCircle, Check, ChefHat, RefreshCw, Utensils, Users, Bell, X } from 'lucide-react'

const API_BASE = (import.meta.env.VITE_API_BASE_URL || '/api').replace(/\/$/, '')
type Tab = 'kitchen' | 'waiter'
type QueueRow = {
  batch_id: string; batch_status: string; item_name_snapshot: string; variant_name_snapshot: string | null
  addons_snapshot: { name: string }[]; total_quantity: number; allocation_id: string; allocation_quantity: number
  allocation_status: string; order_item_id: string; order_id: string; customization: string
  item_status: string; order_number: number; special_instructions: string; order_created_at: string
  table_label: string; batch_created_at: string
}
type TableRow = { id: string; label: string; table_type: string; session_id: string | null; guest_count: number | null; ready_items: number; open_requests: number; total_due_minor: string; paid_minor: string; refunded_minor: string; waived_minor: string }
type ReadyRow = { order_item_id: string; order_id: string; item_name_snapshot: string; variant_name_snapshot: string | null; addons_snapshot: { name: string }[]; customization: string; quantity: number; order_number: number; session_id: string; table_id: string; table_label: string }
type ServiceRequest = { id: string; session_id: string; table_id: string; request_type: string; note: string; created_at: string; table_label: string }
type Board = { tables: TableRow[]; ready_items: ReadyRow[]; service_requests: ServiceRequest[] }

function labelStatus(value: string) { return value.replace(/_/g, ' ') }
function when(value: string) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })
}
function addonLabels(value: unknown): string[] {
  let parsed = value
  if (typeof parsed === 'string') {
    try { parsed = JSON.parse(parsed) } catch { return [] }
  }
  if (!Array.isArray(parsed)) return []
  return parsed.map((entry: any) => {
    const name = entry?.name
    if (typeof name === 'string') return name
    if (name && typeof name === 'object') return String(name.en || Object.values(name)[0] || 'Add-on')
    return 'Add-on'
  })
}

function errorMessage(code: string) {
  const messages: Record<string, string> = {
    unauthorized: 'Please sign in with your restaurant staff account.',
    forbidden: 'Your staff role does not have access to this workspace.',
    identity_auth_not_configured: 'Staff identity sign-in is not configured on this server.',
    orders_not_completed: 'Finish all active orders before closing this table.',
    payment_due: 'Record the outstanding payment before closing this table.',
    table_session_already_open: 'This table already has an open session.',
    item_claimed_by_another_cook: 'Another cook has already claimed this item.',
    invalid_status_transition: 'This item has already moved to another status. Refresh the board.',
  }
  return messages[code] || code.replace(/_/g, ' ')
}

export default function RestaurantOperations({ initialSlug = '', initialTab = 'kitchen', allowedTabs }: { initialSlug?: string; initialTab?: Tab; allowedTabs?: Tab[] } = {}) {
  const [slug, setSlug] = useState(initialSlug)
  const [tab, setTab] = useState<Tab>(initialTab)
  const visibleTabs = allowedTabs || ['kitchen', 'waiter']
  const [queue, setQueue] = useState<QueueRow[]>([])
  const [board, setBoard] = useState<Board>({ tables: [], ready_items: [], service_requests: [] })
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [reasonFor, setReasonFor] = useState<QueueRow | null>(null)
  const [reason, setReason] = useState('')
  const [paymentFor, setPaymentFor] = useState<TableRow | null>(null)
  const [paymentAmount, setPaymentAmount] = useState('')
  const [paymentMethod, setPaymentMethod] = useState<'cash' | 'upi' | 'card' | 'other'>('cash')
  const [paymentReference, setPaymentReference] = useState('')
  const [billFor, setBillFor] = useState<TableRow | null>(null)
  const [bill, setBill] = useState<{session: {table_label:string;restaurant_name?:string;legal_name?:string|null;gstin?:string|null;fssai_license_no?:string|null;address_line1?:string|null;address_line2?:string|null;city?:string|null;state_name?:string|null;postal_code?:string|null;state_code?:string|null;tax_mode?:string|null;gst_rate?:number|string|null;tax_inclusive?:boolean;opened_at:string;closed_at?:string|null;guest_count:number;currency_code?:string};orders: {id:string;order_number:number;subtotal_minor:string;tax_minor:string;total_minor:string;tax_mode_snapshot?:string|null;tax_rate_snapshot?:number|string|null;tax_inclusive_snapshot?:boolean;created_at:string}[];items: {order_id:string;item_name_snapshot:string;variant_name_snapshot:string|null;addons_snapshot:unknown;quantity:number;line_total_minor:string;status:string}[];payments:{amount_minor:string;method:string;reference:string|null;paid_at:string}[];refunds:{amount_minor:string;reason:string;was_paid:boolean;created_at:string}[];invoice?:{invoice_number:string;issued_at:string;seller_snapshot:Record<string,string>;items_snapshot:{item_name:string;variant_name?:string|null;addons?:unknown;hsn_sac_code:string;quantity:number;line_total_minor:string}[];subtotal_minor:string;tax_minor:string;cgst_minor:string;sgst_minor:string;other_tax_minor:string;total_minor:string;tax_rate:number|string;tax_inclusive:boolean}|null}|null>(null)
  const [billLoading, setBillLoading] = useState(false)
  const [notice, setNotice] = useState('')
  const [printTicket, setPrintTicket] = useState<QueueRow[] | null>(null)
  const [printWidth, setPrintWidth] = useState<'58' | '80'>('80')
  const [soundEnabled, setSoundEnabled] = useState(false)
  const [isOnline, setIsOnline] = useState(typeof navigator === 'undefined' ? true : navigator.onLine)
  const audioContext = useRef<AudioContext | null>(null)
  const seenAlerts = useRef<Set<string> | null>(null)
  const groupedQueue = Object.values(queue.reduce<Record<string, QueueRow[]>>((groups, row) => {
    ;(groups[row.batch_id] ||= []).push(row)
    return groups
  }, {}))

  const request = useCallback(async (path: string, init?: RequestInit) => {
    const response = await apiFetch(`${API_BASE}/restaurant/${encodeURIComponent(slug.trim().toLowerCase())}${path}`, {
      ...init, credentials: 'same-origin', cache: 'no-store',
      headers: { Accept: 'application/json', ...(init?.body ? { 'Content-Type': 'application/json' } : {}), ...init?.headers },
    })
    const body = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(body.error || 'request_failed')
    return body
  }, [slug])

  const playChime = useCallback(() => {
    const context = audioContext.current
    if (!soundEnabled || !context) return
    void context.resume()
    const oscillator = context.createOscillator()
    const gain = context.createGain()
    oscillator.type = 'sine'
    oscillator.frequency.setValueAtTime(880, context.currentTime)
    gain.gain.setValueAtTime(0.16, context.currentTime)
    gain.gain.exponentialRampToValueAtTime(0.001, context.currentTime + 0.28)
    oscillator.connect(gain); gain.connect(context.destination)
    oscillator.start(); oscillator.stop(context.currentTime + 0.28)
  }, [soundEnabled])

  function enableSound() {
    if (!audioContext.current) audioContext.current = new AudioContext()
    void audioContext.current.resume()
    setSoundEnabled(true)
    const context = audioContext.current
    const oscillator = context.createOscillator()
    const gain = context.createGain()
    oscillator.frequency.value = 660; gain.gain.value = 0.12
    oscillator.connect(gain); gain.connect(context.destination)
    oscillator.start(); oscillator.stop(context.currentTime + 0.18)
  }

  const refresh = useCallback(async () => {
    if (!slug.trim()) { setError('Enter the restaurant slug to load the staff workspace.'); return }
    setLoading(true); setError('')
    try {
      if (tab === 'kitchen') {
        const result = await request('/kitchen/queue')
        const nextQueue = result.queue || []
        const alertIds = nextQueue.filter((item: QueueRow) => item.item_status === 'new').map((item: QueueRow) => 'order:' + item.order_item_id)
        const seen = seenAlerts.current || new Set<string>()
        const hasNew = alertIds.some((alertId: string) => !seen.has(alertId))
        alertIds.forEach((alertId: string) => seen.add(alertId)); seenAlerts.current = seen
        if (hasNew) playChime()
        setQueue(nextQueue)
        setIsOnline(true)
      } else {
        const result = await request('/waiter/board')
        const requests = result.service_requests || []
        const alertIds = requests.map((item: ServiceRequest) => 'request:' + item.id)
        const seen = seenAlerts.current || new Set<string>()
        const hasNew = alertIds.some((alertId: string) => !seen.has(alertId))
        alertIds.forEach((alertId: string) => seen.add(alertId)); seenAlerts.current = seen
        if (hasNew) playChime()
        setBoard({ tables: result.tables || [], ready_items: result.ready_items || [], service_requests: requests })
        setIsOnline(true)
      }
    } catch (e) { setIsOnline(typeof navigator === 'undefined' ? false : navigator.onLine); setError(errorMessage(e instanceof Error ? e.message : 'request_failed')) }
    finally { setLoading(false) }
  }, [playChime, request, slug, tab])

  useEffect(() => { if (slug.trim()) void refresh() }, [tab])
  useEffect(() => { const clearTicket = () => setPrintTicket(null); window.addEventListener('afterprint', clearTicket); return () => window.removeEventListener('afterprint', clearTicket) }, [])
  useEffect(() => {
    if (!slug.trim()) return
    const onOnline = () => { setIsOnline(true); void refresh() }
    const onOffline = () => setIsOnline(false)
    window.addEventListener('online', onOnline); window.addEventListener('offline', onOffline)
    const timer = window.setInterval(() => { if (navigator.onLine) void refresh(); else setIsOnline(false) }, 12000)
    return () => { window.clearInterval(timer); window.removeEventListener('online', onOnline); window.removeEventListener('offline', onOffline) }
  }, [refresh, slug])

  async function updateKitchen(row: QueueRow, status: string, unavailableReason = '') {
    setBusy(row.order_item_id); setError('')
    try {
      await request(`/kitchen/items/${row.order_item_id}/status`, { method: 'PATCH', body: JSON.stringify({ status, ...(status === 'unavailable' ? { reason: unavailableReason } : {}) }) })
      setReasonFor(null); setReason(''); await refresh()
    } catch (e) { setError(errorMessage(e instanceof Error ? e.message : 'request_failed')) }
    finally { setBusy('') }
  }

  async function serve(item: ReadyRow) {
    setBusy(item.order_item_id); setError('')
    try { await request(`/waiter/items/${item.order_item_id}/serve`, { method: 'POST', body: '{}' }); await refresh() }
    catch (e) { setError(errorMessage(e instanceof Error ? e.message : 'request_failed')) }
    finally { setBusy('') }
  }

  async function updateRequest(item: ServiceRequest, status: 'handled' | 'dismissed') {
    setBusy(item.id); setError('')
    try { await request(`/waiter/requests/${item.id}`, { method: 'PATCH', body: JSON.stringify({ status }) }); await refresh() }
    catch (e) { setError(errorMessage(e instanceof Error ? e.message : 'request_failed')) }
    finally { setBusy('') }
  }

  async function openSession(table: TableRow) {
    setBusy(table.id); setError('')
    try {
      const result = await request(`/tables/${table.id}/sessions`, { method: 'POST', body: JSON.stringify({ guest_count: 1 }) })
      setNotice(`Table PIN for ${table.label}: ${result.session.guest_pin} (valid for 2 hours). Share it with guests at the table only.`)
      await refresh()
    } catch (e) { setError(errorMessage(e instanceof Error ? e.message : 'request_failed')) }
    finally { setBusy('') }
  }

  async function rotateGuestPin(table: TableRow) {
    if (!table.session_id) return
    setBusy(table.id); setError('')
    try {
      const result = await request(`/tables/${table.id}/sessions/${table.session_id}/pin`, { method: 'POST', body: '{}' })
      setNotice(`New table PIN for ${table.label}: ${result.session.guest_pin} (valid for 2 hours). The previous PIN is now invalid.`)
    } catch (e) { setError(errorMessage(e instanceof Error ? e.message : 'request_failed')) }
    finally { setBusy('') }
  }


  async function openBill(table: TableRow) {
    if (!table.session_id) return
    setBillFor(table); setBill(null); setBillLoading(true); setError('')
    try {
      const result = await request(`/waiter/sessions/${table.session_id}/bill`)
      setBill(result)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load bill')
      setBillFor(null)
    } finally { setBillLoading(false) }
  }

  async function issueInvoice() {
    if (!billFor?.session_id || !bill) return
    setBusy(billFor.id); setError(''); setNotice('')
    try {
      const result = await request(`/waiter/sessions/${billFor.session_id}/invoice`, { method: 'POST', body: '{}' })
      setBill(current => current ? { ...current, invoice: result.invoice, session: { ...current.session, closed_at: new Date().toISOString() } } : current)
      setNotice(`GST invoice ${result.invoice.invoice_number} issued. This table session is now closed.`)
      await refresh()
    } catch (e) { setError(errorMessage(e instanceof Error ? e.message : 'invoice_failed')) }
    finally { setBusy('') }
  }

  async function recordPayment() {
    if (!paymentFor?.session_id) return
    const match = /^(0|[1-9]\d*)(?:\.(\d{1,2}))?$/.exec(paymentAmount.trim())
    if (!match || (BigInt(match[1]) * 100n + BigInt((match[2] || '').padEnd(2, '0'))) <= 0n) {
      setError('Enter a valid payment amount in rupees, e.g. 250 or 250.50.')
      return
    }
    const amountMinor = (BigInt(match[1]) * 100n + BigInt((match[2] || '').padEnd(2, '0'))).toString()
    setBusy(paymentFor.id); setError(''); setNotice('')
    try {
      const result = await request(`/sessions/${paymentFor.session_id}/payments`, {
        method: 'POST', body: JSON.stringify({ amount_minor: amountMinor, method: paymentMethod, reference: paymentReference.trim() || undefined }),
      })
      setNotice(`Payment recorded. Remaining balance: ₹${(Number(result.balance_minor || 0) / 100).toFixed(2)}`)
      setPaymentFor(null); setPaymentAmount(''); setPaymentReference('')
      await refresh()
    } catch (e) { setError(errorMessage(e instanceof Error ? e.message : 'request_failed')) }
    finally { setBusy('') }
  }

  async function closeSession(table: TableRow) {
    if (!table.session_id) return
    setBusy(table.id); setError('')
    try { await request(`/tables/${table.id}/sessions/${table.session_id}/close`, { method: 'POST', body: '{}' }); await refresh() }
    catch (e) { setError(errorMessage(e instanceof Error ? e.message : 'request_failed')) }
    finally { setBusy('') }
  }

  return <section className="restaurant-ops">
    <div className="restaurant-ops-toolbar">
      <div><span className="eyebrow">RESTAURANT SUITE</span><h2>Kitchen & service</h2><p>Live staff workspaces. Updates refresh automatically every 12 seconds.</p></div>
      <span className={`restaurant-connection-state ${isOnline ? 'online' : 'offline'}`}>{isOnline ? 'Online · auto-refresh 12s' : 'Offline · reconnecting'}</span><label className="restaurant-thermal-width">Print <select aria-label="Thermal printer width" value={printWidth} onChange={event=>setPrintWidth(event.target.value as '58'|'80')}><option value="58">58mm</option><option value="80">80mm</option></select></label><button className="button secondary small" onClick={enableSound} disabled={soundEnabled}>{soundEnabled ? 'Sound enabled' : 'Enable chime'}</button><button className="button secondary small" onClick={() => void refresh()} disabled={loading}><RefreshCw size={14}/>{loading ? 'Refreshing' : 'Refresh'}</button>
    </div>
    {!initialSlug && <div className="restaurant-ops-config"><label htmlFor="ops-slug">Restaurant slug</label><input id="ops-slug" value={slug} onChange={event => setSlug(event.target.value)} placeholder="e.g. my-restaurant"/><button className="button primary small" onClick={() => void refresh()} disabled={loading || !slug.trim()}>Load workspace</button></div>}
    <div className="restaurant-ops-tabs">{visibleTabs.includes('kitchen') && <button className={tab === 'kitchen' ? 'active' : ''} onClick={() => setTab('kitchen')}><ChefHat size={15}/> Kitchen queue</button>}{visibleTabs.includes('waiter') && <button className={tab === 'waiter' ? 'active' : ''} onClick={() => setTab('waiter')}><Utensils size={15}/> Waiter board</button>}</div>
    {error && <div className="restaurant-ops-error"><AlertCircle size={15}/>{error}<button onClick={() => setError('')}><X size={14}/></button></div>}
    {notice && <div className="restaurant-table-message" role="status">{notice}<button onClick={() => setNotice('')}>Dismiss</button></div>}
    {!slug.trim() ? <div className="restaurant-ops-empty">Enter a restaurant slug to connect to its staff workspace.</div> : tab === 'kitchen' ? <>
      <div className="restaurant-ops-summary"><b>{groupedQueue.length}</b><span>grouped kitchen batches · {queue.length} table allocations</span></div>
      <div className="restaurant-kitchen-list">{groupedQueue.map(rows => {
        const row = rows[0]
        return <article className="restaurant-kitchen-card restaurant-kitchen-batch-card" key={row.batch_id}>
          <div className="restaurant-kitchen-card-top"><span>{rows.length} table orders · {Array.from(new Set(rows.map(item => item.table_label))).join(' · ')}</span><span>{when(row.batch_created_at)}</span><button className="secondary small" onClick={() => { setPrintTicket(rows); window.requestAnimationFrame(() => window.requestAnimationFrame(() => window.print())) }}>Print KOT</button></div>
          <div className="restaurant-kitchen-main"><div><h3>{row.item_name_snapshot}{row.variant_name_snapshot ? ` · ${row.variant_name_snapshot}` : ''}</h3><p>Combined quantity <b>{row.total_quantity}</b>{row.addons_snapshot?.length ? ' · ' + row.addons_snapshot.map(a => a.name).join(', ') : ''}</p></div><span className={`restaurant-ops-status ${row.batch_status}`}>{labelStatus(row.batch_status)}</span></div>
          <div className="restaurant-kitchen-breakdown">
            {rows.map(allocation => <div className="restaurant-kitchen-allocation" key={allocation.order_item_id}>
              <div className="restaurant-kitchen-allocation-info"><b>{allocation.table_label}</b><small>Order #{allocation.order_number} · Qty {allocation.allocation_quantity} · {when(allocation.order_created_at)}</small>{allocation.customization && <small>Note: {allocation.customization}</small>}{allocation.special_instructions && <small>Order note: {allocation.special_instructions}</small>}</div>
              <span className={`restaurant-ops-status ${allocation.item_status}`}>{labelStatus(allocation.item_status)}</span>
              <div className="restaurant-kitchen-actions">
                {allocation.item_status === 'new' && <button onClick={() => void updateKitchen(allocation, 'accepted')} disabled={busy === allocation.order_item_id}>Accept</button>}
                {allocation.item_status === 'accepted' && <button onClick={() => void updateKitchen(allocation, 'preparing')} disabled={busy === allocation.order_item_id}>Start preparing</button>}
                {allocation.item_status === 'preparing' && <button onClick={() => void updateKitchen(allocation, 'ready')} disabled={busy === allocation.order_item_id}>Mark ready</button>}
                {['new', 'accepted', 'preparing'].includes(allocation.item_status) && <button className="danger" onClick={() => { setReasonFor(allocation); setReason('') }} disabled={busy === allocation.order_item_id}>Unavailable</button>}
              </div>
            </div>)}
          </div>
        </article>
      })}</div>
      {!queue.length && <div className="restaurant-ops-empty">No active kitchen orders. New QR orders will appear here.</div>}
    </> : <>
      <div className="restaurant-ops-stats"><div><b>{board.tables.filter(t => t.session_id).length}</b><span>Open tables</span></div><div><b>{board.ready_items.length}</b><span>Ready to serve</span></div><div><b>{board.service_requests.length}</b><span>Guest requests</span></div></div>
      <div className="restaurant-ops-section"><h3><Users size={16}/> Tables & sessions</h3><div className="restaurant-table-grid">{board.tables.map(table => <article className="restaurant-table-card" key={table.id}><div><b>{table.label}</b><span>{table.table_type === 'takeaway' ? 'Takeaway' : 'Dine-in'}</span></div><span className={`restaurant-ops-status ${table.session_id ? 'open' : 'closed'}`}>{table.session_id ? 'Session open' : 'No session'}</span><small>{table.ready_items || 0} ready · {table.open_requests || 0} requests</small>{table.session_id ? <><div className="restaurant-payment-balance"><span>Due ₹{(Number(table.total_due_minor || 0) / 100).toFixed(2)}</span><span>Paid ₹{(Number(table.paid_minor || 0) / 100).toFixed(2)}</span><b>Balance ₹{((Number(table.total_due_minor || 0) - Number(table.paid_minor || 0) + Number(table.refunded_minor || 0) - Number(table.waived_minor || 0)) / 100).toFixed(2)}</b></div><button className="secondary" onClick={() => void rotateGuestPin(table)} disabled={busy === table.id}>Regenerate guest PIN</button><button className="secondary" onClick={() => void openBill(table)}>View / print bill</button><button onClick={() => { setPaymentFor(table); setPaymentAmount(''); setPaymentReference('') }}>Record payment</button><button className="secondary" disabled={busy === table.id} onClick={() => void closeSession(table)}>Close session</button></> : <button disabled={busy === table.id} onClick={() => void openSession(table)}>Open session</button>}</article>)}</div></div>
      <div className="restaurant-ops-section"><h3><Check size={16}/> Ready to serve</h3>{board.ready_items.map(item => <article className="restaurant-waiter-row" key={item.order_item_id}><div><b>#{item.order_number} · {item.table_label}</b><strong>{item.item_name_snapshot} × {item.quantity}</strong><small>{item.variant_name_snapshot || ''}{item.addons_snapshot?.length ? ' · ' + item.addons_snapshot.map(a => a.name).join(', ') : ''}</small></div><button disabled={busy === item.order_item_id} onClick={() => void serve(item)}>Mark served</button></article>)}{!board.ready_items.length && <div className="restaurant-ops-empty compact">No items are waiting to be served.</div>}</div>
      <div className="restaurant-ops-section"><h3><Bell size={16}/> Guest requests</h3>{board.service_requests.map(item => <article className="restaurant-waiter-row" key={item.id}><div><b>{item.table_label} · {labelStatus(item.request_type)}</b><small>{item.note || 'Guest requested assistance'} · {when(item.created_at)}</small></div><div className="restaurant-waiter-actions"><button disabled={busy === item.id} onClick={() => void updateRequest(item, 'handled')}>Handled</button><button className="secondary" disabled={busy === item.id} onClick={() => void updateRequest(item, 'dismissed')}>Dismiss</button></div></article>)}{!board.service_requests.length && <div className="restaurant-ops-empty compact">No open guest requests.</div>}</div>
    </>}

    {billFor && <div className="restaurant-ops-modal-backdrop"><div className={`restaurant-ops-modal restaurant-bill-modal print-width-${printWidth}`}>
      <div className="restaurant-bill-heading"><div><h3>{bill?.session.restaurant_name || 'Restaurant'} · Bill</h3><p>{bill?.session.table_label || billFor.label} · {bill?.session.guest_count || billFor.guest_count || 1} guests</p></div><button className="secondary" onClick={() => {setBillFor(null);setBill(null)}} aria-label="Close bill"><X size={16}/></button></div>
      {billLoading && <p>Loading bill…</p>}
      {bill && <>
        <div className="restaurant-bill-meta">Opened {new Date(bill.session.opened_at).toLocaleString('en-IN')}</div>
        {!bill.invoice && <div className="restaurant-bill-invoice restaurant-bill-seller">
          <h4>RESTAURANT BILL · NOT A GST TAX INVOICE</h4>
          <b>{bill.session.legal_name || bill.session.restaurant_name || 'Restaurant'}</b>
          <div>{[bill.session.address_line1,bill.session.address_line2,bill.session.city,bill.session.state_name,bill.session.postal_code].filter(Boolean).join(', ')}</div>
          {bill.session.gstin && <div>GSTIN: {bill.session.gstin}</div>}
          {bill.session.fssai_license_no && <div>FSSAI License No: {bill.session.fssai_license_no}</div>}
          <div>Table: {bill.session.table_label} · Guests: {bill.session.guest_count}</div>
          <div>Bill time: {new Date().toLocaleString('en-IN')}</div>
        </div>}
        {bill.invoice && <div className="restaurant-bill-invoice">
          <h4>GST TAX INVOICE · {bill.invoice.invoice_number}</h4>
          <b>{bill.invoice.seller_snapshot.legal_name}</b>
          <div>{bill.invoice.seller_snapshot.address_line1} {bill.invoice.seller_snapshot.address_line2 || ''}, {bill.invoice.seller_snapshot.city}, {bill.invoice.seller_snapshot.state_name} – {bill.invoice.seller_snapshot.postal_code}</div>
          <div>GSTIN: {bill.invoice.seller_snapshot.gstin}</div>{bill.invoice.seller_snapshot.fssai_license_no && <div>FSSAI License No: {bill.invoice.seller_snapshot.fssai_license_no}</div>}
          <div>Place of supply: {bill.invoice.seller_snapshot.place_of_supply}</div>
          <div>Issued: {new Date(bill.invoice.issued_at).toLocaleString('en-IN')}</div>
          <hr/>
          {bill.invoice.items_snapshot.map((item,index)=><div className="restaurant-bill-line" key={index}><span>{item.item_name}{item.variant_name ? ' · ' + item.variant_name : ''} × {item.quantity}{addonLabels(item.addons).length ? ' · ' + addonLabels(item.addons).join(', ') : ''} · HSN/SAC {item.hsn_sac_code}</span><b>₹{(Number(item.line_total_minor)/100).toFixed(2)}</b></div>)}
          <div className="restaurant-bill-line"><span>Taxable value</span><b>₹{(Number(bill.invoice.subtotal_minor)/100).toFixed(2)}</b></div>
          {Number(bill.invoice.cgst_minor)>0 && <div className="restaurant-bill-line"><span>CGST ({Number(bill.invoice.tax_rate)/2}%)</span><span>₹{(Number(bill.invoice.cgst_minor)/100).toFixed(2)}</span></div>}
          {Number(bill.invoice.sgst_minor)>0 && <div className="restaurant-bill-line"><span>SGST ({Number(bill.invoice.tax_rate)/2}%)</span><span>₹{(Number(bill.invoice.sgst_minor)/100).toFixed(2)}</span></div>}
          {Number(bill.invoice.other_tax_minor)>0 && <div className="restaurant-bill-line"><span>Other tax</span><span>₹{(Number(bill.invoice.other_tax_minor)/100).toFixed(2)}</span></div>}
          <div className="restaurant-bill-line total"><span>Invoice total</span><b>₹{(Number(bill.invoice.total_minor)/100).toFixed(2)}</b></div>
        </div>}
        {!bill.invoice && bill.orders.map(order=><div className="restaurant-bill-order" key={order.id}><b>Order #{order.order_number}</b><small>{new Date(order.created_at).toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit'})}</small><div>{bill.items.filter(item=>item.order_id===order.id).map((item,index)=><div className="restaurant-bill-line" key={order.id+'-'+index}><span>{item.item_name_snapshot}{item.variant_name_snapshot ? ' · '+item.variant_name_snapshot : ''} × {item.quantity}{addonLabels(item.addons_snapshot).length ? ' · '+addonLabels(item.addons_snapshot).join(', ') : ''}</span><b>₹{(Number(item.line_total_minor)/100).toFixed(2)}</b></div>)}</div><div className="restaurant-bill-line"><span>{order.tax_inclusive_snapshot ? 'Taxable value' : 'Subtotal'}</span><span>₹{((Number(order.subtotal_minor)-(order.tax_inclusive_snapshot?Number(order.tax_minor):0))/100).toFixed(2)}</span></div>{order.tax_mode_snapshot === 'gst' ? <><div className="restaurant-bill-line"><span>CGST ({Number(order.tax_rate_snapshot || 0)/2}%)</span><span>₹{(Math.floor(Number(order.tax_minor)/2)/100).toFixed(2)}</span></div><div className="restaurant-bill-line"><span>SGST ({Number(order.tax_rate_snapshot || 0)/2}%)</span><span>₹{((Number(order.tax_minor)-Math.floor(Number(order.tax_minor)/2))/100).toFixed(2)}</span></div></> : <div className="restaurant-bill-line"><span>Tax</span><span>₹{(Number(order.tax_minor)/100).toFixed(2)}</span></div>}<div className="restaurant-bill-line total"><span>Order total</span><b>₹{(Number(order.total_minor)/100).toFixed(2)}</b></div></div>)}
        <div className="restaurant-bill-summary"><div className="restaurant-bill-line"><span>Total due</span><b>₹{(bill.orders.reduce((sum,o)=>sum+Number(o.total_minor),0)/100).toFixed(2)}</b></div><div className="restaurant-bill-line"><span>Payments</span><span>₹{(bill.payments.reduce((sum,p)=>sum+Number(p.amount_minor),0)/100).toFixed(2)}</span></div><div className="restaurant-bill-line"><span>Refunds</span><span>₹{(bill.refunds.filter(r=>r.was_paid).reduce((sum,r)=>sum+Number(r.amount_minor),0)/100).toFixed(2)}</span></div><div className="restaurant-bill-line total"><span>Balance</span><b>₹{((bill.orders.reduce((sum,o)=>sum+Number(o.total_minor),0)-bill.payments.reduce((sum,p)=>sum+Number(p.amount_minor),0)+bill.refunds.filter(r=>r.was_paid).reduce((sum,r)=>sum+Number(r.amount_minor),0))/100).toFixed(2)}</b></div></div>
        <div className="restaurant-bill-actions"><label>Printer width <select aria-label="Thermal printer width" value={printWidth} onChange={event=>setPrintWidth(event.target.value as '58'|'80')}><option value="58">58mm</option><option value="80">80mm</option></select></label><button className="secondary" onClick={()=>window.print()}>{bill.invoice ? 'Print GST tax invoice' : 'Print bill'}</button>{!bill.invoice && <button className="secondary" disabled={!!busy} onClick={()=>void issueInvoice()}>Issue GST invoice & close session</button>}<button onClick={()=>{setBillFor(null);setBill(null)}}>Done</button></div>
      </>}
    </div></div>}
    {printTicket && <div className={`restaurant-print-sheet restaurant-kot-print print-width-${printWidth}`}>
      <h2>KITCHEN ORDER TICKET</h2><b>{printTicket[0]?.item_name_snapshot}{printTicket[0]?.variant_name_snapshot ? ' · ' + printTicket[0].variant_name_snapshot : ''}</b>
      <h1>QTY {printTicket.reduce((sum,row)=>sum+Number(row.allocation_quantity),0)}</h1>
      <hr/>
      {printTicket.map(row=><div className="restaurant-kot-allocation" key={row.order_item_id}>
        <b>{row.table_label} · Order #{row.order_number}</b><strong>× {row.allocation_quantity}</strong>
        {row.addons_snapshot?.length > 0 && <p>Add-ons: {row.addons_snapshot.map(addon=>addon.name).join(', ')}</p>}
        {row.customization && <p>Note: {row.customization}</p>}{row.special_instructions && <p>Order: {row.special_instructions}</p>}
        <small>{when(row.order_created_at)}</small>
      </div>)}
      <footer>Printed {new Date().toLocaleString('en-IN')}</footer>
    </div>}
    {paymentFor && <div className="restaurant-ops-modal-backdrop"><div className="restaurant-ops-modal"><h3>Record payment · {paymentFor.label}</h3><p>Outstanding balance ₹{((Number(paymentFor.total_due_minor || 0) - Number(paymentFor.paid_minor || 0) + Number(paymentFor.refunded_minor || 0) - Number(paymentFor.waived_minor || 0)) / 100).toFixed(2)}</p><label>Amount (₹)<input inputMode="decimal" value={paymentAmount} onChange={event => setPaymentAmount(event.target.value)} placeholder="e.g. 250.00"/></label><label>Payment method<select value={paymentMethod} onChange={event => setPaymentMethod(event.target.value as 'cash' | 'upi' | 'card' | 'other')}><option value="cash">Cash</option><option value="upi">UPI</option><option value="card">Card</option><option value="other">Other</option></select></label><label>Reference (optional)<input value={paymentReference} onChange={event => setPaymentReference(event.target.value)} maxLength={120} placeholder="UPI transaction ID / note"/></label><div><button className="secondary" onClick={() => setPaymentFor(null)}>Cancel</button><button disabled={!paymentAmount.trim() || !!busy} onClick={() => void recordPayment()}>Confirm payment</button></div></div></div>}
    {reasonFor && <div className="restaurant-ops-modal-backdrop"><div className="restaurant-ops-modal"><h3>Mark item unavailable</h3><p>{reasonFor.item_name_snapshot}</p><textarea value={reason} onChange={event => setReason(event.target.value)} placeholder="Enter a reason for the waiter and guest" maxLength={250}/><div><button className="secondary" onClick={() => setReasonFor(null)}>Cancel</button><button className="danger" disabled={!reason.trim() || busy === reasonFor.order_item_id} onClick={() => void updateKitchen(reasonFor, 'unavailable', reason)}>Confirm unavailable</button></div></div></div>}
  </section>
}
