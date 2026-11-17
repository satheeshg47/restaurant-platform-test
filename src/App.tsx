import { useEffect, useState } from 'react'
import {
  Activity, AppWindow, ArrowUpRight, Bell, Boxes, Check, QrCode, BarChart3,
  ChevronDown, CircleHelp, CreditCard, Database, Download, FileArchive,
  FileCheck2, LayoutDashboard, LifeBuoy, LockKeyhole,
  Menu, MoreHorizontal, Plus, Settings, ShieldCheck, Store, Utensils,
  Users, X, Zap, ScrollText, MessageCircle
} from 'lucide-react'
import AuditLog from './AuditLog'
import Applications from './Applications'
import Owners from './Owners'
import Communications from './Communications'
import RestaurantMenu from './RestaurantMenu'
import RestaurantOperations from './RestaurantOperations'
import RestaurantTables from './RestaurantTables'
import RestaurantSettings from './RestaurantSettings'
import RestaurantReports from './RestaurantReports'
import RestaurantReviews from './RestaurantReviews'
import RestaurantDataExport from './RestaurantDataExport'
import GuestMenu from './GuestMenu'

type Section = 'Overview' | 'Applications' | 'Restaurant Suite' | 'Tables & QR' | 'Kitchen & Service' | 'Restaurant Settings' | 'Restaurant Reports' | 'Customer Reviews' | 'Restaurant Data Export' | 'Owners' | 'Communications' | 'Subscriptions' | 'Update Centre' | 'Data & Backups' | 'Monitoring' | 'Security' | 'Audit Log'
type AppRecord = { name: string; category: string; status: 'Active' | 'Draft' | 'Paused'; version: string; owners: number; initials: string; tone: string }

const initialApps: AppRecord[] = [
  { name: 'Restaurant Suite', category: 'Food & hospitality', status: 'Draft', version: '0.1.0', owners: 0, initials: 'RS', tone: 'violet' },
  { name: 'Inventory Desk', category: 'Operations', status: 'Draft', version: '—', owners: 0, initials: 'ID', tone: 'blue' },
  { name: 'Workforce Hub', category: 'People & teams', status: 'Draft', version: '—', owners: 0, initials: 'WH', tone: 'orange' },
]

const nav: { label: Section; icon: typeof LayoutDashboard }[] = [
  { label: 'Overview', icon: LayoutDashboard },
  { label: 'Applications', icon: AppWindow },
  { label: 'Restaurant Suite', icon: Store },
  { label: 'Tables & QR', icon: QrCode },
  { label: 'Kitchen & Service', icon: Utensils },
  { label: 'Restaurant Settings', icon: Settings },
  { label: 'Restaurant Reports', icon: BarChart3 },
  { label: 'Customer Reviews', icon: MessageCircle },
  { label: 'Restaurant Data Export', icon: Database },
  { label: 'Owners', icon: Users },
  { label: 'Communications', icon: MessageCircle },
  { label: 'Subscriptions', icon: CreditCard },
  { label: 'Update Centre', icon: FileCheck2 },
  { label: 'Data & Backups', icon: Database },
  { label: 'Monitoring', icon: Activity },
  { label: 'Security', icon: ShieldCheck },
  { label: 'Audit Log', icon: ScrollText },
]

