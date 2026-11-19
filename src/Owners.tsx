import { apiFetch } from './auth'
import {useCallback,useEffect,useState} from 'react'
import {Copy,MailPlus,RefreshCw,ShieldAlert,Users,X,Ban} from 'lucide-react'
type OwnerRow={tenant_id:string;tenant_name:string;tenant_slug:string;tenant_status:string;tenant_created_at:string;user_id:string|null;email:string|null;role:string|null;membership_status:string|null;membership_created_at:string|null;owner_present:boolean}
type Invitation={id:string;tenant_id:string;tenant_name:string;tenant_slug:string;email:string;status:'pending'|'accepted'|'revoked'|'expired';created_at:string;expires_at:string}
const API_BASE=(import.meta.env.VITE_API_BASE_URL||'/api').replace(/\/$/,'')
export default function Owners(){
 const [rows,setRows]=useState<OwnerRow[]>([]),[state,setState]=useState('loading'),[error,setError]=useState(''),[busy,setBusy]=useState(false)
 const [invitations,setInvitations]=useState<Invitation[]>([]),[invitationState,setInvitationState]=useState('loading'),[invitationError,setInvitationError]=useState(''),[revoking,setRevoking]=useState('')
 const [target,setTarget]=useState<OwnerRow|null>(null),[email,setEmail]=useState(''),[inviteBusy,setInviteBusy]=useState(false),[inviteError,setInviteError]=useState(''),[created,setCreated]=useState<{invitation:Invitation;token?:string;delivery:string}|null>(null),[copied,setCopied]=useState(false)
 const [tenantName,setTenantName]=useState(''),[tenantSlug,setTenantSlug]=useState(''),[tenantBusy,setTenantBusy]=useState(false),[tenantError,setTenantError]=useState(''),[statusBusy,setStatusBusy]=useState('');
 const [resetBusy,setResetBusy]=useState(''),[resetNotice,setResetNotice]=useState('')
 const [transferTarget,setTransferTarget]=useState<OwnerRow|null>(null),[transferEmail,setTransferEmail]=useState(''),[transferReason,setTransferReason]=useState(''),[transferType,setTransferType]=useState<'standard'|'admin_controlled'>('standard'),[transferBusy,setTransferBusy]=useState(false),[transferError,setTransferError]=useState(''),[transferCreated,setTransferCreated]=useState<{token?:string;approval_token?:string;delivery:string;expires_at:string;email:string;outgoing_owner_email?:string;tenant_name:string}|null>(null),[transferCopied,setTransferCopied]=useState(false)
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
 const sendOwnerReset=async(row:OwnerRow)=>{
  if(!row.user_id||!window.confirm(`Send a password reset link to ${row.email||'this Owner'}?`))return
  setResetBusy(row.user_id);setResetNotice('')
  try{
   const response=await apiFetch(`${API_BASE}/admin/users/${row.user_id}/password-reset`,{method:'POST',headers:{Accept:'application/json'},cache:'no-store'})
   const payload=await response.json().catch(()=>({}))
   if(!response.ok)throw new Error(payload.error==='email_delivery_not_configured'?'Email delivery is not configured yet.':payload.error||'Password reset email could not be sent.')
   setResetNotice('Password reset link sent to '+(row.email||'the Owner')+'.')
  }catch(e){setResetNotice(e instanceof Error?e.message:'Password reset email could not be sent.')}
  finally{setResetBusy('')}
 }
 const openTransfer=(row:OwnerRow)=>{setTransferTarget(row);setTransferEmail('');setTransferReason('');setTransferType('standard');setTransferError('');setTransferCreated(null);setTransferCopied(false)}
 const closeTransfer=()=>{setTransferTarget(null);setTransferEmail('');setTransferReason('');setTransferError('');setTransferCreated(null);setTransferCopied(false)}
 const createTransfer=async()=>{
  if(!transferTarget||!transferEmail.trim()||transferReason.trim().length<3)return
  if(transferType==='admin_controlled'&&!window.confirm('Admin-controlled transfer bypasses outgoing Owner approval. Confirm that you have independently verified the business transfer and recorded the evidence in the reason. Continue?'))return
  setTransferBusy(true);setTransferError('')
  try{
   const response=await apiFetch(`${API_BASE}/admin/tenants/${transferTarget.tenant_id}/owner-transfer`,{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json'},cache:'no-store',body:JSON.stringify({email:transferEmail.trim(),reason:transferReason.trim(),transfer_type:transferType})})
   const payload=await response.json().catch(()=>({}))
   if(!response.ok)throw new Error(payload.error==='transfer_already_pending'?'A transfer is already pending for this restaurant.':payload.error||'Ownership transfer could not be started.')
   setTransferCreated({token:typeof payload.token==='string'?payload.token:undefined,approval_token:typeof payload.approval_token==='string'?payload.approval_token:undefined,delivery:payload.delivery||'manual_link_required',expires_at:payload.transfer.expires_at,email:payload.transfer.target_email,outgoing_owner_email:payload.transfer.outgoing_owner_email||undefined,tenant_name:payload.transfer.tenant_name})
  }catch(e){setTransferError(e instanceof Error?e.message:'Ownership transfer could not be started.')}finally{setTransferBusy(false)}
 }
 const transferLink=transferCreated?.token?window.location.origin+'/owner/transfers/accept#token='+encodeURIComponent(transferCreated.token):''
 const approvalLink=transferCreated?.approval_token?window.location.origin+'/owner/transfers/approve#token='+encodeURIComponent(transferCreated.approval_token):''
 const copyTransferLink=async()=>{const links=[transferLink,approvalLink].filter(Boolean).join('\\n');if(!links)return;try{await navigator.clipboard.writeText(links);setTransferCopied(true)}catch{setTransferError('Clipboard access was blocked. Select and copy the links manually.')}}
 const openInvite=(row:OwnerRow)=>{setTarget(row);setEmail('');setInviteError('');setCreated(null);setCopied(false)}
 const closeInvite=()=>{setTarget(null);setEmail('');setInviteError('');setCreated(null);setCopied(false)}
 const createInvite=async()=>{
  if(!target||!email.trim())return
  setInviteBusy(true);setInviteError('')
  try{
   const response=await apiFetch(`${API_BASE}/admin/owner-invitations`,{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json'},cache:'no-store',body:JSON.stringify({tenant_id:target.tenant_id,email:email.trim()})})
   const payload=await response.json().catch(()=>({}))
   if(!response.ok)throw new Error(payload.error==='active_owner_already_exists'?'This tenant already has an active owner.':payload.error==='pending_invitation_exists'?'A pending invitation already exists for this email.':payload.error==='tenant_not_found'?'The tenant is no longer active.':payload.error||'Invitation could not be created.')
   if(!payload.invitation)throw new Error('The API returned an incomplete invitation response.')
   setCreated({invitation:payload.invitation,token:typeof payload.token==='string'?payload.token:undefined,delivery:payload.delivery||'manual_link_required'})
  }catch(e){setInviteError(e instanceof Error?e.message:'Invitation could not be created.')}finally{setInviteBusy(false)}
 }
 const invitationLink=created?.token?window.location.origin+'/owner/invitations/accept#token='+encodeURIComponent(created.token):''
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
  {resetNotice&&<div className="registry-state registry-blocked" role="status"><p>{resetNotice}</p></div>}
  {state==='ready'&&(rows.length===0?<div className="registry-empty"><Users size={22}/><b>No tenants found</b><p>Tenants will appear here after they are created.</p></div>:<div className="app-list">{rows.map(row=><div className="app-row" key={row.tenant_id}><div className="app-icon violet">{row.tenant_name.slice(0,2).toUpperCase()}</div><div className="app-info"><b>{row.tenant_name}</b><small>{row.tenant_slug} · {row.owner_present?row.email||'Owner account':'No owner assigned'}</small><small>Tenant: {row.tenant_status} · Membership: {row.membership_status||'—'}</small></div><span className={`status ${row.tenant_status==='active'?'active':'paused'}`}>{row.tenant_status}</span><span className={`status ${row.owner_present?'active':'draft'}`}>{row.owner_present?'Owner listed':'Unassigned'}</span>{!row.owner_present&&row.tenant_status==='active'&&<button className="button secondary small" onClick={()=>openInvite(row)}><MailPlus size={14}/> Invite</button>}{row.owner_present&&row.membership_status==='active'&&row.tenant_status==='active'&&<><button className="button secondary small" onClick={()=>void sendOwnerReset(row)} disabled={resetBusy===row.user_id}><MailPlus size={14}/>{resetBusy===row.user_id?'Sending…':'Send reset link'}</button><button className="button secondary small" onClick={()=>openTransfer(row)}><Users size={14}/> Transfer ownership</button></>}{(row.tenant_status==='active'||row.tenant_status==='suspended')&&<button className="button secondary small" onClick={()=>void changeTenantStatus(row)} disabled={statusBusy===row.tenant_id}>{statusBusy===row.tenant_id?'Saving…':row.tenant_status==='active'?'Suspend':'Reactivate'}</button>}</div>)}</div>)}
  <div className="registry-footnote">Owner invitations are available for active tenants without an owner. Super Admin can suspend or reactivate a tenant; suspension blocks owner and guest access without deleting customer data. Ownership transfer remains a separate controlled workflow.</div>
  <div className="panel-heading" style={{marginTop:24}}><div><h2>Owner invitations</h2><p>Review invitation status and revoke unused links.</p></div><span className="status">{invitations.filter(item=>item.status==='pending').length} pending</span></div>
  {invitationError&&<div className="registry-state registry-blocked" role="alert"><ShieldAlert size={18}/><p>{invitationError}</p></div>}
  {invitationState==='loading'&&<p className="registry-footnote">Loading invitations…</p>}
  {invitationState==='ready'&&(invitations.length===0?<div className="registry-empty"><MailPlus size={22}/><b>No invitations yet</b><p>New owner invitations will appear here.</p></div>:<div className="app-list">{invitations.map(invitation=><div className="app-row" key={invitation.id}><div className="app-icon violet"><MailPlus size={18}/></div><div className="app-info"><b>{invitation.email}</b><small>{invitation.tenant_name} · {invitation.tenant_slug}</small><small>Created {new Date(invitation.created_at).toLocaleString()} · Expires {new Date(invitation.expires_at).toLocaleString()}</small></div><span className={`status ${invitation.status==='pending'?'draft':invitation.status==='accepted'?'active':'paused'}`}>{invitation.status}</span>{invitation.status==='pending'&&<button className="button secondary small" onClick={()=>void revokeInvite(invitation)} disabled={revoking===invitation.id}><Ban size={14}/>{revoking===invitation.id?'Revoking…':'Revoke'}</button>}</div>)}</div>)}

  {transferTarget&&<div className="modal-backdrop" role="presentation"><section className="modal" role="dialog" aria-modal="true" aria-labelledby="transfer-title">
   <div className="modal-top"><div><span className="eyebrow">OWNERSHIP CONTROL</span><h2 id="transfer-title">{transferCreated?'Transfer invitation created':'Transfer restaurant ownership'}</h2></div><button className="icon-button" onClick={closeTransfer} aria-label="Close"><X size={18}/></button></div>
   {!transferCreated?<><p className="modal-desc">Invite a new primary Owner for <b>{transferTarget.tenant_name}</b>. The current Owner loses access only after the new Owner accepts.</p>
    <label htmlFor="transfer-email">New Owner email</label><input id="transfer-email" className="modal-input" type="email" value={transferEmail} onChange={e=>setTransferEmail(e.target.value)} autoComplete="email" maxLength={320} placeholder="new.owner@example.com"/>
    <label htmlFor="transfer-reason">Reason / verification reference</label><textarea id="transfer-reason" className="modal-input" rows={3} maxLength={1000} value={transferReason} onChange={e=>setTransferReason(e.target.value)} placeholder="Record the business transfer reference or verification basis."/>
    <label htmlFor="transfer-type">Transfer approval type</label><select id="transfer-type" className="modal-input" value={transferType} onChange={e=>setTransferType(e.target.value as 'standard'|'admin_controlled')}><option value="standard">Standard — documented transfer</option><option value="admin_controlled">Admin-controlled — outgoing Owner unavailable</option></select>
    {transferError&&<p role="alert" className="modal-desc">{transferError}</p>}
    <div className="modal-actions"><button className="button secondary" onClick={closeTransfer}>Cancel</button><button className="button primary" onClick={()=>void createTransfer()} disabled={transferBusy||!transferEmail.trim()||transferReason.trim().length<3}><MailPlus size={14}/>{transferBusy?'Creating…':'Send transfer invitation'}</button></div>
   </>:<><p className="modal-desc">{transferCreated.delivery==='email_sent'?<>Invitation emails were sent to the incoming Owner <b>{transferCreated.email}</b> and current Owner <b>{transferCreated.outgoing_owner_email||'the current Owner'}</b>. The current Owner remains active until both approval and acceptance are complete.</>:<>One or more invitation emails could not be delivered. Share the link or links shown below securely. The current Owner remains active until all required steps are complete.</>} Expires {new Date(transferCreated.expires_at).toLocaleString()}.</p>
    {transferCreated.token&&<><label htmlFor="transfer-link">Incoming Owner acceptance link — {transferCreated.email}</label><textarea id="transfer-link" className="modal-input" rows={2} readOnly value={transferLink}/></>}
    {transferCreated.approval_token&&<><label htmlFor="transfer-approval-link">Outgoing Owner approval link — {transferCreated.outgoing_owner_email||'current Owner'}</label><textarea id="transfer-approval-link" className="modal-input" rows={2} readOnly value={approvalLink}/></>}
    {transferError&&<p role="alert" className="modal-desc">{transferError}</p>}
    <div className="modal-actions"><button className="button secondary" onClick={closeTransfer}>Close</button>{(transferCreated.token||transferCreated.approval_token)&&<button className="button primary" onClick={()=>void copyTransferLink()}><Copy size={14}/>{transferCopied?'Copied':'Copy required link(s)'}</button>}</div>
   </>}
  </section></div>}
  {target&&<div className="modal-backdrop" role="presentation"><section className="modal" role="dialog" aria-modal="true" aria-labelledby="invite-title">
   <div className="modal-top"><div><span className="eyebrow">OWNER ACCESS</span><h2 id="invite-title">{created?'Invitation created':'Invite an owner'}</h2></div><button className="icon-button" onClick={closeInvite} aria-label="Close"><X size={18}/></button></div>
   {!created?<><p className="modal-desc">Create a one-time, 48-hour invitation for <b>{target.tenant_name}</b>. The tenant must not already have an active owner.</p><label htmlFor="owner-invite-email">Owner email address</label><input id="owner-invite-email" className="modal-input" type="email" autoComplete="email" maxLength={320} value={email} onChange={e=>setEmail(e.target.value)} placeholder="owner@example.com"/>{inviteError&&<p role="alert" className="modal-desc">{inviteError}</p>}<div className="modal-actions"><button className="button secondary" onClick={closeInvite}>Cancel</button><button className="button primary" onClick={()=>void createInvite()} disabled={inviteBusy||!email.trim()}><MailPlus size={14}/>{inviteBusy?'Creating…':'Create invitation'}</button></div></>:<>{created.delivery==='email_sent'?<p className="modal-desc">Invitation email sent to <b>{created.invitation.email}</b>. It expires {new Date(created.invitation.expires_at).toLocaleString()}.</p>:<><p className="modal-desc">Email delivery is not configured yet. Copy this one-time link and share it securely. It expires {new Date(created.invitation.expires_at).toLocaleString()}.</p><label htmlFor="owner-invite-link">One-time invitation link</label><textarea id="owner-invite-link" className="modal-input" readOnly rows={3} value={invitationLink}/><div className="feature-note"><ShieldAlert size={15}/> The invitation token is single-use and tied to the invited email address.</div></>}{inviteError&&<p role="alert" className="modal-desc">{inviteError}</p>}<div className="modal-actions"><button className="button secondary" onClick={closeInvite}>Close</button>{created.token&&<button className="button primary" onClick={()=>void copyInviteLink()}><Copy size={14}/>{copied?'Copied':'Copy invitation link'}</button>}</div></>}
  </section></div>}
 </section>
}
