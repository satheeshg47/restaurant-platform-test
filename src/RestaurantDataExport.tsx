import { apiFetch } from './auth'
import { useState } from 'react'
import { AlertCircle, Database, Download, RefreshCw, ShieldCheck, Table2 } from 'lucide-react'

const API_BASE_RAW=import.meta.env.VITE_API_BASE_URL||'/api'
const API_BASE=API_BASE_RAW.endsWith('/')?API_BASE_RAW.slice(0,-1):API_BASE_RAW
const SLUG=/^[a-z0-9][a-z0-9-]{1,62}$/
function title(value:string){return value.replace(/^restaurant_/,'').split('_').map(part=>part.charAt(0).toUpperCase()+part.slice(1)).join(' ')}

export default function RestaurantDataExport(){
 const [slug,setSlug]=useState('')
 const [tables,setTables]=useState<string[]>([])
 const [selected,setSelected]=useState('')
 const [loading,setLoading]=useState(false)
 const [downloading,setDownloading]=useState(false)
 const [backingUp,setBackingUp]=useState(false)
 const [backupFile,setBackupFile]=useState<File|null>(null)
 const [validating,setValidating]=useState(false)
 const [checkingRestore,setCheckingRestore]=useState(false)
 const [restoring,setRestoring]=useState(false)
 const [restoreConfirmation,setRestoreConfirmation]=useState('')
 const [restoreCheck,setRestoreCheck]=useState<{restore_allowed:boolean;blocked_tables:string[];row_count:number;backup_bytes:number;restore_row_limit:number;private_fields_to_regenerate:string[];private_fields_not_restored:string[]}|null>(null)
 const [validation,setValidation]=useState<{table_count:number;row_count:number;backup_bytes:number}|null>(null)
 const [restoredQrTokens,setRestoredQrTokens]=useState<{table_id:string;qr_token:string}[]>([])
 const [error,setError]=useState('')
 const [notice,setNotice]=useState('')
 async function load(){
  const clean=slug.trim().toLowerCase()
  if(!SLUG.test(clean)){setError('Enter a valid restaurant slug.');return}
  setLoading(true);setError('');setNotice('')
  try{
   const res=await apiFetch(`${API_BASE}/restaurant/${encodeURIComponent(clean)}/data-export`,{credentials:'same-origin',cache:'no-store',headers:{Accept:'application/json'}})
   const data=await res.json().catch(()=>({}))
   if(!res.ok)throw new Error(data.error||'Could not load export tables')
   const names=((data.tables||[]) as ({name?:string}|string)[]).map(item=>typeof item==='string'?item:String(item.name||'')).filter(Boolean)
   setTables(names);setSelected(names[0]||'')
   setNotice(`${names.length} tenant data tables are available for export.`)
  }catch(e){setTables([]);setSelected('');setError(e instanceof Error?e.message:'Could not load export tables')}
  finally{setLoading(false)}
 }
 async function downloadBackup(){
  const clean=slug.trim().toLowerCase()
  if(!SLUG.test(clean)){setError('Enter a valid restaurant slug.');return}
  setBackingUp(true);setError('');setNotice('')
  try{
   const res=await apiFetch(API_BASE+'/restaurant/'+encodeURIComponent(clean)+'/data-export/backup',{credentials:'same-origin',cache:'no-store',headers:{Accept:'application/json'}})
   if(!res.ok){const data=await res.json().catch(()=>({}));throw new Error(data.error||'Could not create backup')}
   const blob=await res.blob();const url=URL.createObjectURL(blob);const link=document.createElement('a')
   link.href=url;link.download='restaurant-backup-'+clean+'.json';document.body.appendChild(link);link.click();link.remove();URL.revokeObjectURL(url)
   setNotice('Complete restaurant data backup downloaded. Store it securely.')
  }catch(e){setError(e instanceof Error?e.message:'Could not create backup')}
  finally{setBackingUp(false)}
 }
 async function validateBackup(){
  const clean=slug.trim().toLowerCase()
  if(!SLUG.test(clean)){setError('Enter a valid restaurant slug.');return}
  if(!backupFile){setError('Choose a restaurant backup JSON file first.');return}
  if(backupFile.size>5*1024*1024){setError('Backup file exceeds the 5 MiB validation limit.');return}
  setValidating(true);setError('');setNotice('');setValidation(null)
  try{
   const contents=await backupFile.text()
   const res=await apiFetch(API_BASE+'/restaurant/'+encodeURIComponent(clean)+'/data-export/validate-backup',{method:'POST',credentials:'same-origin',cache:'no-store',headers:{'Content-Type':'application/json','Accept':'application/json'},body:contents})
   const data=await res.json().catch(()=>({}))
   if(!res.ok)throw new Error(data.error||'Backup validation failed')
   setValidation(data);setNotice('Backup passed structural and tenant-safety validation. No database records were changed.')
  }catch(e){setError(e instanceof Error?e.message:'Backup validation failed')}
  finally{setValidating(false)}
 }
 async function checkRestoreReadiness(){
  const clean=slug.trim().toLowerCase()
  if(!SLUG.test(clean)){setError('Enter a valid restaurant slug.');return}
  if(!backupFile){setError('Choose a restaurant backup JSON file first.');return}
  if(backupFile.size>50*1024*1024){setError('Backup file exceeds the 5 MiB preflight limit.');return}
  setCheckingRestore(true);setError('');setNotice('');setRestoreCheck(null)
  try{
   const contents=await backupFile.text()
   const res=await apiFetch(API_BASE+'/restaurant/'+encodeURIComponent(clean)+'/data-export/restore-preflight',{method:'POST',credentials:'same-origin',cache:'no-store',headers:{'Content-Type':'application/json','Accept':'application/json'},body:contents})
   const data=await res.json().catch(()=>({}))
   if(!res.ok)throw new Error(data.error||'Restore readiness check failed')
   setRestoreCheck(data);setNotice(data.message||'Restore readiness checked. No records were changed.')
  }catch(e){setError(e instanceof Error?e.message:'Restore readiness check failed')}
  finally{setCheckingRestore(false)}
 }
 async function restoreBackup(){
  const clean=slug.trim().toLowerCase()
  if(!SLUG.test(clean)){setError('Enter a valid restaurant slug.');return}
  if(!backupFile){setError('Choose a restaurant backup JSON file first.');return}
  if(!restoreCheck?.restore_allowed){setError('Run restore readiness and confirm the target is empty first.');return}
  if(restoreConfirmation.trim()!=='RESTORE '+clean){setError('Type RESTORE followed by the exact restaurant slug to confirm.');return}
  setRestoring(true);setError('');setNotice('')
  try{
   const parsed=JSON.parse(await backupFile.text())
   const res=await apiFetch(API_BASE+'/restaurant/'+encodeURIComponent(clean)+'/data-export/restore',{method:'POST',credentials:'same-origin',cache:'no-store',headers:{'Content-Type':'application/json','Accept':'application/json'},body:JSON.stringify({...parsed,confirmation:restoreConfirmation.trim()})})
   const data=await res.json().catch(()=>({}))
   if(!res.ok)throw new Error(data.error||'Restaurant restore failed')
   setNotice('Restore completed: '+data.row_count+' records. New QR tokens are shown below; save them securely. Staff passwords must be reset and menu photos re-uploaded.')
   setRestoredQrTokens(Array.isArray(data.regenerated_qr_tokens)?data.regenerated_qr_tokens:[])
   setRestoreCheck(null);setRestoreConfirmation('')
  }catch(e){setError(e instanceof Error?e.message:'Restaurant restore failed')}
  finally{setRestoring(false)}
 }
 async function download(){
  if(!selected||!tables.includes(selected)){setError('Choose a table to export.');return}
  setDownloading(true);setError('');setNotice('')
  try{
   const res=await apiFetch(`${API_BASE}/restaurant/${encodeURIComponent(slug.trim().toLowerCase())}/data-export/${encodeURIComponent(selected)}`,{credentials:'same-origin',cache:'no-store',headers:{Accept:'text/csv'}})
   if(!res.ok){const data=await res.json().catch(()=>({}));throw new Error(data.error||'Could not export this table')}
   const blob=await res.blob();const url=URL.createObjectURL(blob);const link=document.createElement('a')
   link.href=url;link.download=`${selected}.csv`;document.body.appendChild(link);link.click();link.remove();URL.revokeObjectURL(url)
   setNotice(`${selected}.csv export prepared.`)
  }catch(e){setError(e instanceof Error?e.message:'Could not export this table')}
  finally{setDownloading(false)}
 }
 return <section className="restaurant-menu">
  <div className="restaurant-menu-heading"><div className="restaurant-menu-title"><div className="restaurant-menu-icon"><Database size={20}/></div><div><span className="eyebrow">RESTAURANT SUITE</span><h2>Data export</h2><p>Download tenant-owned restaurant records as individual CSV files.</p></div></div></div>
  <div className="restaurant-report-filters">
   <label>Restaurant slug<input value={slug} onChange={e=>setSlug(e.target.value)} placeholder="e.g. my-restaurant" autoCapitalize="none"/></label>
   <div className="restaurant-export-actions"><button className="button primary" onClick={()=>void load()} disabled={loading}><RefreshCw size={15}/>{loading?'Loading…':'Load data tables'}</button><button className="button secondary" onClick={()=>void downloadBackup()} disabled={backingUp}><Database size={15}/>{backingUp?'Preparing backup…':'Download full backup'}</button></div>
  </div>
  {error&&<div className="restaurant-menu-alert"><AlertCircle size={16}/>{error}</div>}
  {notice&&<div className="restaurant-settings-success">{notice}</div>}
  {tables.length>0&&<div className="restaurant-report-panel restaurant-report-wide">
   <h3><Table2 size={17}/> Available data tables</h3>
   <p className="restaurant-settings-note">Select one table and download its CSV. Repeat for each table you need.</p>
   <label className="restaurant-data-select">Table<select value={selected} onChange={e=>setSelected(e.target.value)}>{tables.map(table=><option key={table} value={table}>{title(table)}</option>)}</select></label>
   <button className="button primary" onClick={()=>void download()} disabled={downloading||!selected}><Download size={16}/>{downloading?'Preparing CSV…':'Download selected CSV'}</button>
   <div className="restaurant-data-table-list">{tables.map(table=><span key={table}>{title(table)}</span>)}</div>
  </div>}
  <div className="restaurant-report-panel restaurant-report-wide">
   <h3><ShieldCheck size={17}/> Validate an existing backup</h3>
   <p className="restaurant-settings-note">Choose a previously downloaded JSON backup. Validation checks its format, table names, columns, row tenant IDs and manifest counts. It does not restore or modify records.</p>
   <label>Backup JSON file<input type="file" accept="application/json,.json" onChange={e=>{setBackupFile(e.target.files?.[0]||null);setValidation(null);setRestoreCheck(null);setRestoreConfirmation('');setRestoredQrTokens([]);setError("");setNotice("")}}/></label>
   <button className="button secondary" onClick={()=>void validateBackup()} disabled={validating||!backupFile}>{validating?"Validating backup…":"Validate backup file"}</button>
   <button className="button secondary" onClick={()=>void checkRestoreReadiness()} disabled={checkingRestore||!backupFile}>{checkingRestore?"Checking target…":"Check restore readiness"}</button>
   {restoreCheck&&<div className={restoreCheck.restore_allowed?"restaurant-settings-success":"restaurant-menu-alert"}><strong>{restoreCheck.restore_allowed?"Target is empty and within restore limits":"Restore blocked"}</strong><p>{restoreCheck.row_count} backup records · {restoreCheck.backup_bytes} bytes · maximum {restoreCheck.restore_row_limit} rows per restore</p>{restoreCheck.blocked_tables.length>0&&<p>Tables containing existing data: {restoreCheck.blocked_tables.map(title).join(", ")}</p>}
    {restoreCheck.restore_allowed&&<><p><strong>Important:</strong> Restore is limited to the same tenant ID and an empty tenant. It regenerates table QR tokens and order idempotency keys. Staff password hashes and menu photo object keys are not restored; staff passwords must be reset and photos re-uploaded.</p>
     <label>Type <strong>RESTORE {slug.trim().toLowerCase()}</strong> to confirm<input value={restoreConfirmation} onChange={e=>setRestoreConfirmation(e.target.value)} placeholder={"RESTORE "+slug.trim().toLowerCase()} autoCapitalize="characters"/></label>
     <button className="button primary" onClick={()=>void restoreBackup()} disabled={restoring||restoreConfirmation.trim()!=="RESTORE "+slug.trim().toLowerCase()}>{restoring?"Restoring…":"Restore backup into empty restaurant"}</button></>}
   </div>}
   {validation&&<div className="restaurant-settings-success"><strong>Backup valid</strong><p>{validation.table_count} tables · {validation.row_count} records · {validation.backup_bytes} bytes</p></div>}
   {restoredQrTokens.length>0&&<div className="restaurant-report-panel restaurant-report-wide"><h3>New table QR tokens</h3><p className="restaurant-settings-note">These tokens are shown only in this restore response. Save them securely and regenerate QR printouts for the restored tables.</p>{restoredQrTokens.map(item=><div key={item.table_id}><small>{item.table_id}</small><p><code>{item.qr_token}</code></p></div>)}</div>}
  </div>
  <div className="restaurant-report-panel restaurant-report-wide">
   <h3><ShieldCheck size={17}/> Export protection</h3>
   <ul><li>Only the restaurant owner can export.</li><li>Every row is filtered to the selected restaurant tenant.</li><li>Password hashes, QR-token hashes, storage object keys and idempotency keys are excluded.</li><li>Exports are read-only and do not change live records.</li></ul>
   <p className="restaurant-settings-note">Full backup downloads a versioned JSON snapshot of tenant-owned restaurant tables. Credentials, token/secret fields and private storage keys are excluded. Restore is owner-only, limited to 500 rows, requires an empty same-tenant target and typed confirmation, and runs as one atomic D1 batch. Automatic backup scheduling remains unimplemented; store backup files securely.</p>
  </div>
 </section>
}