function App() {
  const [section, setSection] = useState<Section>('Overview')
  const [apps] = useState(initialApps)
  const [menuOpen, setMenuOpen] = useState(false)
  const [notice, setNotice] = useState('')

  const notify = (message: string) => { setNotice(message); window.setTimeout(() => setNotice(''), 3200) }

  const guestRoute = window.location.pathname.match(/^\/r\/([^/]+)\/([^/]+)\/?$/)
  if (guestRoute) return <GuestMenu slug={decodeURIComponent(guestRoute[1])} token={decodeURIComponent(guestRoute[2])} />


  const pageTitle = section === 'Overview' ? 'Good evening' : section
  const pageSubtitle = section === 'Overview'
    ? 'Your platform at a glance. Here’s what’s happening today.'
    : `Manage your platform’s ${section.toLowerCase()}.`

  return (
    <div className="shell">
      <aside className={`sidebar ${menuOpen ? 'sidebar-open' : ''}`}>
        <div className="brand"><div className="brand-mark"><Boxes size={21} /></div><div><strong>platform<span>core</span></strong><small>CONTROL PLANE</small></div><button className="icon-button close-menu" onClick={() => setMenuOpen(false)} aria-label="Close menu"><X size={18}/></button></div>
        <div className="workspace-label">WORKSPACE</div>
        <div className="workspace"><div className="workspace-avatar">P</div><div><b>Personal workspace</b><small>Super Admin</small></div><ChevronDown size={15}/></div>
        <div className="nav-label">MANAGE</div>
        <nav>{nav.map(item => { const Icon = item.icon; return <button key={item.label} className={`nav-item ${section === item.label ? 'active' : ''}`} onClick={() => { setSection(item.label); setMenuOpen(false) }}><Icon size={18}/><span>{item.label}</span>{item.label === 'Update Centre' && <i className="nav-dot"/>}</button> })}</nav>
        <div className="sidebar-bottom"><div className="help-card"><div className="help-icon"><LifeBuoy size={17}/></div><b>Need a hand?</b><p>Explore setup guides and platform help.</p><button onClick={() => notify('Help centre will be connected in a later build.')}>Open help centre <ArrowUpRight size={13}/></button></div><div className="profile"><div className="profile-avatar">SG</div><div className="profile-copy"><b>Super Admin</b><small>Owner access</small></div><button className="icon-button" onClick={() => setSection('Security')} aria-label="Account settings"><Settings size={17}/></button></div></div>
      </aside>

      {menuOpen && <button className="scrim" onClick={() => setMenuOpen(false)} aria-label="Close navigation"/>}
      <main className="main">
        <header className="topbar"><button className="icon-button mobile-menu" onClick={() => setMenuOpen(true)} aria-label="Open navigation"><Menu size={20}/></button><div className="breadcrumb">Platform <span>/</span> <b>{section}</b></div><div className="top-actions"><div className="environment"><i/> Development mode</div><button className="icon-button notification" onClick={() => notify('You’re all caught up.')} aria-label="Notifications"><Bell size={18}/><i/></button><div className="top-avatar">SG</div></div></header>
        <div className="content">
          <div className="welcome-row"><div><div className="eyebrow">{new Date().toLocaleDateString('en-IN', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' }).toUpperCase()}</div><h1>{pageTitle}{section === 'Overview' ? ', Admin' : ''}</h1><p>{pageSubtitle}</p></div><div className="welcome-actions"><button className="button secondary" onClick={() => notify('Reports will be available after connecting live data.')}><Download size={16}/> Export</button><button className="button primary" onClick={() => { setSection('Applications'); notify('Application creation is not connected yet. No data was saved.') }}><Plus size={17}/> Add application</button></div></div>

          {section === 'Overview' && <Overview apps={apps} setSection={setSection} notify={notify}/>}
          {section === 'Applications' && <Applications />}
          {section === 'Owners' && <Owners />}
          {section === 'Restaurant Suite' && <RestaurantMenu />}
          {section === 'Tables & QR' && <RestaurantTables />}
          {section === 'Kitchen & Service' && <RestaurantOperations />}
          {section === 'Restaurant Settings' && <RestaurantSettings />}
          {section === 'Restaurant Reports' && <RestaurantReports />}
          {section === 'Customer Reviews' && <RestaurantReviews />}
          {section === 'Restaurant Data Export' && <RestaurantDataExport />}
          {section === 'Communications' && <Communications />}
          {section === 'Subscriptions' && <Placeholder icon={CreditCard} title="Subscription management" description="Configure plans, trials, billing cycles and payment confirmation." items={['Monthly, quarterly and yearly plans','Manual payment verification','Online payment provider integration','Expiry reminders and subscription history']}/>}
          {section === 'Update Centre' && <Placeholder icon={FileArchive} title="Safe application updates" description="Upload a release package, validate it, review changes and approve deployment." items={['ZIP upload and manifest validation','Compatibility and migration checks','Pre-deployment backup','Approval, health check and rollback']}/>}
          {section === 'Data & Backups' && <Placeholder icon={Database} title="Data & backups" description="Keep application data portable, protected and recoverable." items={['Per-application data overview','Encrypted backup exports','Restore drills and recovery history','PostgreSQL and S3-compatible migration']}/>}
          {section === 'Monitoring' && <Placeholder icon={Activity} title="Platform monitoring" description="Monitor service health and identify issues before customers do." items={['API latency and error rates','Database and storage health','Capacity and usage alerts','Audit-ready incident history']}/>}
          {section === 'Security' && <Placeholder icon={LockKeyhole} title="Security & access" description="Protect the control plane with owner-only access and traceable actions." items={['Owner-only administrator access','MFA and passkey sign-in','Role and permission policies','Immutable security audit events']}/>}
          {section === 'Audit Log' && <AuditLog />}
          <footer className="footer"><span>Platform Core <b>·</b> v0.1.0 preview</span><span><i className="footer-dot"/> Development workspace · Sample data only</span></footer>
        </div>
      </main>

      {notice && <div className="toast"><Check size={16}/>{notice}</div>}
    </div>
  )
}


type ServiceStatus = 'loading' | 'connected' | 'not_configured' | 'unavailable' | 'unknown'
const API_BASE = (import.meta.env.VITE_API_BASE_URL || '/api').replace(/\/$/, '')

function ServiceHealth() {
  const [apiStatus, setApiStatus] = useState<ServiceStatus>('loading')
  const [databaseStatus, setDatabaseStatus] = useState<ServiceStatus>('loading')
  const [environment, setEnvironment] = useState('—')
  const [checkedAt, setCheckedAt] = useState('')
  const [refreshing, setRefreshing] = useState(false)

  async function refresh() {
    setRefreshing(true)
    try {
      const [healthResponse, readyResponse] = await Promise.all([
        fetch(`${API_BASE}/health`, { headers: { Accept: 'application/json' } }),
        fetch(`${API_BASE}/ready`, { headers: { Accept: 'application/json' } }),
      ])
      const health = await healthResponse.json()
      const readiness = await readyResponse.json()
      if (!healthResponse.ok) throw new Error('The API health endpoint returned an error.')
      setApiStatus('connected')
      setEnvironment(typeof health.environment === 'string' ? health.environment : 'unknown')
      setDatabaseStatus(readyResponse.ok
        ? 'connected'
        : readiness.checks?.database === 'not_configured' ? 'not_configured' : 'unavailable')
      setCheckedAt(new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))
    } catch {
      setApiStatus('unavailable')
      setDatabaseStatus('unknown')
      setEnvironment('—')
      setCheckedAt(new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))
    } finally {
      setRefreshing(false)
    }
  }

  useEffect(() => {
    void refresh()
    const interval = window.setInterval(() => void refresh(), 30000)
    return () => window.clearInterval(interval)
  }, [])

  const label = (status: ServiceStatus) => ({
    loading: 'Checking…',
    connected: 'Connected',
    not_configured: 'Not configured',
    unavailable: 'Unavailable',
    unknown: 'Unknown',
  })[status]
  const tone = (status: ServiceStatus) => status === 'connected' ? 'healthy' :
    status === 'loading' || status === 'unknown' ? 'pending' : 'unhealthy'

  return (
    <section className="service-health panel" aria-live="polite">
      <div className="service-health-heading">
        <div><span className="eyebrow">LIVE SERVICE CHECK</span><h2>Platform services</h2><p>Fetched from the Platform Core API. Refreshes every 30 seconds.</p></div>
        <button className="button secondary small" onClick={() => void refresh()} disabled={refreshing}>
          <Activity size={14}/>{refreshing ? 'Checking' : 'Refresh'}
        </button>
      </div>
      <div className="service-health-grid">
        <div className="service-health-item">
          <div className="service-health-icon"><Activity size={17}/></div>
          <div><b>API process</b><small>Environment: {environment}</small></div>
          <span className={`service-status ${tone(apiStatus)}`}><i/>{label(apiStatus)}</span>
        </div>
        <div className="service-health-item">
          <div className="service-health-icon"><Database size={17}/></div>
          <div><b>PostgreSQL</b><small>Readiness probe: SELECT 1</small></div>
          <span className={`service-status ${tone(databaseStatus)}`}><i/>{label(databaseStatus)}</span>
        </div>
      </div>
      <div className="service-health-footnote">
        {checkedAt ? `Last checked at ${checkedAt}.` : 'Waiting for the first health check.'}
        {databaseStatus === 'not_configured' && ' Add DATABASE_URL to the API environment to enable database readiness.'}
        {apiStatus === 'unavailable' && ' Start the API and check that the frontend /api proxy is configured.'}
      </div>
    </section>
  )
}

