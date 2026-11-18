import { apiFetch } from './auth'
import { useCallback,useEffect,useState } from 'react'
import { AlertCircle,CheckCircle2,Clock,CreditCard,Plus,RefreshCw,ShieldCheck,XCircle } from 'lucide-react'

const API_BASE=(import.meta.env.VITE_API_BASE_URL||'/api').replace(/\/$/,'')
type Application={id:string;name:string;status:string}
type Tenant={tenant_id:string;tenant_name:string;tenant_slug:string;tenant_status:string}
type Plan={id:string;application_id:string;application_name:string;plan_code:string;display_name:string;billing_interval:string;amount_minor:number;currency:string;trial_days:number;is_active:number}
type Subscription={id:string;tenant_id:string;tenant_name:string;tenant_slug:string;application_id:string;application_name:string;plan_id:string|null;plan_code:string;plan_name:string|null;billing_interval:string;status:string;effective_status:string;currency:string;amount_minor:number;payment_mode:string;starts_at:string|null;ends_at:string|null}
type Payment={id:string;subscription_id:string;amount_minor:number;currency:string;payment_method:string;status:string;provider:string|null;provider_reference:string|null;created_at:string;confirmed_at:string|null}
const money=(minor:number,currency='INR')=>new Intl.NumberFormat('en-IN',{style:'currency',currency,maximumFractionDigits:2}).format(minor/100)
const date=(value:string|null)=>value?new Date(value).toLocaleDateString('en-IN',{dateStyle:'medium'}):'—'
export default function Subscriptions(){
 const [applications,setApplications]=useState<Application[]>([])
 const [tenants,setTenants]=useState<Tenant[]>([])
 const [plans,setPlans]=useState<Plan[]>([])
 const [subscriptions,setSubscriptions]=useState<Subscription[]>([])
 const [payments,setPayments]=useState<Record<string,Payment[]>>({})
 const [expanded,setExpanded]=useState('')
 const [loading,setLoading]=useState(true)
 const [busy,setBusy]=useState('')
 const [error,setError]=useState('')
 const [notice,setNotice]=useState('')
 const [appId,setAppId]=useState('')
 const [planCode,setPlanCode]=useState('starter-monthly')
 const [planName,setPlanName]=useState('Starter')
 const [interval,setInterval]=useState('monthly')
 const [amount,setAmount]=useState('499')
 const [trialDays,setTrialDays]=useState('7')
 const [tenantId,setTenantId]=useState('')
 const [planId,setPlanId]=useState('')
 const [paymentFor,setPaymentFor]=useState<Subscription|null>(null)
 const [paymentAmount,setPaymentAmount]=useState('')
 const [paymentMethod,setPaymentMethod]=useState('upi')
 const [paymentReference,setPaymentReference]=useState('')

 const request=useCallback(async(path:string,init?:RequestInit)=>{
  const response=await apiFetch(API_BASE+path,{...init,cache:'no-store',headers:{Accept:'application/json',...(init?.body?{'Content-Type':'application/json'}:{}),...init?.headers}})
  const payload=await response.json().catch(()=>({}))
  if(!response.ok)throw new Error(payload.error||'request_failed')
  return payload
 },[])
 const refresh=useCallback(async()=>{
  setLoading(true);setError('')
  try{
   const [apps,owners,planData,subData]=await Promise.all([
    request('/admin/applications'),request('/admin/owners'),request('/admin/subscription-plans'),request('/admin/subscriptions'),
   ])
   setApplications((apps.applications||[]).filter((x:Application)=>x.status==='active'))
   setTenants((owners.owners||[]).filter((x:Tenant)=>x.tenant_status==='active'))
   setPlans(planData.plans||[]);setSubscriptions(subData.subscriptions||[])
   if(!appId&&apps.applications?.[0])setAppId(apps.applications[0].id)
   if(!tenantId&&owners.owners?.[0])setTenantId(owners.owners[0].tenant_id)
   if(!planId&&planData.plans?.[0])setPlanId(planData.plans[0].id)
  }catch(e){setError(e instanceof Error?e.message:'Could not load subscription data')}
  finally{setLoading(false)}
 },[request,appId,tenantId,planId])
 useEffect(()=>{void refresh()},[refresh])

 async function createPlan(){
  setBusy('plan');setError('');setNotice('')
  try{
   await request('/admin/subscription-plans',{method:'POST',body:JSON.stringify({application_id:appId,plan_code:planCode.trim().toLowerCase(),display_name:planName.trim(),billing_interval:interval,amount_minor:Math.round(Number(amount)*100),currency:'INR',trial_days:Number(trialDays)})})
   setNotice('Plan created.');await refresh()
  }catch(e){setError(e instanceof Error?e.message:'Could not create plan')}
  finally{setBusy('')}
 }
 async function createSubscription(){
  const plan=plans.find(p=>p.id===planId)
  if(!plan){setError('Choose an active plan.');return}
  setBusy('subscription');setError('');setNotice('')
  try{
   await request('/admin/subscriptions',{method:'POST',body:JSON.stringify({tenant_id:tenantId,application_id:plan.application_id,plan_id:plan.id})})
   setNotice('Subscription created.');await refresh()
  }catch(e){setError(e instanceof Error?e.message:'Could not create subscription')}
  finally{setBusy('')}
 }
 async function loadPayments(subscriptionId:string){
  setBusy(subscriptionId);setError('')
  try{
   const result=await request(`/admin/subscriptions/${subscriptionId}/payments`)
   setPayments(current=>({...current,[subscriptionId]:result.payments||[]}));setExpanded(current=>current===subscriptionId?'':subscriptionId)
  }catch(e){setError(e instanceof Error?e.message:'Could not load payments')}
  finally{setBusy('')}
 }
 async function recordPayment(){
  if(!paymentFor)return
  setBusy('payment');setError('');setNotice('')
  try{
   await request(`/admin/subscriptions/${paymentFor.id}/payments`,{method:'POST',body:JSON.stringify({amount_minor:Math.round(Number(paymentAmount)*100),payment_method:paymentMethod,provider_reference:paymentReference.trim()})})
   setNotice('Manual payment recorded as submitted. Confirm it only after checking the bank/UPI receipt.')
   setPaymentFor(null);setPaymentReference('');await refresh();await loadPayments(paymentFor.id)
  }catch(e){setError(e instanceof Error?e.message:'Could not record payment')}
  finally{setBusy('')}
 }
 async function paymentAction(payment:Payment,action:'confirm'|'reject'){
  if(action==='confirm'&&!window.confirm('Confirm that this payment has been received and verified?'))return
  if(action==='reject'&&!window.confirm('Reject this submitted payment?'))return
  setBusy(payment.id);setError('');setNotice('')
  try{
   await request(`/admin/subscription-payments/${payment.id}/${action}`,{method:'POST'})
   setNotice(action==='confirm'?'Payment confirmed; subscription activated or extended.':'Payment rejected.')
   await refresh();await loadPayments(payment.subscription_id)
  }catch(e){setError(e instanceof Error?e.message:'Could not update payment')}
  finally{setBusy('')}
 }
 async function cancelSubscription(subscription:Subscription){
  if(!window.confirm(`Cancel the subscription for ${subscription.tenant_name}?`))return
  setBusy(subscription.id);setError('');setNotice('')
  try{await request(`/admin/subscriptions/${subscription.id}`,{method:'PATCH',body:JSON.stringify({status:'cancelled'})});setNotice('Subscription cancelled.');await refresh()}
  catch(e){setError(e instanceof Error?e.message:'Could not cancel subscription')}
  finally{setBusy('')}
 }
 async function archivePlan(plan:Plan){
  if(!window.confirm(`Deactivate plan ${plan.display_name}? Existing subscriptions are not changed.`))return
  setBusy(plan.id);setError('')
  try{await request(`/admin/subscription-plans/${plan.id}`,{method:'PATCH',body:JSON.stringify({is_active:false})});setNotice('Plan deactivated.');await refresh()}
  catch(e){setError(e instanceof Error?e.message:'Could not deactivate plan')}
  finally{setBusy('')}
 }
 return <section className="panel live-applications" aria-live="polite">
  <div className="panel-heading"><div><h2>Subscriptions & billing</h2><p>Manual INR billing, trial periods and payment confirmation. No payment gateway or card storage is connected.</p></div><button className="button secondary small" onClick={()=>void refresh()} disabled={loading}><RefreshCw size={14}/>{loading?'Loading…':'Refresh'}</button></div>
  {error&&<div className="restaurant-menu-alert"><AlertCircle size={16}/>{error}</div>}
  {notice&&<div className="restaurant-settings-success">{notice}</div>}
  <div className="subscription-admin-grid">
   <section className="panel"><div className="panel-heading"><div><h3>Create plan</h3><p>Set INR pricing and trial length for an application.</p></div></div>
    <div className="subscription-form">
     <label>Application<select value={appId} onChange={e=>setAppId(e.target.value)}><option value="">Select application</option>{applications.map(app=><option key={app.id} value={app.id}>{app.name}</option>)}</select></label>
     <label>Plan code<input value={planCode} onChange={e=>setPlanCode(e.target.value)} placeholder="starter-monthly"/></label>
     <label>Display name<input value={planName} onChange={e=>setPlanName(e.target.value)} placeholder="Starter"/></label>
     <label>Billing interval<select value={interval} onChange={e=>setInterval(e.target.value)}><option value="monthly">Monthly</option><option value="quarterly">Quarterly</option><option value="yearly">Yearly</option></select></label>
     <label>Price (INR)<input type="number" min="0" step="0.01" value={amount} onChange={e=>setAmount(e.target.value)}/></label>
     <label>Trial days<input type="number" min="0" max="365" value={trialDays} onChange={e=>setTrialDays(e.target.value)}/></label>
     <button className="button primary" onClick={()=>void createPlan()} disabled={busy==='plan'||!appId||!planCode.trim()||!planName.trim()}><Plus size={15}/>{busy==='plan'?'Creating…':'Create plan'}</button>
    </div>
   </section>
   <section className="panel"><div className="panel-heading"><div><h3>Assign a plan</h3><p>Create a trial, paid-pending or free subscription.</p></div></div>
    <div className="subscription-form">
     <label>Restaurant<select value={tenantId} onChange={e=>setTenantId(e.target.value)}><option value="">Select restaurant</option>{tenants.map(t=><option key={t.tenant_id} value={t.tenant_id}>{t.tenant_name} · {t.tenant_slug}</option>)}</select></label>
     <label>Active plan<select value={planId} onChange={e=>setPlanId(e.target.value)}><option value="">Select plan</option>{plans.filter(p=>p.is_active).map(p=><option key={p.id} value={p.id}>{p.display_name} · {money(p.amount_minor)}</option>)}</select></label>
     <button className="button primary" onClick={()=>void createSubscription()} disabled={busy==='subscription'||!tenantId||!planId}><Plus size={15}/>{busy==='subscription'?'Assigning…':'Assign subscription'}</button>
    </div>
   </section>
  </div>
  <div className="panel-heading subscription-section-heading"><div><h3>Plans</h3><p>{plans.length} plans configured</p></div></div>
  <div className="subscription-plan-list">{plans.map(plan=><div className="subscription-plan-row" key={plan.id}><div><b>{plan.display_name}</b><small>{plan.application_name} · {plan.plan_code} · {plan.billing_interval} · {plan.trial_days} trial days</small></div><strong>{money(plan.amount_minor,plan.currency)}</strong><span className={plan.is_active?'status active':'status archived'}>{plan.is_active?'Active':'Inactive'}</span>{plan.is_active&&<button className="button secondary small" onClick={()=>void archivePlan(plan)} disabled={busy===plan.id}>Deactivate</button>}</div>)}</div>
  <div className="panel-heading subscription-section-heading"><div><h3>Restaurant subscriptions</h3><p>{subscriptions.length} records · trial expiry is shown from the stored end date.</p></div></div>
  {subscriptions.length===0?<div className="registry-empty"><div className="empty-icon"><CreditCard size={21}/></div><b>No subscriptions yet</b><p>Create a plan and assign it to an active restaurant.</p></div>:<div className="subscription-list">{subscriptions.map(sub=><article className="subscription-row" key={sub.id}>
   <div className="subscription-main"><div><b>{sub.tenant_name}</b><small>{sub.application_name} · {sub.plan_name||sub.plan_code}</small></div><strong>{money(sub.amount_minor,sub.currency)}</strong><span className={`status ${sub.effective_status}`}>{sub.effective_status}</span></div>
   <div className="subscription-meta"><span>{sub.billing_interval} · {sub.payment_mode}</span><span>Starts {date(sub.starts_at)}</span><span>Ends {date(sub.ends_at)}</span></div>
   <div className="subscription-actions"><button className="button secondary small" onClick={()=>void loadPayments(sub.id)} disabled={busy===sub.id}><CreditCard size={14}/>Payments</button>{sub.amount_minor>0&&sub.status!=='cancelled'&&<button className="button secondary small" onClick={()=>{setPaymentFor(sub);setPaymentAmount((sub.amount_minor/100).toFixed(2))}}>Record payment</button>}{sub.status!=='cancelled'&&<button className="button secondary small" onClick={()=>void cancelSubscription(sub)} disabled={busy===sub.id}><XCircle size={14}/>Cancel</button>}</div>
   {expanded===sub.id&&<div className="subscription-payments">{(payments[sub.id]||[]).length===0?<p>No payment records.</p>:(payments[sub.id]||[]).map(payment=><div className="subscription-payment-row" key={payment.id}><div><b>{money(payment.amount_minor,payment.currency)}</b><small>{payment.payment_method} · {payment.provider_reference||'No reference'} · {date(payment.created_at)}</small></div><span className={`status ${payment.status}`}>{payment.status}</span>{payment.status==='submitted'&&<div><button className="button primary small" onClick={()=>void paymentAction(payment,'confirm')} disabled={busy===payment.id}><CheckCircle2 size={13}/>Confirm</button><button className="button secondary small" onClick={()=>void paymentAction(payment,'reject')} disabled={busy===payment.id}><XCircle size={13}/>Reject</button></div>}</div>)}</div>}
  </article>)}</div>}
  <div className="registry-footnote"><ShieldCheck size={14}/> Manual payment records only. Verify bank/UPI receipts before confirming; never enter card numbers or security codes.</div>
  {paymentFor&&<div className="modal-backdrop" role="presentation" onClick={()=>setPaymentFor(null)}><section className="modal-card" role="dialog" aria-modal="true" aria-labelledby="subscription-payment-title" onClick={e=>e.stopPropagation()}><div className="modal-heading"><div><h3 id="subscription-payment-title">Record manual payment</h3><p>{paymentFor.tenant_name} · {paymentFor.plan_name||paymentFor.plan_code}</p></div><button className="icon-button" onClick={()=>setPaymentFor(null)} aria-label="Close"><XCircle size={18}/></button></div><div className="subscription-form"><label>Amount (INR)<input type="number" min="0.01" step="0.01" value={paymentAmount} onChange={e=>setPaymentAmount(e.target.value)}/></label><label>Payment method<select value={paymentMethod} onChange={e=>setPaymentMethod(e.target.value)}><option value="upi">UPI</option><option value="bank_transfer">Bank transfer</option><option value="cash">Cash</option><option value="other">Other</option></select></label><label>Reference (optional)<input value={paymentReference} onChange={e=>setPaymentReference(e.target.value)} placeholder="UPI transaction reference"/></label><button className="button primary" onClick={()=>void recordPayment()} disabled={busy==='payment'||!paymentAmount||Number(paymentAmount)<=0}>{busy==='payment'?'Saving…':'Submit payment for verification'}</button></div></section></div>}
 </section>
}
