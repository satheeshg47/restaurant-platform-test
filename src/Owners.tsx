import { apiFetch } from './auth'
import {useCallback,useEffect,useState} from 'react'
import {Copy,MailPlus,RefreshCw,ShieldAlert,Users,X,Ban} from 'lucide-react'
type OwnerRow={tenant_id:string;tenant_name:string;tenant_slug:string;tenant_status:string;tenant_created_at:string;user_id:string|null;email:string|null;role:string|null;membership_status:string|null;membership_created_at:string|null;owner_present:boolean}
type Invitation={id:string;tenant_id:string;tenant_name:string;tenant_slug:string;email:string;status:'pending'|'accepted'|'revoked'|'expired';created_at:string;expires_at:string}
const API_BASE=(import.meta.env.VITE_API_BASE_URL||'/api').replace(/\/$/,'')
export default function Owners(){
 const [rows,setRows]=useState<OwnerRow[]>([]),[state,setState]=useState('loading'),[error,setError]=useState(''),[busy,setBusy]=useState(false)
 const [invitations,setInvitations]=useState<Invitation[]>([]),[invitationState,setInvitationState]=useState('loading'),[invitationError,setInvitationError]=useState(''),[revoking,setRevoking]=useState('')
 const [target,setTarget]=useState<OwnerRow|null>(null),[email,setEmail]=useState(''),[inviteBusy,setInviteBusy]=useState(false),[inviteError,setInviteError]=useState(''),[created,setCreated]=useState<{invitation:Invitation;token:string}|null>(null),[copied,setCopied]=useState(false)
 const [tenantName,setTenantName]=useState(''),[tenantSlug,setTenantSlug]=useState(''),[tenantBusy,setTenantBusy]=useState(false),[tenantError,setTenantError]=useState(''),[statusBusy,setStatusBusy]=useState('')
 const refresh=useCallback(async()=>{setBusy(true);setError('');try{
  const session=await apiFetch(`${API_BASE}/admin/session`,{cache:'no-store'})
  if(!session.ok){setState(session.status===503?'auth_not_configured':session.status===403?'forbidden':'sign_in_required');setRows([]);return}
  const response=await apiFetch(`${API_BASE}/admin/owners`,{cache:'no-store'})
  if(!response.ok)throw new Error(response.status===503?'Platform database is not configured.':'Owner directory could not be loaded.')
  const data=await response.json();if(!Array.isArray(data.owners))throw new Error('Invalid owner directory response.')
  setRows(data.owners);setState('ready')
  const invitationResponse=await apiFetch(`${API_BASE}/admin/owner-invitations`,{cache:'no-store'})
  if(!invitationResponse.ok)throw new Error('Owner directory loaded, but invitations could not be loaded.')
  const invitationData=await invitationResponse.json();if(!Array.isArray(invitationData.invitations))throw new Error('Invalid invitation list response.')
  setInvitations(invitationData.invitations);setInvitationState('ready');setInvitationError('')
 }catch(e){setError(e instanceof Error?e.message:'Unexpected error');setState('unavailable');setRows([]);setInvitationState('unavailable');setInvitationError(e instanceof Error?e.message:'Unexpected error')}finally{setBusy(false)}},[])
 useEffect(()=>{void refresh()},[refresh])
 const revokeInvite=async(invitation:Invitation)=>{if(!window.confirm(`Revoke the invitation for ${invitation.email}? The one-time token will stop working.`))return;setRevoking(invitation.id);setInvitationError('');try{const response=await apiFetch(`${API_BASE}/admin/owner-invitations/${invitation.id}/revoke`,{method:'POST',headers:{Accept:'application/json'},cache:'no-store'});const payload=await response.json().catch(()=>({}));if(!response.ok)throw new Error(payload.error==='invitation_not_pending'?'This invitation is no longer pending. Refresh the list.':payload.error||'Invitation could not be revoked.');setInvitations(current=>current.map(item=>item.id===invitation.id?{...item,status:'revoked'}:item))}catch(e){setInvitationError(e instanceof Error?e.message:'Invitation could not be revoked.')}finally{setRevoking('')}}
 const createTenant=async()=>{
  if(!tenantName.trim()||!tenantSlug.trim())return
  setTenantBusy(true);setTenantError('')
  try{
   const response=await apiFetch(`${API_BASE}/admin/tenants`,{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json'},cache:'no-store',body:JSON.stringify({name:tenantName.trim(),slug:tenantSlug.trim().toLowerCase()})})
   const payload=await response.json().catch(()=>({}))
   if(!response.ok)throw new Error(payload.error==='tenant_slug_exists'?'That restaurant slug is already in use.':payload.error||'Restaurant could not be created.')
   setTenantName('');setTenantSlug('')
   await refresh()
  }catch(e){setTenantError(e instanceof Error?e.message:'Restaurant could not be created.')}finally{setTenantBusy(false)}
 }
 const changeTenantStatus=async(row:OwnerRow)=>{
  const next=row.tenant_status==='active'?'suspended':'active'
  const verb=next==='suspended'?'suspend':'reactivate'
  if(!window.confirm(`Are you sure you want to ${verb} ${row.tenant_name}? ${next==='suspended'?'Owner and guest access will be blocked until it is reactivated.':'Access will be restored for active members.'}`))return
  setStatusBusy(row.tenant_id);setError('')
  try{
   const response=await apiFetch(`${API_BASE}/admin/tenants/${row.tenant_id}/status`,{method:'PATCH',headers:{'Content-Type':'application/json',Accept:'application/json'},cache:'no-store',body:JSON.stringify({status:next})})
   const payload=await response.json().catch(()=>({}))
   if(!response.ok)throw new Error(payload.error||'Restaurant status could not be updated.')
   setRows(current=>current.map(item=>item.tenant_id===row.tenant_id?{...item,tenant_status:payload.tenant?.status||next}:item))
  }catch(e){setError(e instanceof Error?e.message:'Restaurant status could not be updated.')}
  finally{setStatusBusy('')}
 }
 const openInvite=(row:OwnerRow)=>{setTarget(row);setEmail('');setInviteError('');setCreated(null);setCopied(false)}
 const closeInvite=()=>{setTarget(null);setEmail('');setInviteError('');setCreated(null);setCopied(false)}
 const createInvite=async()=>{
  if(!target||!email.trim())return
  setInviteBusy(true);setInviteError('')
  try{
   const response=await apiFetch(`${API_BASE}/admin/owner-invitations`,{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json'},cache:'no-store',body:JSON.stringify({tenant_id:target.tenant_id,email:email.trim()})})
   const payload=await response.json().catch(()=>({}))
   if(!response.ok)throw new Error(payload.error==='active_owner_already_exists'?'This tenant already has an active owner.':payload.error==='pending_invitation_exists'?'A pending invitation already exists for this email.':payload.error==='tenant_not_found'?'The tenant is no longer active.':payload.error||'Invitation could not be created.')
   if(typeof payload.token!=='string'||!payload.invitation)throw new Error('The API returned an incomplete invitation response.')
   setCreated({invitation:payload.invitation,token:payload.token})
  }catch(e){setInviteError(e instanceof Error?e.message:'Invitation could not be created.')}finally{setInviteBusy(false)}
 }
 const invitationLink=created?window.location.origin+'/owner/invitations/accept#token='+encodeURIComponent(created.token):''
 const copyInviteLink=async()=>{if(!invitationLink)return;try{await navigator.clipboard.writeText(invitationLink);setCopied(true)}catch{setInviteError('Clipboard access was blocked. Select and copy the invitation link manually.')}}
 return <section className="panel live-applications" aria-live="polite">
  <div className="panel-heading"><div><h2>Owner directory</h2><p>Tenant ownership and membership status from the protected platform API.</p></div><button className="button secondary small" onClick={()=>void refresh()} disabled={busy}><RefreshCw size={14}/>{busy?'Checking…':'Refresh'}</button></div>
  {state==='ready'&&<form className="tenant-create-form" onSubmit={e=>{e.preventDefault();void createTenant()}}>
   <div><b>Create a restaurant</b><p>Create an active tenant, enable Restaurant Suite and prepare default settings. You can invite its owner next.</p></div>
   <label>Restaurant name<input maxLength={160} value={tenantName} onChange={e=>setTenantName(e.target.value)} placeholder="e.g. Green Leaf Kitchen" required/></label>
   <label>Restaurant slug<input maxLength={63} autoCapitalize="none" value={tenantSlug} onChange={e=>setTenantSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g,'-').replace(/--+/g,'-'))} placeholder="green-leaf-kitchen" required/></label>
   <button className="button primary" type="submit" disabled={tenantBusy||!tenantName.trim()||!tenantSlug.trim()}>{tenantBusy?'Creating…':'Create restaurant'}</button>
   {tenantError&&<p className="registry-error" role="alert">{tenantError}</p>}
  </form>}
  {state!=='ready'&&<div className="registry-state registry-blocked"><ShieldAlert size={20}/><div><b>{state==='loading'?'Loading owner directory':state==='auth_not_configured'?'Administrator sign-in is not configured':state==='forbidden'?'Owner access denied':state==='sign_in_required'?'Owner sign-in required':'Owner directory unavailable'}</b><p>{error||'Only the configured platform owner can view this directory. No sample records are displayed.'}</p></div></div>}
  {state==='ready'&&(rows.length===0?<div className="registry-empty"><Users size={22}/><b>No tenants found</b><p>Tenants will appear here after they are created.</p></div>:<div className="app-list">{rows.map(row=><div className="app-row" key={row.tenant_id}><div className="app-icon violet">{row.tenant_name.slice(0,2).toUpperCase()}</div><div className="app-info"><b>{row.tenant_name}</b><small>{row.tenant_slug} · {row.owner_present?row.email||'Owner account':'No owner assigned'}</small><small>Tenant: {row.tenant_status} · Membership: {row.membership_status||'—'}</small></div><span className={`status ${row.tenant_status==='active'?'active':'paused'}`}>{row.tenant_status}</span><span className={`status ${row.owner_present?'active':'draft'}`}>{row.owner_present?'Owner listed':'Unassigned'}</span>{!row.owner_present&&row.tenant_status==='active'&&<button className="button secondary small" onClick={()=>openInvite(row)}><MailPlus size={14}/> Invite</button>}{(row.tenant_status==='active'||row.tenant_status==='suspended')&&<button className="button secondary small" onClick={()=>void changeTenantStatus(row)} disabled={statusBusy===row.tenant_id}>{statusBusy===row.tenant_id?'Saving…':row.tenant_status==='active'?'Suspend':'Reactivate'}</button>}</div>)}</div>)}
  <div className="registry-footnote">Owner invitations are available for active tenants without an owner. Super Admin can suspend or reactivate a tenant; suspension blocks owner and guest access without deleting customer data. Ownership transfer remains a separate controlled workflow.</div>
  <div className="panel-heading" style={{marginTop:24}}><div><h2>Owner invitations</h2><p>Review invitation status and revoke unused links.</p></div><span className="status">{invitations.filter(item=>item.status==='pending').length} pending</span></div>
  {invitationError&&<div className="registry-state registry-blocked" role="alert"><ShieldAlert size={18}/><p>{invitationError}</p></div>}
  {invitationState==='loading'&&<p className="registry-footnote">Loading invitations…</p>}
  {invitationState==='ready'&&(invitations.length===0?<div className="registry-empty"><MailPlus size={22}/><b>No invitations yet</b><p>New owner invitations will appear here.</p></div>:<div className="app-list">{invitations.map(invitation=><div className="app-row" key={invitation.id}><div className="app-icon violet"><MailPlus size={18}/></div><div className="app-info"><b>{invitation.email}</b><small>{invitation.tenant_name} · {invitation.tenant_slug}</small><small>Created {new Date(invitation.created_at).toLocaleString()} · Expires {new Date(invitation.expires_at).toLocaleString()}</small></div><span className={`status ${invitation.status==='pending'?'draft':invitation.status==='accepted'?'active':'paused'}`}>{invitation.status}</span>{invitation.status==='pending'&&<button className="button secondary small" onClick={()=>void revokeInvite(invitation)} disabled={revoking===invitation.id}><Ban size={14}/>{revoking===invitation.id?'Revoking…':'Revoke'}</button>}</div>)}</div>)}

  {target&&<div className="modal-backdrop" role="presentation"><section className="modal" role="dialog" aria-modal="true" aria-labelledby="invite-title">
   <div className="modal-top"><div><span className="eyebrow">OWNER ACCESS</span><h2 id="invite-title">{created?'Invitation created':'Invite an owner'}</h2></div><button className="icon-button" onClick={closeInvite} aria-label="Close"><X size={18}/></button></div>
   {!created?<><p className="modal-desc">Create a one-time, 48-hour invitation for <b>{target.tenant_name}</b>. The tenant must not already have an active owner.</p><label htmlFor="owner-invite-email">Owner email address</label><input id="owner-invite-email" className="modal-input" type="email" autoComplete="email" maxLength={320} value={email} onChange={e=>setEmail(e.target.value)} placeholder="owner@example.com"/>{inviteError&&<p role="alert" className="modal-desc">{inviteError}</p>}<div className="modal-actions"><button className="button secondary" onClick={closeInvite}>Cancel</button><button className="button primary" onClick={()=>void createInvite()} disabled={inviteBusy||!email.trim()}><MailPlus size={14}/>{inviteBusy?'Creating…':'Create invitation'}</button></div></>:<><p className="modal-desc">The invitation is valid until {new Date(created.invitation.expires_at).toLocaleString()}. Share this one-time link with the invited person using a secure channel. It will not be shown again after closing this dialog.</p><label htmlFor="owner-invite-link">One-time invitation link</label><textarea id="owner-invite-link" className="modal-input" readOnly rows={3} value={invitationLink}/><div className="feature-note"><ShieldAlert size={15}/> The link contains a one-time token in the URL fragment. Acceptance requires sign-in with the same verified email address as the invitation.</div>{inviteError&&<p role="alert" className="modal-desc">{inviteError}</p>}<div className="modal-actions"><button className="button secondary" onClick={closeInvite}>Close</button><button className="button primary" onClick={()=>void copyInviteLink()}><Copy size={14}/>{copied?'Copied':'Copy invitation link'}</button></div></>}
  </section></div>}
 </section>
}
