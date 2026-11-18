import type { Env, Identity } from './types.ts'
const json=(status:number,body:unknown)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}})
export async function handleAdminMonitoring(request:Request,env:Env,admin:Identity):Promise<Response|null>{
 if(request.method!=='GET')return null
 try{
  const [counts,events,deployments]=await Promise.all([
   env.DB.prepare(`SELECT
    (SELECT count(*) FROM applications WHERE status='active') AS active_applications,
    (SELECT count(*) FROM tenants WHERE status='active') AS active_tenants,
    (SELECT count(*) FROM tenants WHERE status='suspended') AS suspended_tenants,
    (SELECT count(*) FROM subscriptions WHERE status='active') AS active_subscriptions,
    (SELECT count(*) FROM subscriptions WHERE status='trial' AND ends_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) AS active_trials,
    (SELECT count(*) FROM subscriptions WHERE status='trial' AND ends_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now')) AS expired_trials,
    (SELECT count(*) FROM subscriptions WHERE status='trial' AND ends_at>strftime('%Y-%m-%dT%H:%M:%fZ','now') AND ends_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now','+7 days')) AS trials_expiring_7d,
    (SELECT count(*) FROM subscription_payments WHERE status IN ('pending','submitted')) AS payments_awaiting_review,
    (SELECT count(*) FROM platform_owner_invitations WHERE status='pending') AS pending_owner_invitations,
    (SELECT count(*) FROM application_releases WHERE status IN ('uploaded','validated')) AS releases_awaiting_review,
    (SELECT count(*) FROM application_deployments WHERE status='running') AS running_deployments,
    (SELECT count(*) FROM application_deployments WHERE status='failed') AS failed_deployments,
    (SELECT max(created_at) FROM platform_audit_events) AS last_platform_activity`).first(),
   env.DB.prepare('SELECT id,actor_subject,action,resource_type,resource_id,metadata,created_at FROM platform_audit_events ORDER BY created_at DESC LIMIT 20').all(),
   env.DB.prepare(`SELECT d.id,a.name AS application_name,r.version,d.environment,d.status,d.started_at,d.finished_at,d.created_at,d.health_report
    FROM application_deployments d JOIN applications a ON a.id=d.application_id JOIN application_releases r ON r.id=d.release_id
    ORDER BY d.created_at DESC LIMIT 10`).all(),
  ])
  return json(200,{generated_at:new Date().toISOString(),admin_subject:admin.subject,counts:counts??{},recent_events:events.results,recent_deployments:deployments.results,usage_metrics:{available:false,note:'Worker CPU, request counts and D1 quota usage are not available through this application database endpoint. Check Cloudflare Analytics for platform usage.'}})
 }catch{return json(500,{error:'monitoring_data_unavailable'})}
}
