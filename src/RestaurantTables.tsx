import { apiFetch } from './auth'
import { useCallback, useEffect, useState } from 'react'
import QRCode from 'qrcode'
import { Copy, ExternalLink, Plus, RefreshCw, Table2, QrCode, AlertCircle, Check, Pencil, Trash2, Save, X } from 'lucide-react'

const API_BASE = (import.meta.env.VITE_API_BASE_URL || '/api').replace(/\/$/, '')
type TableRecord = { id:string; table_number:number|null; label:string; table_type:'dine_in'|'takeaway'; active:boolean; session_id:string|null; opened_at:string|null; guest_count:number|null; open_requests:number; qr_url?:string|null }
type CreatedQr = { label:string; url:string; persistent?:boolean }

export default function RestaurantTables({ initialSlug = '' }: { initialSlug?: string } = {}) {
  const [slug,setSlug] = useState(initialSlug)
  const [tables,setTables] = useState<TableRecord[]>([])
  const [state,setState] = useState<'idle'|'loading'|'ready'|'auth'|'forbidden'|'error'>('idle')
  const [error,setError] = useState('')
  const [busy,setBusy] = useState(false)
  const [label,setLabel] = useState('')
  const [number,setNumber] = useState('')
  const [kind,setKind] = useState<'dine_in'|'takeaway'>('dine_in')
  const [created,setCreated] = useState<CreatedQr|null>(null)
  const [qrImage,setQrImage] = useState('')
  const [qrError,setQrError] = useState('')
  const [editingId,setEditingId] = useState('')
  const [editLabel,setEditLabel] = useState('')
  const endpoint = slug.trim().toLowerCase()

  const request = useCallback(async (path:string, init?:RequestInit) => {
    const response = await apiFetch(`${API_BASE}/restaurant/${encodeURIComponent(endpoint)}${path}`, {
      ...init, credentials:'same-origin', cache:'no-store',
      headers:{ Accept:'application/json', ...(init?.body ? {'Content-Type':'application/json'} : {}), ...init?.headers },
    })
    let payload:any = {}
    try { payload = await response.json() } catch {}
    if (response.status===401) { setState('auth'); throw new Error('Sign in with your restaurant owner or manager account.') }
    if (response.status===403) { setState('forbidden'); throw new Error('Your account cannot manage restaurant tables.') }
    if (!response.ok) throw new Error(payload.error || 'Table request failed.')
    return payload
  },[endpoint])

  const load = useCallback(async () => {
    if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(endpoint)) { setError('Enter a valid restaurant slug.'); return }
    setBusy(true); setError(''); setState('loading')
    try { const payload=await request('/tables'); setTables(payload.tables||[]); setState('ready') }
    catch (e) { setState(s=>s==='auth'||s==='forbidden'?s:'error'); setError(e instanceof Error?e.message:'Could not load tables.') }
    finally { setBusy(false) }
  },[endpoint,request])

  useEffect(()=>{ setTables([]); setCreated(null); setQrImage(''); setQrError(''); setState('idle') },[endpoint])
  useEffect(()=>{ if(initialSlug) void load() },[initialSlug])

  useEffect(()=>{
    let cancelled=false
    if (!created?.url) { setQrImage(''); return }
    QRCode.toDataURL(created.url,{ errorCorrectionLevel:'H', margin:2, width:420, color:{dark:'#111827',light:'#ffffff'} })
      .then(value=>{ if(!cancelled) { setQrImage(value); setQrError('') } })
      .catch(()=>{ if(!cancelled) setQrError('QR artwork could not be generated on this device. You can still copy the secure link.') })
    return ()=>{ cancelled=true }
  },[created])

  async function createTable(e:React.FormEvent) {
    e.preventDefault()
    if (!label.trim()) { setError('Enter a table name or label.'); return }
    setBusy(true); setError('')
    try {
      const payload=await request('/tables',{method:'POST',body:JSON.stringify({label:label.trim(),table_type:kind,table_number:kind==='dine_in'&&number?Number(number):null})})
      const origin=window.location.origin
      const url=`${origin}/r/${encodeURIComponent(endpoint)}/${encodeURIComponent(payload.qr_token)}`
      setCreated({label:payload.table.label,url})
      setLabel(''); setNumber('')
      const refreshed=await request('/tables'); setTables(refreshed.tables||[]); setState('ready')
    } catch(e) { setError(e instanceof Error?e.message:'Could not create table.') }
    finally { setBusy(false) }
  }

  async function saveTable(tableId:string) {
    if (!editLabel.trim()) { setError('Enter a table label.'); return }
    setBusy(true); setError('')
    try {
      await request('/tables/'+encodeURIComponent(tableId),{method:'PATCH',body:JSON.stringify({label:editLabel.trim()})})
      setEditingId(''); setEditLabel('')
      await load()
    } catch(e) { setError(e instanceof Error?e.message:'Could not rename table.') }
    finally { setBusy(false) }
  }

  async function removeTable(tableId:string,labelText:string) {
    if (!window.confirm('Remove '+labelText+' from active tables? Past orders will be preserved.')) return
    setBusy(true); setError('')
    try {
      await request('/tables/'+encodeURIComponent(tableId),{method:'DELETE'})
      await load()
    } catch(e) { setError(e instanceof Error?e.message:'Could not remove table.') }
    finally { setBusy(false) }
  }

  async function copy(value:string) {
    try { await navigator.clipboard.writeText(value); setError('Copied to clipboard.') }
    catch { setError('Clipboard access is unavailable. Select and copy the link manually.') }
  }

  return <section className="panel restaurant-tables">
    <div className="panel-heading"><div><h2>Tables & QR access</h2><p>Create table records and issue secure guest QR links.</p></div><Table2 size={20}/></div>
    {!initialSlug && <div className="restaurant-table-connect">
      <label>Restaurant slug<input value={slug} onChange={e=>setSlug(e.target.value)} placeholder="your-restaurant" autoCapitalize="none"/></label>
      <button className="button secondary" onClick={()=>void load()} disabled={busy}><RefreshCw size={15}/>{busy?'Loading':'Load tables'}</button>
    </div>}
    {state==='auth'&&<div className="restaurant-inline-error"><AlertCircle size={16}/>Owner sign-in required.</div>}
    {state==='forbidden'&&<div className="restaurant-inline-error"><AlertCircle size={16}/>Owner or manager access required.</div>}
    {error&&<p className="restaurant-table-message" role="status">{error}</p>}
    <form className="restaurant-table-form" onSubmit={createTable}>
      <h3><Plus size={17}/> Add a table</h3>
      <label>Table label<input value={label} onChange={e=>setLabel(e.target.value)} placeholder="e.g. Table 01 or Takeaway" maxLength={80} required/></label>
      <div className="restaurant-table-form-row">
        <label>Type<select value={kind} onChange={e=>setKind(e.target.value as 'dine_in'|'takeaway')}><option value="dine_in">Dine-in</option><option value="takeaway">Takeaway</option></select></label>
        {kind==='dine_in'&&<label>Table number<input type="number" min="1" max="9999" value={number} onChange={e=>setNumber(e.target.value)} placeholder="Optional"/></label>}
      </div>
      <button className="button primary" disabled={busy||!endpoint}>Create table & issue QR link</button>
    </form>
    {created&&<div className="restaurant-qr-backdrop" role="presentation" onClick={()=>setCreated(null)}><section className="restaurant-qr-issued" role="dialog" aria-modal="true" aria-label={`QR code for ${created.label}`} onClick={event=>event.stopPropagation()}><div className="restaurant-qr-title"><QrCode size={18}/><b>{created.persistent?'Table QR code':'New guest QR link issued'}: {created.label}</b><button type="button" className="restaurant-qr-close" onClick={()=>setCreated(null)} aria-label="Close QR dialog"><X size={19}/></button></div><p>{created.persistent?'This demo QR can be reopened from the table list at any time.':'This secure token is shown only once. Save or print this QR now.'}</p><div className="restaurant-qr-print-card"><div className="restaurant-qr-print-brand">SCAN TO VIEW MENU</div>{qrImage?<img className="restaurant-qr-image" src={qrImage} alt={`Guest menu QR code for ${created.label}`}/>:<div className="restaurant-qr-image-placeholder">{qrError||"Generating QR code…"}</div>}<b>{created.label}</b><small>Scan with your phone camera to open the menu</small></div><div className="restaurant-qr-url">{created.url}</div>{qrError&&<p role="status">{qrError}</p>}<div className="restaurant-qr-actions"><button className="button secondary" onClick={()=>void copy(created.url)}><Copy size={15}/>Copy link</button><button className="button secondary" onClick={()=>window.print()} disabled={!qrImage}><QrCode size={15}/>Print table QR</button><a className="button secondary" href={created.url} target="_blank" rel="noreferrer"><ExternalLink size={15}/>Open guest menu</a></div></section></div>}
    <div className="restaurant-table-list-head"><h3>Restaurant tables</h3><span>{tables.length} records</span></div>
    {state==='ready'&&tables.length===0&&<div className="restaurant-table-empty"><Table2 size={22}/><b>No tables yet</b><span>Create the first dine-in or takeaway table above.</span></div>}
    <div className="restaurant-table-list">{tables.map(table=><article className="restaurant-table-row" key={table.id}>
      <div className="restaurant-table-card-header">
        <div className="restaurant-table-icon"><Table2 size={18}/></div>
        <div className="restaurant-table-copy">
          {editingId===table.id?<input aria-label={'Rename '+table.label} value={editLabel} maxLength={80} onChange={e=>setEditLabel(e.target.value)}/>:<b>{table.label}</b>}
          <small>{table.table_type==='takeaway'?'Takeaway':'Dine-in'}{table.table_number? ` · #${table.table_number}`:''} · {table.session_id?'Session open':'No open session'}</small>
          {table.open_requests>0&&<small className="restaurant-table-requests">{table.open_requests} open requests</small>}
        </div>
        <span className={`restaurant-table-active-badge ${table.active?'active':'inactive'}`}>{table.active?'Active':'Inactive'}</span>
      </div>
      <div className="restaurant-table-actions">
        {editingId===table.id?<><button type="button" className="button secondary small" disabled={busy} onClick={()=>void saveTable(table.id)}><Save size={15}/>Save</button><button type="button" className="restaurant-table-icon-action" onClick={()=>setEditingId('')} aria-label="Cancel rename" title="Cancel"><X size={17}/></button></>:<>
          {table.qr_url&&<button type="button" className="restaurant-table-show-qr" onClick={()=>setCreated({label:table.label,url:new URL(table.qr_url!,window.location.origin).toString(),persistent:true})}><QrCode size={16}/>Show QR</button>}
          {table.active&&<button type="button" className="restaurant-table-icon-action" onClick={()=>{setEditingId(table.id);setEditLabel(table.label)}} aria-label={'Rename '+table.label} title="Rename"><Pencil size={17}/></button>}
          {table.active&&<button type="button" className="restaurant-table-icon-action danger" disabled={busy||Boolean(table.session_id)} onClick={()=>void removeTable(table.id,table.label)} aria-label={'Remove '+table.label} title={table.session_id?'Close the session before removing':'Remove table'}><Trash2 size={17}/></button>}
        </>}
      </div>
    </article>)}</div>
    <p className="restaurant-table-footnote"><Check size={14}/> Demo table QR links remain available here after refreshing. Other restaurants keep their secure one-time QR token behavior.</p>
  </section>
}