type MilestoneState = 'complete' | 'next' | 'planned'
const projectMilestones: { title: string; state: MilestoneState }[] = [
  { title: 'Platform foundation & API health checks', state: 'complete' },
  { title: 'Shared PostgreSQL schema & tenant isolation', state: 'complete' },
  { title: 'Owner identity verification & protected APIs', state: 'complete' },
  { title: 'Audit log and application registry screens', state: 'complete' },
  { title: 'Release manifest validation foundation', state: 'complete' },
  { title: 'Restaurant menu, options, stock & multilingual tools', state: 'complete' },
  { title: 'QR ordering, kitchen queue & waiter workflows', state: 'complete' },
  { title: 'Payments, tax settings & GST invoice foundation', state: 'complete' },
  { title: 'Reports, daily closing & customer reviews', state: 'complete' },
  { title: 'Tenant backup export, validation & restore preflight', state: 'complete' },
  { title: 'Safe owner-only restore & atomic recovery tests', state: 'complete' },
  { title: 'Owner management, subscriptions & approved updates', state: 'next' },
  { title: 'Production hosting, identity, storage & monitoring', state: 'planned' },
  { title: 'Automated backups and end-to-end recovery drills', state: 'planned' },
]

function ProjectProgress() {
  const completed = projectMilestones.filter(item => item.state === 'complete').length
  const percent = Math.round((completed / projectMilestones.length) * 100)
  const nextMilestone = projectMilestones.find(item => item.state === 'next')
  return (
    <section className="project-progress panel" aria-label="Platform Core project status">
      <div className="project-progress-top">
        <div><span className="eyebrow">BUILD TRACKER</span><h2>Project status</h2></div>
        <div className="project-progress-total"><strong>{percent}%</strong><small>{completed}/{projectMilestones.length} milestones</small></div>
      </div>
      <div className="project-progress-bar" role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}><span style={{ width: percent + '%' }} /></div>
      <div className="project-milestones">
        {projectMilestones.map((item, index) => (
          <div className={`project-milestone ${item.state}`} key={item.title}>
            <span className="project-milestone-mark">{item.state === 'complete' ? <Check size={11} /> : item.state === 'next' ? <span className="project-milestone-dot" /> : null}</span>
            <span className="project-milestone-number">{index + 1}.</span>
            <span className="project-milestone-title">{item.title}</span>
          </div>
        ))}
      </div>
      <div className="project-next"><span>UP NEXT</span><b>{nextMilestone?.title || "No pending milestone"}</b><small>{nextMilestone ? "In progress" : "All milestones complete"}</small></div>
      <p className="project-progress-note">Progress tracks implemented development milestones, not production readiness. Live identity configuration, hosted database, storage and deployment still require setup.</p>
    </section>
  )
}

