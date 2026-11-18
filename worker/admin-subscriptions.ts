import type { Env, Identity } from './types.ts'
const ID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const PLAN_CODE=/^[a-z0-9][a-z0-9-]{1,39}$/
const json=(status:number,body:unknown)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}})
function fail(status:number,code:string):never{throw Object.assign(new Error(code),{status})}
async function body(request:Request){
 const raw=await request.text()
 if(new TextEncoder().encode(raw).byteLength>8192)fail(413,'payload_too_large')
 try{const value:unknown=JSON.parse(raw);if(!value||typeof value!=='object'||Array.isArray(value))fail(400,'invalid_json');return value as Record<string,unknown>}catch(error){if(error&&typeof error==='object'&&'status'in error)throw error;fail(400,'invalid_json')}
}
function audit(env:Env,admin:Identity,action:string,type:string,id:string,metadata:unknown){
 return env.DB.prepare('INSERT INTO platform_audit_events(actor_issuer,actor_subject,action,resource_type,resource_id,metadata) VALUES(?,?,?,?,?,?)')
  .bind(admin.issuer,admin.subject,action,type,id,JSON.stringify(metadata))
}
function addInterval(base:string,interval:string){
 const date=new Date(base),day=date.getUTCDate(),months=interval==='monthly'?1:interval==='quarterly'?3:12
 date.setUTCDate(1);date.setUTCMonth(date.getUTCMonth()+months)
 const last=new Date(Date.UTC(date.getUTCFullYear(),date.getUTCMonth()+1,0)).getUTCDate()
 date.setUTCDate(Math.min(day,last))
 return date.toISOString()
}
function validMinor(value:unknown){return Number.isSafeInteger(value)&&Number(value)>=0&&Number(value)<=100000000}
export async function handleAdminSubscriptions(request:Request,env:Env,path:string,admin:Identity):Promise<Response|null>{
 try{
  if(path==='/admin/subscription-plans'&&request.method==='GET'){
   const result=await env.DB.prepare(`SELECT p.id,p.application_id,a.name AS application_name,p.plan_code,p.display_name,p.billing_interval,p.amount_minor,p.currency,p.trial_days,p.is_active,p.created_at
    FROM subscription_plans p JOIN applications a ON a.id=p.application_id ORDER BY a.name,p.amount_minor,p.display_name`).all()
   return json(200,{plans:result.results})
  }
  if(path==='/admin/subscription-plans'&&request.method==='POST'){
   const input=await body(request)
   const applicationId=String(input.application_id||''),planCode=typeof input.plan_code==='string'?input.plan_code.trim().toLowerCase():'',name=typeof input.display_name==='string'?input.display_name.trim():''
   const interval=String(input.billing_interval||''),amount=input.amount_minor,trial=input.trial_days===undefined?0:input.trial_days,currency=String(input.currency||'INR').toUpperCase()
   if(!ID.test(applicationId)||!PLAN_CODE.test(planCode)||!name||name.length>120||!['monthly','quarterly','yearly'].includes(interval)||!validMinor(amount)||!Number.isInteger(trial)||Number(trial)<0||Number(trial)>365||currency!=='INR')fail(400,'invalid_subscription_plan')
   const app=await env.DB.prepare("SELECT id FROM applications WHERE id=? AND status='active'").bind(applicationId).first()
   if(!app)fail(404,'active_application_not_found')
   const id=crypto.randomUUID()
   try{await env.DB.batch([
    env.DB.prepare('INSERT INTO subscription_plans(id,application_id,plan_code,display_name,billing_interval,amount_minor,currency,trial_days) VALUES(?,?,?,?,?,?,?,?)').bind(id,applicationId,planCode,name,interval,amount,currency,trial),
    audit(env,admin,'subscription_plan.created','subscription_plan',id,{application_id:applicationId,plan_code:planCode,billing_interval:interval,amount_minor:amount,currency,trial_days:trial}),
   ])}catch(error){const message=error instanceof Error?error.message:'';if(/UNIQUE|constraint/i.test(message))fail(409,'subscription_plan_exists');throw error}
   const plan=await env.DB.prepare('SELECT id,application_id,plan_code,display_name,billing_interval,amount_minor,currency,trial_days,is_active,created_at FROM subscription_plans WHERE id=?').bind(id).first()
   return json(201,{plan})
  }
  const planMatch=path.match(/^\/admin\/subscription-plans\/([0-9a-f-]+)$/i)
  if(planMatch&&request.method==='PATCH'){
   const id=planMatch[1];if(!ID.test(id))fail(404,'subscription_plan_not_found')
   const input=await body(request),allowed=['display_name','amount_minor','trial_days','is_active']
   if(!Object.keys(input).length||Object.keys(input).some(k=>!allowed.includes(k)))fail(400,'invalid_subscription_plan_update')
   const current=await env.DB.prepare('SELECT id FROM subscription_plans WHERE id=?').bind(id).first()
   if(!current)fail(404,'subscription_plan_not_found')
   const sets:string[]=[],values:unknown[]=[]
   if(input.display_name!==undefined){if(typeof input.display_name!=='string'||!input.display_name.trim()||input.display_name.trim().length>120)fail(400,'invalid_plan_name');sets.push('display_name=?');values.push(input.display_name.trim())}
   if(input.amount_minor!==undefined){if(!validMinor(input.amount_minor))fail(400,'invalid_plan_amount');sets.push('amount_minor=?');values.push(input.amount_minor)}
   if(input.trial_days!==undefined){if(!Number.isInteger(input.trial_days)||Number(input.trial_days)<0||Number(input.trial_days)>365)fail(400,'invalid_trial_days');sets.push('trial_days=?');values.push(input.trial_days)}
   if(input.is_active!==undefined){if(typeof input.is_active!=='boolean')fail(400,'invalid_plan_status');sets.push('is_active=?');values.push(Number(input.is_active))}
   const updated=await env.DB.prepare(`UPDATE subscription_plans SET ${sets.join(',')} WHERE id=? RETURNING id,application_id,plan_code,display_name,billing_interval,amount_minor,currency,trial_days,is_active,created_at`).bind(...values,id).first()
   await audit(env,admin,'subscription_plan.updated','subscription_plan',id,input).run()
   return json(200,{plan:updated})
  }
  if(path==='/admin/subscriptions'&&request.method==='GET'){
   const result=await env.DB.prepare(`SELECT s.id,s.tenant_id,t.name AS tenant_name,t.slug AS tenant_slug,s.application_id,a.name AS application_name,s.plan_id,s.plan_code,p.display_name AS plan_name,s.billing_interval,s.status,
    CASE WHEN s.status='trial' AND s.ends_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now') THEN 'expired' ELSE s.status END AS effective_status,
    s.currency,s.amount_minor,s.payment_mode,s.starts_at,s.ends_at,s.created_at,s.updated_at
    FROM subscriptions s JOIN tenants t ON t.id=s.tenant_id JOIN applications a ON a.id=s.application_id
    LEFT JOIN subscription_plans p ON p.id=s.plan_id ORDER BY s.created_at DESC LIMIT 1000`).all()
   return json(200,{subscriptions:result.results})
  }
  if(path==='/admin/subscriptions'&&request.method==='POST'){
   const input=await body(request),tenantId=String(input.tenant_id||''),applicationId=String(input.application_id||''),planId=String(input.plan_id||'')
   if(!ID.test(tenantId)||!ID.test(applicationId)||!ID.test(planId))fail(400,'invalid_subscription')
   const [tenant,plan,existing]=await Promise.all([
    env.DB.prepare("SELECT id FROM tenants WHERE id=? AND status='active'").bind(tenantId).first(),
    env.DB.prepare('SELECT id,application_id,plan_code,billing_interval,amount_minor,currency,trial_days FROM subscription_plans WHERE id=? AND is_active=1').bind(planId).first<{id:string;application_id:string;plan_code:string;billing_interval:string;amount_minor:number;currency:string;trial_days:number}>(),
    env.DB.prepare("SELECT id FROM subscriptions WHERE tenant_id=? AND application_id=? AND status IN ('trial','pending','active','past_due')").bind(tenantId,applicationId).first(),
   ])
   if(!tenant)fail(404,'active_tenant_not_found')
   if(!plan||plan.application_id!==applicationId)throw Object.assign(new Error('active_plan_not_found'),{status:404})
   if(existing)fail(409,'subscription_already_exists')
   const now=new Date().toISOString(),trialDays=Number(plan.trial_days),status=Number(plan.amount_minor)===0?'active':trialDays>0?'trial':'pending'
   const endsAt=status==='trial'?new Date(Date.now()+trialDays*86400000).toISOString():null
   const id=crypto.randomUUID()
   await env.DB.batch([
    env.DB.prepare('INSERT INTO subscriptions(id,tenant_id,application_id,plan_id,plan_code,billing_interval,status,currency,amount_minor,payment_mode,starts_at,ends_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').bind(id,tenantId,applicationId,planId,plan.plan_code,plan.billing_interval,status,plan.currency,plan.amount_minor,'manual',now,endsAt),
    audit(env,admin,'subscription.created','subscription',id,{tenant_id:tenantId,application_id:applicationId,plan_id:planId,status,amount_minor:plan.amount_minor}),
   ])
   const subscription=await env.DB.prepare('SELECT id,tenant_id,application_id,plan_id,plan_code,billing_interval,status,currency,amount_minor,payment_mode,starts_at,ends_at,created_at FROM subscriptions WHERE id=?').bind(id).first()
   return json(201,{subscription})
  }
  const subscriptionMatch=path.match(/^\/admin\/subscriptions\/([0-9a-f-]+)$/i)
  if(subscriptionMatch&&request.method==='PATCH'){
   const id=subscriptionMatch[1];if(!ID.test(id))fail(404,'subscription_not_found')
   const input=await body(request),status=String(input.status||'')
   if(Object.keys(input).length!==1||!['past_due','cancelled','expired'].includes(status))fail(400,'invalid_subscription_status')
   const result=await env.DB.prepare(`UPDATE subscriptions SET status=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND status<>'cancelled' RETURNING id,status,tenant_id,application_id`).bind(status,id).first<{id:string;status:string;tenant_id:string;application_id:string}>()
   if(!result)fail(404,'subscription_not_found_or_cancelled')
   await audit(env,admin,'subscription.status_changed','subscription',id,{status}).run()
   return json(200,{subscription:result})
  }
  const paymentsMatch=path.match(/^\/admin\/subscriptions\/([0-9a-f-]+)\/payments$/i)
  if(paymentsMatch&&request.method==='GET'){
   const id=paymentsMatch[1];if(!ID.test(id))fail(404,'subscription_not_found')
   const result=await env.DB.prepare('SELECT id,tenant_id,subscription_id,amount_minor,currency,payment_method,status,provider,provider_reference,confirmed_at,created_at FROM subscription_payments WHERE subscription_id=? ORDER BY created_at DESC').bind(id).all()
   return json(200,{payments:result.results})
  }
  if(paymentsMatch&&request.method==='POST'){
   const id=paymentsMatch[1];if(!ID.test(id))fail(404,'subscription_not_found')
   const input=await body(request),amount=input.amount_minor,method=String(input.payment_method||''),reference=typeof input.provider_reference==='string'?input.provider_reference.trim().slice(0,120):''
   if(!Number.isSafeInteger(amount)||Number(amount)<=0||!['cash','bank_transfer','upi','other'].includes(method)||(/^\d{13,19}$/.test(reference)))fail(400,'invalid_manual_payment')
   const subscription=await env.DB.prepare("SELECT id,tenant_id,amount_minor,currency,status FROM subscriptions WHERE id=?").bind(id).first<{id:string;tenant_id:string;amount_minor:number;currency:string;status:string}>()
   if(!subscription)throw Object.assign(new Error('subscription_not_found'),{status:404})
   if(subscription.status==='cancelled'||Number(amount)!==Number(subscription.amount_minor))fail(409,'payment_amount_or_subscription_status_invalid')
   const paymentId=crypto.randomUUID()
   await env.DB.batch([
    env.DB.prepare("INSERT INTO subscription_payments(id,tenant_id,subscription_id,amount_minor,currency,payment_method,status,provider,provider_reference) VALUES(?,?,?,?,?,?,'submitted','manual',?)").bind(paymentId,subscription.tenant_id,id,amount,subscription.currency,method,reference||null),
    audit(env,admin,'subscription_payment.submitted','subscription_payment',paymentId,{subscription_id:id,amount_minor:amount,payment_method:method,provider_reference:reference||null}),
   ])
   const payment=await env.DB.prepare('SELECT id,subscription_id,amount_minor,currency,payment_method,status,provider,provider_reference,created_at FROM subscription_payments WHERE id=?').bind(paymentId).first()
   return json(201,{payment})
  }
  const paymentAction=path.match(/^\/admin\/subscription-payments\/([0-9a-f-]+)\/(confirm|reject)$/i)
  if(paymentAction&&request.method==='POST'){
   const id=paymentAction[1],action=paymentAction[2]
   if(!ID.test(id))fail(404,'subscription_payment_not_found')
   const payment=await env.DB.prepare(`SELECT p.id,p.tenant_id,p.subscription_id,p.amount_minor,p.status,s.status AS subscription_status,s.billing_interval,s.ends_at,s.starts_at
    FROM subscription_payments p JOIN subscriptions s ON s.tenant_id=p.tenant_id AND s.id=p.subscription_id WHERE p.id=?`).bind(id).first<{id:string;tenant_id:string;subscription_id:string;amount_minor:number;status:string;subscription_status:string;billing_interval:string;ends_at:string|null;starts_at:string|null}>()
   if(!payment)throw Object.assign(new Error('subscription_payment_not_found'),{status:404})
   if(!['pending','submitted'].includes(payment.status))fail(409,'subscription_payment_not_pending')
   if(action==='reject'){
    await env.DB.batch([
     env.DB.prepare("UPDATE subscription_payments SET status='rejected' WHERE id=? AND status IN ('pending','submitted')").bind(id),
     env.DB.prepare("INSERT INTO platform_audit_events(actor_issuer,actor_subject,action,resource_type,resource_id,metadata) SELECT ?,?,'subscription_payment.rejected','subscription_payment',?,? WHERE EXISTS(SELECT 1 FROM subscription_payments WHERE id=? AND status='rejected')").bind(admin.issuer,admin.subject,id,JSON.stringify({subscription_id:payment.subscription_id}),id),
    ])
    return json(200,{payment:{id,status:'rejected'}})
   }
   if(payment.subscription_status==='cancelled')fail(409,'subscription_cancelled')
   const now=new Date().toISOString()
   const base=payment.subscription_status==='active'||payment.subscription_status==='past_due'?(payment.ends_at&&payment.ends_at>now?payment.ends_at:now):now
   const startsAt=payment.subscription_status==='active'&&payment.starts_at?payment.starts_at:now
   const endsAt=addInterval(base,payment.billing_interval),confirmedAt=now
   const results=await env.DB.batch([
    env.DB.prepare("UPDATE subscription_payments SET status='confirmed',confirmed_at=?,confirmed_by=NULL WHERE id=? AND status IN ('pending','submitted') AND EXISTS(SELECT 1 FROM subscriptions s WHERE s.tenant_id=subscription_payments.tenant_id AND s.id=subscription_payments.subscription_id AND s.status<>'cancelled')").bind(confirmedAt,id),
    env.DB.prepare("UPDATE subscriptions SET status='active',starts_at=?,ends_at=?,updated_at=? WHERE id=? AND status<>'cancelled' AND EXISTS(SELECT 1 FROM subscription_payments p WHERE p.id=? AND p.status='confirmed' AND p.confirmed_at=?)").bind(startsAt,endsAt,now,payment.subscription_id,id,confirmedAt),
    env.DB.prepare("INSERT INTO platform_audit_events(actor_issuer,actor_subject,action,resource_type,resource_id,metadata) SELECT ?,?,'subscription_payment.confirmed','subscription_payment',?,? WHERE EXISTS(SELECT 1 FROM subscriptions WHERE id=? AND status='active' AND ends_at=?) AND EXISTS(SELECT 1 FROM subscription_payments WHERE id=? AND status='confirmed' AND confirmed_at=?)").bind(admin.issuer,admin.subject,id,JSON.stringify({subscription_id:payment.subscription_id,ends_at:endsAt}),payment.subscription_id,endsAt,id,confirmedAt),
   ])
   if(!results[0]?.meta?.changes||!results[1]?.meta?.changes)fail(409,'subscription_payment_confirmation_race')
   return json(200,{payment:{id,status:'confirmed',confirmed_at:confirmedAt},subscription:{id:payment.subscription_id,status:'active',starts_at:startsAt,ends_at:endsAt}})
  }
  return null
 }catch(error){
  const status=error&&typeof error==='object'&&'status'in error?Number(error.status):500
  const code=error instanceof Error&&'status'in error?error.message:status===500?'subscription_operation_failed':'invalid_request'
  return json(status,{error:code})
 }
}
