import { apiFetch } from './auth'
import { useCallback,useEffect,useState } from 'react'
import { Activity,AlertCircle,CheckCircle2,Clock,RefreshCw,Server,ShieldAlert } from 'lucide-react'
const API_BASE=(import.meta.env.VITE_API_BASE_URL||'/api').replace(/\/$/,'')
type Counts=Record<string,number|string|null>
type Event={id:string;actor_subject:string;action:string;resource_type:string;resource_id:string|null;metadata:string;created_at:string}
type Deployment={id:string;application_name:string;version:string;environment:string;status:string;started_at:string|null;finished_at:string|null;created_at:string;health_report:string}
type Data={generated_at:string;counts:Counts;recent_events:Event[];recent_deployments:Deployment[];usage_metrics:{available:boolean;note:string}}
const number=(value:unknown)=>new Intl.NumberFormat('en-IN').format(Number(value||0))
const when=(value:string|null)=>value?new Date(value).toLocaleString('en-IN',{dateStyle:'medium',timeStyle:'short'}):'—'
export default function Monitoring(){
 const [data,setData]=useState<Data|null>(null)
 const [loading,setLoading]=useState(true)
 const [error,setError]=useState('')
 const load=useCallback(async()=>{
  setLoading(true);setError('')
  try{
   const response=await apiFetch(API_BASE+'/admin/monitoring',{cache:'no-store',headers:{Accept:'application/json'}})
   const payload=await response.json().catch(()=>({}))
   if(!response.ok)throw new Error(payload.error||'monitoring_unavailable')
   setData(payload)
  }catch(e){setError(e instanceof Error?e.message:'Could not load monitoring data')}
  finally{setLoading(false)}
 },[])
 useEffect(()=>{void load()},[load])
 const c=data?.counts||{}
 const cards=[
  {label:'Active applications',value:c.active_applications,icon:Server},
  {label:'Active restaurants',value:c.active_tenants,icon:Activity},
  {label:'Active subscriptions',value:c.active_subscriptions,icon:CheckCircle2},
  {label:'Active trials',value:c.active_trials,icon:Clock},
  {label:'Trials expiring in 7 days',value:c.trials_expiring_7d,icon:Clock},
  {label:'Payments awaiting review',value:c.payments_awaiting_review,icon:AlertCircle},
  {label:'Pending owner invitations',value:c.pending_owner_invitations,icon:Activity},
  {label:'Failed deployments',value:c.failed_deployments,icon:ShieldAlert},
 ]
 return <section className="panel monitoring-dashboard" aria-live="polite">
  <div className="panel-heading"><div><h2>Platform monitoring</h2><p>Application, tenant, subscription, invitation and deployment health.</p>{data&&<small>Updated {when(data.generated_at)}</small>}</div><button className="button secondary small" onClick={()=>void load()} disabled={loading}><RefreshCw size={14}/>{loading?'Refreshing…':'Refresh'}</button></div>
  {error&&<div className="restaurant-menu-alert"><AlertCircle size={16}/>{error}</div>}
  {data&&<>
   <div className="monitoring-card-grid">{cards.map(card=>{const Icon=card.icon;return <article className="monitoring-card" key={card.label}><div><span>{card.label}</span><Icon size={17}/></div><strong>{number(card.value)}</strong></article>})}</div>
   <div className="monitoring-section-grid">
    <section className="panel"><div className="panel-heading"><div><h3>Recent deployments</h3><p>Release and environment health.</p></div></div>
     {data.recent_deployments.length===0?<p className="monitoring-empty">No deployment records yet.</p>:<div className="monitoring-event-list">{data.recent_deployments.map(item=><div className="monitoring-event" key={item.id}><div><b>{item.application_name} · {item.version}</b><small>{item.environment} · {when(item.created_at)}</small></div><span className={`status ${item.status}`}>{item.status}</span></div>)}</div>}
    </section>
    <section className="panel"><div className="panel-heading"><div><h3>Recent platform activity</h3><p>Latest audited administrative actions.</p></div></div>
     {data.recent_events.length===0?<p className="monitoring-empty">No audit events yet.</p>:<div className="monitoring-event-list">{data.recent_events.map(item=><div className="monitoring-event" key={item.id}><div><b>{item.action}</b><small>{item.resource_type}{item.resource_id?' · '+item.resource_id:''} · {when(item.created_at)}</small></div><span className="monitoring-actor">{item.actor_subject}</span></div>)}</div>}
    </section>
   </div>
   <div className="monitoring-notice"><AlertCircle size={15}/><div><b>Cloudflare usage is not included here.</b><p>{data.usage_metrics.note}</p></div></div>
  </>}
 </section>
}