function Overview({ apps, setSection, notify }: { apps: AppRecord[]; setSection: (s: Section)=>void; notify: (s:string)=>void }) {
  const stats = [
    { label: 'Applications', value: String(apps.length).padStart(2,'0'), detail: 'Registered in workspace', icon: AppWindow, tint: 'purple' },
    { label: 'Owners', value: '00', detail: 'No owners onboarded', icon: Users, tint: 'blue' },
    { label: 'Active subscriptions', value: '00', detail: 'Billing not connected', icon: CreditCard, tint: 'green' },
    { label: 'Pending updates', value: '00', detail: 'No releases awaiting review', icon: FileCheck2, tint: 'orange' },
  ]
  return <>
    <ServiceHealth />
    <ProjectProgress />
    <div className="stat-grid">{stats.map(s=>{const Icon=s.icon;return <div className="stat-card" key={s.label}><div className="stat-top"><span>{s.label}</span><div className={`stat-icon ${s.tint}`}><Icon size={17}/></div></div><strong>{s.value}</strong><small>{s.detail}</small></div>})}</div>
    <div className="overview-grid"><section className="panel apps-panel"><div className="panel-heading"><div><h2>Applications</h2><p>Products in your platform workspace.</p></div><button className="text-button" onClick={()=>setSection('Applications')}>View all <ArrowUpRight size={14}/></button></div><div className="app-list">{apps.slice(0,4).map(app=><div className="app-row" key={app.name}><div className={`app-icon ${app.tone}`}>{app.initials}</div><div className="app-info"><b>{app.name}</b><small>{app.category}</small></div><span className={`status ${app.status.toLowerCase()}`}>{app.status}</span><button className="icon-button" onClick={()=>notify(`${app.name} details will be added next.`)} aria-label="Application options"><MoreHorizontal size={18}/></button></div>)}</div><button className="add-row" onClick={()=>setSection('Applications')}><Plus size={16}/> Manage applications</button></section>
      <section className="panel activity-panel"><div className="panel-heading"><div><h2>Platform activity</h2><p>Recent events across your workspace.</p></div><button className="icon-button" onClick={()=>notify('No additional events yet.')} aria-label="More activity"><MoreHorizontal size={18}/></button></div><div className="empty-activity"><div className="empty-icon"><Activity size={21}/></div><b>No activity yet</b><p>When you add applications, owners or releases, events will appear here.</p></div></section></div>
    <section className="panel setup-panel"><div className="setup-title"><div><span className="eyebrow">GETTING STARTED</span><h2>Set up your platform</h2><p>Complete these foundations before onboarding customers.</p></div><div className="setup-progress"><strong>1/5</strong><small>steps started</small></div></div><div className="setup-steps"><div className="setup-step done"><div className="step-check"><Check size={14}/></div><div><b>Workspace created</b><small>Your private control plane is ready to configure.</small></div><span>Done</span></div>{[['Secure administrator sign-in','Protect your Super Admin account with MFA.','Security'],['Register your first application','Start with Restaurant Suite.','Applications'],['Connect the platform database','Set up isolated tenant data.','Data & Backups'],['Configure backup and recovery','Choose a portable backup destination.','Data & Backups']].map(([title,desc,target])=><button className="setup-step" key={title} onClick={()=>setSection(target as Section)}><div className="step-number"/><div><b>{title}</b><small>{desc}</small></div><ArrowUpRight size={15}/></button>)}</div></section>
    <div className="notice-strip"><div className="notice-symbol"><Zap size={17}/></div><div><b>Development mode is active</b><p>Application and owner lists use sample data. Authentication, payments, backups and deployment are not connected yet.</p></div><button onClick={()=>notify('Development mode remains enabled until deployment is configured.')}>Learn more <ArrowUpRight size={13}/></button></div>
  </>
}

function Placeholder({ icon: Icon, title, description, items }: { icon: typeof Users; title: string; description: string; items: string[] }) {
  return <section className="panel feature-panel"><div className="feature-icon"><Icon size={23}/></div><div className="feature-copy"><span className="eyebrow">PLATFORM MODULE</span><h2>{title}</h2><p>{description}</p></div><div className="feature-list">{items.map((item,i)=><div key={item}><span className="feature-number">0{i+1}</span><b>{item}</b><span className="coming">Planned</span></div>)}</div><div className="feature-note"><CircleHelp size={16}/> This module is in the implementation roadmap. No live customer data or actions are connected yet.</div></section>
}

export default App