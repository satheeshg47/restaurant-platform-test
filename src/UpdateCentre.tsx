import { useEffect, useState } from 'react'
import { Activity, AlertTriangle, CheckCircle2, Clock3, FileArchive, RefreshCw, ShieldCheck } from 'lucide-react'
import { apiFetch } from './auth'

type Release = { id: string; application_name: string; app_key: string; version: string; package_sha256: string; status: string; created_at: string; manifest: { database_migration_version?: number; files?: Array<{ path: string; size_bytes: number }> } }
type Deployment = { id: string; application_name: string; version: string; environment: string; status: string; created_at: string }

export default function UpdateCentre({ apiBaseUrl }: { apiBaseUrl: string }) {
  const [releases, setReleases] = useState<Release[]>([])
  const [deployments, setDeployments] = useState<Deployment[]>([])
  const [state, setState] = useState<'loading' | 'ready' | 'unavailable'>('loading')
  const [refreshing, setRefreshing] = useState(false)
  const [checkedAt, setCheckedAt] = useState('')
  const [manifestText, setManifestText] = useState('')
  const [manifestResult, setManifestResult] = useState<{valid?:boolean;errors?:Array<{code:string;path:string;message:string}>;error?:string;checks?:Record<string,boolean>;limitations?:string[]}|null>(null)
  const [validatingManifest, setValidatingManifest] = useState(false)
  async function validateManifest() {
    setValidatingManifest(true); setManifestResult(null)
    try {
      const manifest=JSON.parse(manifestText)
      const response=await apiFetch(`${apiBaseUrl}/admin/releases/validate-manifest`,{method:'POST',headers:{Accept:'application/json','Content-Type':'application/json'},body:JSON.stringify({manifest}),cache:'no-store'})
      setManifestResult(await response.json())
    } catch(error) { setManifestResult({error:error instanceof SyntaxError?'Manifest is not valid JSON.':'Preflight request failed.'}) }
    finally { setValidatingManifest(false) }
  }

  async function refresh() {
    setRefreshing(true)
    try {
      const response = await apiFetch(`${apiBaseUrl}/admin/releases`, { headers: { Accept: 'application/json' }, cache: 'no-store' })
      if (!response.ok) throw new Error('Release registry unavailable')
      const data = await response.json()
      if (!Array.isArray(data.releases) || !Array.isArray(data.deployments)) throw new Error('Invalid registry response')
      setReleases(data.releases); setDeployments(data.deployments); setState('ready')
      setCheckedAt(new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))
    } catch { setState('unavailable') } finally { setRefreshing(false) }
  }
  useEffect(() => { void refresh() }, [])
  const label = (value: string) => value.split('_').join(' ')
  return <div className="update-centre">
    <section className="panel">
      <div className="panel-heading"><div><span className="eyebrow">RELEASE PREFLIGHT</span><h2>Validate release manifest</h2><p>Check manifest structure and compatibility before package handling is enabled.</p></div></div>
      <textarea aria-label="Release manifest JSON" value={manifestText} onChange={event=>setManifestText(event.target.value)} placeholder="Paste release manifest JSON here…" style={{width:'100%',minHeight:180,boxSizing:'border-box',border:'1px solid #e1e5ed',borderRadius:9,padding:12,font:'11px ui-monospace, monospace',resize:'vertical'}} />
      <div style={{display:'flex',justifyContent:'flex-end',marginTop:10}}><button className="button primary" onClick={()=>void validateManifest()} disabled={validatingManifest||!manifestText.trim()}>{validatingManifest?'Validating…':'Validate manifest'}</button></div>
      {manifestResult&&<div className="empty-activity" style={{minHeight:0,alignItems:'flex-start',textAlign:'left',padding:'12px 0'}}>
        <b>{manifestResult.valid?'Manifest metadata passed preflight':'Manifest preflight did not pass'}</b>
        {manifestResult.error&&<p>{manifestResult.error}</p>}
        {manifestResult.errors?.map((issue,index)=><p key={index}>{issue.path||'Manifest'} · {issue.code}: {issue.message}</p>)}
        {manifestResult.checks&&<p>{Object.entries(manifestResult.checks).map(([key,value])=>`${key.replaceAll('_',' ')}: ${value?'passed':'failed'}`).join(' · ')}</p>}
        {manifestResult.limitations?.map((item,index)=><p key={index}>{item}</p>)}
      </div>}
      <div className="feature-note"><AlertTriangle size={16}/> Preflight checks metadata only. ZIP inspection, file-hash verification, private artifact storage, backup and deployment remain disabled.</div>
    </section>
    <section className="panel">
      <div className="panel-heading"><div><span className="eyebrow">RELEASE CONTROL</span><h2>Application releases</h2><p>Live release and deployment history from production D1.</p></div>
        <button className="button secondary small" onClick={() => void refresh()} disabled={refreshing}><RefreshCw size={14}/>{refreshing ? 'Refreshing' : 'Refresh'}</button>
      </div>
      {state === 'loading' && <div className="empty-activity">Loading release registry…</div>}
      {state === 'unavailable' && <div className="empty-activity"><b>Release registry unavailable</b><p>Check the administrator API and production D1 connection, then refresh.</p></div>}
      {state === 'ready' && releases.length === 0 && <div className="empty-activity"><div className="empty-icon"><FileArchive size={21}/></div><b>No releases registered</b><p>The release ledger is connected. No package has been uploaded or registered.</p></div>}
      {state === 'ready' && releases.length > 0 && <div className="monitoring-event-list">{releases.map(release => <article className="monitoring-event" key={release.id}>
        <div><b>{release.application_name} · v{release.version}</b><small>{release.app_key} · {label(release.status)} · {new Date(release.created_at).toLocaleString('en-IN')}</small>
          <small>{Array.isArray(release.manifest?.files) ? release.manifest.files.length : 0} manifest files · migration {release.manifest?.database_migration_version ?? '—'}</small><small>SHA-256: {release.package_sha256}</small></div>
      </article>)}</div>}
      <p className="service-health-footnote">{checkedAt ? `Last checked at ${checkedAt}.` : 'Registry data is read-only in this stage.'}</p>
    </section>
    <section className="panel"><div className="panel-heading"><div><span className="eyebrow">DEPLOYMENT HISTORY</span><h2>Deployments</h2><p>Recorded environments and outcomes.</p></div></div>
      {state === 'ready' && deployments.length === 0 && <div className="empty-activity"><b>No deployments recorded</b><p>Deployment records will appear after a release passes the required gates.</p></div>}
      {state === 'ready' && deployments.length > 0 && <div className="monitoring-event-list">{deployments.map(item => <article className="monitoring-event" key={item.id}>
        <div><b>{item.application_name} · v{item.version}</b><small>{item.environment} · {label(item.status)}</small><small>{new Date(item.created_at).toLocaleString('en-IN')}</small></div>
      </article>)}</div>}
    </section>
    <section className="panel feature-panel"><div className="feature-icon"><ShieldCheck size={23}/></div>
      <div className="feature-copy"><span className="eyebrow">SAFETY GATES</span><h2>Deployment actions remain locked</h2><p>This screen reads the real release ledger, but it deliberately does not accept packages, approve releases or trigger deployments yet.</p></div>
      <div className="feature-list">
        <div><span className="feature-number">01</span><b>Release registry and history: connected</b><CheckCircle2 size={16}/></div>
        <div><span className="feature-number">02</span><b>Private, durable package storage: not configured</b><AlertTriangle size={16}/></div>
        <div><span className="feature-number">03</span><b>Independent pre-deployment backup: unavailable</b><Clock3 size={16}/></div>
        <div><span className="feature-number">04</span><b>Verified deploy runner, health checks and rollback: pending</b><Activity size={16}/></div>
      </div>
      <div className="feature-note"><AlertTriangle size={16}/> No paid storage or deployment service has been enabled. Unverified packages cannot be deployed, and customer data is never used as a release artifact.</div>
    </section>
  </div>
}
