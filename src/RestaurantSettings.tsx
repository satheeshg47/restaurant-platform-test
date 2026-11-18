import { apiFetch } from './auth'
import { useCallback, useEffect, useState } from 'react'
import { AlertCircle, Check, LoaderCircle, RefreshCw, Save, Settings } from 'lucide-react'

const API_BASE = (import.meta.env.VITE_API_BASE_URL || '/api').replace(/\/$/, '')
type SettingsData = { display_name:string; currency_code:string; timezone:string; default_language:'en'|'hi'|'kn'; tax_mode:'none'|'single'|'gst'; tax_rate:number|string; gst_rate:number|string; tax_inclusive:boolean; accepting_orders:boolean; legal_name:string|null; gstin:string|null; address_line1:string|null; address_line2:string|null; city:string|null; state_name:string|null; state_code:string|null; postal_code:string|null; invoice_prefix:string }
const empty:SettingsData = {display_name:'',currency_code:'INR',timezone:'Asia/Kolkata',default_language:'en',tax_mode:'none',tax_rate:0,gst_rate:5,tax_inclusive:false,accepting_orders:true,legal_name:'',gstin:'',address_line1:'',address_line2:'',city:'',state_name:'',state_code:'',postal_code:'',invoice_prefix:'INV'}
export default function RestaurantSettings({initialSlug=''}:{initialSlug?:string}={}){
 const [slug,setSlug]=useState(initialSlug)
 const [settings,setSettings]=useState<SettingsData>(empty)
 const [loaded,setLoaded]=useState(false)
 const [busy,setBusy]=useState(false)
 const [error,setError]=useState('')
 const [notice,setNotice]=useState('')
 const request=useCallback(async(path:string,init?:RequestInit)=>{
  const response=await apiFetch(`${API_BASE}/restaurant/${encodeURIComponent(slug.trim().toLowerCase())}${path}`,{...init,credentials:'same-origin',headers:{Accept:'application/json',...(init?.body?{'Content-Type':'application/json'}:{}),...init?.headers},cache:'no-store'})
  const payload=await response.json().catch(()=>({}))
  if(!response.ok) throw new Error(payload.error || (response.status===401?'Sign in required':response.status===403?'Owner or manager access required':'Settings request failed'))
  return payload
 },[slug])
 async function load(){
  if(!/^[a-z0-9][a-z0-9-]{1,62}$/.test(slug.trim().toLowerCase())){setError('Enter a valid restaurant slug.');return}
  setBusy(true);setError('');setNotice('')
  try{const result=await request('/settings');setSettings({...empty,...result.settings});setLoaded(true)}
  catch(e){setLoaded(false);setError(e instanceof Error?e.message:'Could not load settings')}
  finally{setBusy(false)}
 }
 useEffect(()=>{setLoaded(false);setSettings(empty)},[slug])
 useEffect(()=>{if(initialSlug) void load()},[initialSlug])
 async function save(){
  const tax=Number(settings.tax_rate),gst=Number(settings.gst_rate)
  if(!settings.display_name.trim()||settings.display_name.trim().length>160||!Number.isFinite(tax)||tax<0||tax>100||!Number.isFinite(gst)||gst<0||gst>100){setError('Check the restaurant name and tax rates (0–100%).');return}
  setBusy(true);setError('');setNotice('')
  try{const result=await request('/settings',{method:'PATCH',body:JSON.stringify({...settings,tax_rate:tax,gst_rate:gst})});setSettings({...empty,...result.settings});setNotice('Restaurant settings saved.')}
  catch(e){setError(e instanceof Error?e.message:'Could not save settings')}
  finally{setBusy(false)}
 }
 return <section className="restaurant-menu">
  <div className="restaurant-menu-heading"><div className="restaurant-menu-title"><div className="restaurant-menu-icon"><Settings size={20}/></div><div><span className="eyebrow">RESTAURANT SUITE</span><h2>Restaurant settings</h2><p>Business identity, order availability, language and tax calculation defaults.</p></div></div></div>
  {!initialSlug && <div className="restaurant-settings-lookup"><label>Restaurant slug<input value={slug} onChange={e=>setSlug(e.target.value)} placeholder="e.g. my-restaurant" autoCapitalize="none"/></label><button className="button secondary" onClick={()=>void load()} disabled={busy}><RefreshCw size={15}/>Load settings</button></div>}
  {error&&<div className="restaurant-menu-alert"><AlertCircle size={16}/>{error}</div>}
  {notice&&<div className="restaurant-settings-success"><Check size={16}/>{notice}</div>}
  {!loaded?<div className="restaurant-menu-empty">{busy?<><LoaderCircle size={18}/> Loading restaurant settings…</>:'Enter the restaurant slug and load its saved settings.'}</div>:<>
   <div className="restaurant-settings-grid">
    <label>Restaurant display name<input maxLength={160} value={settings.display_name} onChange={e=>setSettings({...settings,display_name:e.target.value})}/></label>
    <label>Currency<select value={settings.currency_code} onChange={e=>setSettings({...settings,currency_code:e.target.value})}><option value="INR">INR — Indian Rupee (₹)</option></select></label>
    <label>Time zone<select value={settings.timezone} onChange={e=>setSettings({...settings,timezone:e.target.value})}><option value="Asia/Kolkata">India — Asia/Kolkata</option></select></label>
    <label>Default menu language<select value={settings.default_language} onChange={e=>setSettings({...settings,default_language:e.target.value as SettingsData['default_language']})}><option value="en">English</option><option value="hi">Hindi</option><option value="kn">Kannada</option></select></label>
   </div>
   <div className="restaurant-settings-section"><h3>Order availability</h3><label className="restaurant-settings-toggle"><input type="checkbox" checked={settings.accepting_orders} onChange={e=>setSettings({...settings,accepting_orders:e.target.checked})}/><span><b>Accept new orders</b><small>Turn this off to temporarily pause QR ordering.</small></span></label></div>
   <div className="restaurant-settings-section"><h3>Tax calculation</h3><label>Tax mode<select value={settings.tax_mode} onChange={e=>setSettings({...settings,tax_mode:e.target.value as SettingsData['tax_mode']})}><option value="none">No tax</option><option value="single">Single tax rate</option><option value="gst">GST rate</option></select></label>
    {settings.tax_mode==='single'&&<label>Tax rate (%)<input type="number" min="0" max="100" step="0.01" value={settings.tax_rate} onChange={e=>setSettings({...settings,tax_rate:e.target.value})}/></label>}
    {settings.tax_mode==='gst'&&<label>GST rate (%)<input type="number" min="0" max="100" step="0.01" value={settings.gst_rate} onChange={e=>setSettings({...settings,gst_rate:e.target.value})}/></label>}
    {settings.tax_mode!=='none'&&<label className="restaurant-settings-toggle"><input type="checkbox" checked={settings.tax_inclusive} onChange={e=>setSettings({...settings,tax_inclusive:e.target.checked})}/><span><b>Prices include tax</b><small>When enabled, tax is calculated within the menu price.</small></span></label>}
    <p className="restaurant-settings-note">These settings configure the existing order tax calculation. GST invoice numbering and registered-business invoice details are separate work and are not included yet.</p>
   </div>
   <div className="restaurant-settings-section"><h3>GST invoice business details</h3><p className="restaurant-settings-note">Required before issuing a GST invoice. Enter the registered legal details exactly as shown on the GST registration certificate.</p>
    <div className="restaurant-settings-grid">
     <label>Legal / registered business name<input maxLength={160} value={settings.legal_name||''} onChange={e=>setSettings({...settings,legal_name:e.target.value})}/></label>
     <label>GSTIN<input maxLength={15} autoCapitalize="characters" value={settings.gstin||''} onChange={e=>setSettings({...settings,gstin:e.target.value.toUpperCase()})} placeholder="15-character GSTIN"/></label>
     <label>Address line 1<input maxLength={200} value={settings.address_line1||''} onChange={e=>setSettings({...settings,address_line1:e.target.value})}/></label>
     <label>Address line 2<input maxLength={200} value={settings.address_line2||''} onChange={e=>setSettings({...settings,address_line2:e.target.value})}/></label>
     <label>City / town<input maxLength={100} value={settings.city||''} onChange={e=>setSettings({...settings,city:e.target.value})}/></label>
     <label>State name<input maxLength={100} value={settings.state_name||''} onChange={e=>setSettings({...settings,state_name:e.target.value})}/></label>
     <label>GST state code (2 digits)<input inputMode="numeric" maxLength={2} value={settings.state_code||''} onChange={e=>setSettings({...settings,state_code:e.target.value.replace(/[^0-9]/g,'')})} placeholder="e.g. 29"/></label>
     <label>PIN code<input inputMode="numeric" maxLength={10} value={settings.postal_code||''} onChange={e=>setSettings({...settings,postal_code:e.target.value})}/></label>
     <label>Invoice prefix (1–3 characters)<input maxLength={3} value={settings.invoice_prefix||'INV'} onChange={e=>setSettings({...settings,invoice_prefix:e.target.value.toUpperCase()})}/></label>
    </div>
   </div>
   <div className="restaurant-settings-actions"><button className="button primary" onClick={()=>void save()} disabled={busy}><Save size={16}/>{busy?'Saving…':'Save settings'}</button></div>
  </>}
 </section>
}
