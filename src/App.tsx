import { useEffect, useState } from 'react'
import {
  Activity, AppWindow, ArrowUpRight, Bell, Boxes, Check,
  ChevronDown, CircleHelp, CreditCard, Database, Download,
  FileCheck2, LayoutDashboard, LifeBuoy, LockKeyhole,
  Menu, MoreHorizontal, Plus, Settings, ShieldCheck, Store,
  Users, X, Zap, ScrollText, MessageCircle
} from 'lucide-react'
import AuditLog from './AuditLog'
import Applications from './Applications'
import Owners from './Owners'
import Subscriptions from './Subscriptions'
import Monitoring from './Monitoring'
import UpdateCentre from './UpdateCentre'
import Communications from './Communications'
import RestaurantMenu from './RestaurantMenu'
import RestaurantOperations from './RestaurantOperations'
import RestaurantTables from './RestaurantTables'
import RestaurantSettings from './RestaurantSettings'
import RestaurantReports from './RestaurantReports'
import RestaurantReviews from './RestaurantReviews'
import RestaurantDataExport from './RestaurantDataExport'
import GuestMenu from './GuestMenu'
import OwnerPortal from './OwnerPortal'
import OwnerInviteAcceptance from './OwnerInviteAcceptance'
import StaffPortal from './StaffPortal'
import SignIn from './SignIn'
import { apiFetch, completeOidcLogin, setSessionToken as setApiSessionToken } from './auth'

type Section = 'Overview' | 'Applications' | 'Restaurant Suite' | 'Tables & QR' | 'Kitchen & Service' | 'Restaurant Settings' | 'Restaurant Reports' | 'Customer Reviews' | 'Restaurant Data Export' | 'Owners' | 'Communications' | 'Subscriptions' | 'Update Centre' | 'Data & Backups' | 'Monitoring' | 'Security' | 'Audit Log' | 'Admin Area'
type AppRecord = { id: string; name: string; category: string; status: 'Active' | 'Draft' | 'Paused'; initials: string; tone: string }
type OverviewEvent = { id: string; action: string; resource_type: string; created_at: string }
type NativeMembership = { tenant_id: string; tenant_name: string; tenant_slug: string; membership_role: string; staff_id: string | null; staff_role: 'cook' | 'waiter' | 'manager' | null; display_name: string | null }
type NativeUser = { id: string; email: string | null; login_id: string; is_admin: boolean; tenant_role: string | null; memberships: NativeMembership[] }

const nav: { label: string; section: Section; icon: typeof LayoutDashboard }[] = [
  { label: 'Dashboard', section: 'Overview', icon: LayoutDashboard },
  { label: 'Apps', section: 'Applications', icon: AppWindow },
  { label: 'Subscribers', section: 'Owners', icon: Users },
  { label: 'Messages', section: 'Communications', icon: MessageCircle },
  { label: 'Subscriptions', section: 'Subscriptions', icon: CreditCard },
  { label: 'Updates', section: 'Update Centre', icon: FileCheck2 },
  { label: 'Admin area', section: 'Admin Area', icon: ShieldCheck },
]

function App() {
  const [section, setSection] = useState<Section>('Overview')
  const [menuOpen, setMenuOpen] = useState(false)
  const [notice, setNotice] = useState('')
  const [sessionToken, setSessionToken] = useState<string | null>(null)
  const [sessionIdToken, setSessionIdToken] = useState<string | null>(null)
  const [nativeUser, setNativeUser] = useState<NativeUser | null>(null)
  const [authReady, setAuthReady] = useState(false)
  const [authError, setAuthError] = useState('')
  const [bootstrapAvailable, setBootstrapAvailable] = useState(false)
  const [encryptionReady, setEncryptionReady] = useState(false)
  const [adminAccess, setAdminAccess] = useState<'checking' | 'allowed' | 'forbidden' | 'unavailable'>('checking')
  const [, setRouteRefresh] = useState(0)

  const notify = (message: string) => { setNotice(message); window.setTimeout(() => setNotice(''), 3200) }

  const ownerRoute = window.location.pathname === '/owner' || window.location.pathname === '/owner/'
  const ownerInviteRoute = window.location.pathname === '/owner/invitations/accept'
  const staffRoute = window.location.pathname === '/staff' || window.location.pathname === '/staff/'
  const staffLoginRoute = staffRoute && new URLSearchParams(window.location.search).get('login') === '1'

  useEffect(() => {
    if (window.location.pathname === '/owner/invitations/accept') {
      const inviteToken = new URLSearchParams(window.location.hash.slice(1)).get('token') || ''
      if (/^[A-Za-z0-9_-]{43}$/.test(inviteToken)) sessionStorage.setItem('platformcore.owner.invitation.token', inviteToken)
      if (window.location.hash) window.history.replaceState({}, document.title, window.location.pathname)
    }
    if (window.location.pathname !== '/auth/callback') {
      let active = true
      fetch(`${API_BASE}/auth/session`, { credentials: 'same-origin', headers: { Accept: 'application/json' }, cache: 'no-store' })
        .then(async response => {
          const payload = await response.json().catch(() => ({})) as { authenticated?: boolean; bootstrap_available?: boolean; encryption_ready?: boolean; user?: NativeUser }
          if (!active) return
          if (response.ok && payload.authenticated) {
            setApiSessionToken('native')
            setSessionToken('native')
            setSessionIdToken(null)
            setNativeUser(payload.user || null)
          }
          setBootstrapAvailable(payload.bootstrap_available === true)
          setEncryptionReady(payload.encryption_ready === true)
        })
        .catch(() => {})
        .finally(() => { if (active) setAuthReady(true) })
      return () => { active = false }
    }
    completeOidcLogin().then(tokens => {
      setApiSessionToken(tokens.accessToken)
      setSessionToken(tokens.accessToken)
      setSessionIdToken(tokens.idToken)
      setNativeUser(null)
      setAuthError('')
      setAuthReady(true)
    }).catch(cause => {
      setAuthError(cause instanceof Error ? cause.message : 'Sign-in failed. Please try again.')
      setAuthReady(true)
    })
  }, [])

  useEffect(() => {
    if (!authReady || !sessionToken || ownerRoute || ownerInviteRoute || staffLoginRoute || (staffRoute && nativeUser?.tenant_role === 'staff')) return
    let active = true
    setAdminAccess('checking')
    apiFetch(`${API_BASE}/admin/session`, { headers: { Accept: 'application/json' }, cache: 'no-store' })
      .then(response => { if (active) setAdminAccess(response.ok ? 'allowed' : response.status === 403 ? 'forbidden' : 'unavailable') })
      .catch(() => { if (active) setAdminAccess('unavailable') })
    return () => { active = false }
  }, [authReady, sessionToken, ownerRoute, ownerInviteRoute, staffRoute, staffLoginRoute, nativeUser])

  const signOut = () => {
    if (sessionToken === 'native') void fetch(`${API_BASE}/auth/logout`, { method: 'POST', credentials: 'same-origin', headers: { Accept: 'application/json' } }).catch(() => {})
    setApiSessionToken(null); setSessionToken(null); setSessionIdToken(null); setNativeUser(null); setAdminAccess('checking'); setAuthError('')
  }
  const handleNativeAuthenticated = () => {
    if (staffLoginRoute) window.history.replaceState({}, document.title, '/staff')
    setApiSessionToken('native')
    setSessionToken('native')
    setSessionIdToken(null)
    setAuthError('')
    void fetch(`${API_BASE}/auth/session`, { credentials: 'same-origin', headers: { Accept: 'application/json' }, cache: 'no-store' })
      .then(response => response.json())
      .then(payload => {
        if (payload?.authenticated) setNativeUser(payload.user || null)
        setBootstrapAvailable(payload?.bootstrap_available === true)
        setEncryptionReady(payload?.encryption_ready === true)
      })
      .catch(() => {})
  }
  const guestRoute = window.location.pathname.match(/^\/r\/([^/]+)\/([^/]+)\/?$/)
  if (guestRoute) return <GuestMenu slug={decodeURIComponent(guestRoute[1])} token={decodeURIComponent(guestRoute[2])} />
  if (!authReady) return <div className="signin-screen"><div className="signin-card">Completing secure sign-in…</div></div>
  if (staffLoginRoute) return <SignIn role="staff" error={authError} onAuthenticated={handleNativeAuthenticated}/>
  if (sessionToken === 'native' && nativeUser?.tenant_role === 'staff') {
    const membership = nativeUser.memberships?.find(item => item.membership_role === 'staff' && item.staff_role && item.tenant_slug)
    if (!membership) return <div className="signin-screen"><div className="signin-card">Your staff account has no active restaurant assignment. Contact the restaurant owner.</div></div>
    return <StaffPortal slug={membership.tenant_slug} role={membership.staff_role as 'cook' | 'waiter' | 'manager'} displayName={membership.display_name || nativeUser.login_id} onSignOut={signOut}/>
  }
  if (staffRoute && sessionToken === 'native' && nativeUser?.tenant_role === 'owner' && !nativeUser.is_admin) {
    return <OwnerPortal accessToken={sessionToken} apiBaseUrl={API_BASE} onSignOut={signOut}/>
  }
  if (staffRoute && !sessionToken) return <SignIn role="staff" error={authError} onAuthenticated={handleNativeAuthenticated}/>
  if (ownerInviteRoute) {
    return <OwnerInviteAcceptance accessToken={sessionToken || ''} idToken={sessionIdToken || ''} apiBaseUrl={API_BASE} onSignOut={signOut} onAuthenticated={handleNativeAuthenticated} onAccepted={() => { window.history.replaceState({}, document.title, '/owner'); setRouteRefresh(value => value + 1) }}/>
  }
  if (ownerRoute) {
    if (!sessionToken) return <SignIn role="owner" error={authError} onAuthenticated={handleNativeAuthenticated}/>
    return <main className="owner-portal-shell"><header><div className="signin-brand"><div className="signin-mark"><Store size={22}/></div><div><b>platform<span>core</span></b><small>RESTAURANT OWNER</small></div></div><button className="button secondary small" onClick={signOut}>Sign out</button></header><OwnerPortal accessToken={sessionToken} apiBaseUrl={API_BASE} onSignOut={signOut}/></main>
  }
  if (!sessionToken) return <SignIn role="admin" error={authError} bootstrapAvailable={bootstrapAvailable} encryptionReady={encryptionReady} onAuthenticated={handleNativeAuthenticated}/>
  if (adminAccess === 'checking') return <div className="signin-screen"><div className="signin-card">Verifying administrator access…</div></div>
  if (adminAccess !== 'allowed') return <SignIn role="admin" error={adminAccess === 'forbidden' ? 'This identity is not the configured Super Admin.' : 'The administrator API is unavailable or not configured.'} bootstrapAvailable={bootstrapAvailable} encryptionReady={encryptionReady} onAuthenticated={handleNativeAuthenticated}/>


  const sectionLabel = ({ Overview: 'Dashboard', Applications: 'Apps', Owners: 'Subscribers', Communications: 'Messages', 'Update Centre': 'Updates' } as Partial<Record<Section, string>>)[section] || section
  const pageTitle = sectionLabel
  const pageSubtitle = section === 'Overview'
    ? 'Your platform at a glance. Here’s what’s happening today.'
    : section === 'Admin Area' ? 'Platform-wide settings and operational controls.'
    : `Manage your platform’s ${sectionLabel.toLowerCase()}.`

  return (
    <div className="shell">
      <aside className={`sidebar ${menuOpen ? 'sidebar-open' : ''}`}>
        <div className="brand"><div className="brand-mark"><Boxes size={21} /></div><div><strong>platform<span>core</span></strong><small>CONTROL PLANE</small></div><button className="icon-button close-menu" onClick={() => setMenuOpen(false)} aria-label="Close menu"><X size={18}/></button></div>
        <div className="workspace-label">CONTROL PLANE</div>
        <div className="workspace"><div className="workspace-avatar">P</div><div><b>Personal workspace</b><small>Super Admin</small></div><ChevronDown size={15}/></div>
        <div className="nav-label">NAVIGATION</div>
        <nav>{nav.map(item => { const Icon = item.icon; return <button key={item.label} className={`nav-item ${section === item.section ? 'active' : ''}`} onClick={() => { setSection(item.section); setMenuOpen(false) }}><Icon size={18}/><span>{item.label}</span>{item.label === 'Updates' && <i className="nav-dot"/>}</button> })}</nav>
        <div className="sidebar-bottom"><div className="help-card"><div className="help-icon"><LifeBuoy size={17}/></div><b>Need a hand?</b><p>Explore setup guides and platform help.</p><button onClick={() => notify('Help centre will be connected in a later build.')}>Open help centre <ArrowUpRight size={13}/></button></div><div className="profile"><div className="profile-avatar">SG</div><div className="profile-copy"><b>Super Admin</b><small>Owner access</small></div><button className="icon-button" onClick={() => setSection('Admin Area')} aria-label="Account settings"><Settings size={17}/></button></div></div>
      </aside>

      {menuOpen && <button className="scrim" onClick={() => setMenuOpen(false)} aria-label="Close navigation"/>}
      <main className="main">
        <header className="topbar"><button className="icon-button mobile-menu" onClick={() => setMenuOpen(true)} aria-label="Open navigation"><Menu size={20}/></button><div className="breadcrumb">Platform <span>/</span> <b>{sectionLabel}</b></div><div className="top-actions"><div className="environment"><i/> Pre-launch mode</div><button className="icon-button notification" onClick={() => notify('You’re all caught up.')} aria-label="Notifications"><Bell size={18}/><i/></button><button className="button secondary small" onClick={signOut}>Sign out</button></div></header>
        <div className="content">
          <div className="welcome-row"><div><div className="eyebrow">{new Date().toLocaleDateString('en-IN', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' }).toUpperCase()}</div><h1>{pageTitle}</h1><p>{pageSubtitle}</p></div><div className="welcome-actions">{(section === 'Overview' || section === 'Applications') && <button className="button primary" onClick={() => setSection('Applications')}><Plus size={17}/> Add application</button>}{section === 'Admin Area' && <button className="button secondary" onClick={() => setSection('Security')}><Settings size={16}/> Security settings</button>}</div></div>

          {section === 'Overview' && <Overview setSection={setSection}/>}
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
          {section === 'Subscriptions' && <Subscriptions />}
          {section === 'Update Centre' && <UpdateCentre apiBaseUrl={API_BASE}/>}
          {section === 'Data & Backups' && <Placeholder icon={Database} title="Data & backups" description="Production D1 schema is installed. Free Cloudflare D1 Time Travel provides seven-day point-in-time recovery; it is not an offsite backup." items={['Production schema: 50 application tables, migrations 0001–0008','D1 Time Travel: seven-day recovery window on Workers Free','Tenant JSON export, backup validation and guarded restore in Restaurant Data Export','Offsite backup destination and scheduled recovery drills: not configured']}/>}
          {section === 'Monitoring' && <Monitoring />}
          {section === 'Security' && <Placeholder icon={LockKeyhole} title="Security & access" description="Native username/password authentication, TOTP enrollment, recovery codes and server-side session validation are implemented. The initial Super Admin account and encryption secrets still need to be provisioned." items={['OIDC administrator sign-in: verified','MFA and passkey enforcement: pending','Tenant and role authorization: enforced in Worker routes','Administrative audit trail: enabled; immutability not claimed']}/>}
          {section === 'Audit Log' && <AuditLog />}
          {section === 'Admin Area' && <AdminArea setSection={setSection}/>}
          <footer className="footer"><span>Platform Core <b>·</b> v0.1.0 preview</span><span><i className="footer-dot"/> Pre-launch workspace · Production D1 schema installed</span></footer>
        </div>
      </main>

      <nav className="mobile-bottom-nav" aria-label="Primary navigation">
        <button className={section === 'Overview' ? 'active' : ''} onClick={() => setSection('Overview')}><LayoutDashboard size={19}/><span>Home</span></button>
        <button className={section === 'Applications' ? 'active' : ''} onClick={() => setSection('Applications')}><AppWindow size={19}/><span>Apps</span></button>
        <button className={section === 'Owners' ? 'active' : ''} onClick={() => setSection('Owners')}><Users size={19}/><span>People</span></button>
        <button className={section === 'Communications' ? 'active' : ''} onClick={() => setSection('Communications')}><MessageCircle size={19}/><span>Inbox</span></button>
        <button onClick={() => setMenuOpen(true)}><MoreHorizontal size={19}/><span>More</span></button>
      </nav>
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
          <div><b>Cloudflare D1</b><small>Readiness probe: schema + migrations</small></div>
          <span className={`service-status ${tone(databaseStatus)}`}><i/>{label(databaseStatus)}</span>
        </div>
      </div>
      <div className="service-health-footnote">
        {checkedAt ? `Last checked at ${checkedAt}.` : 'Waiting for the first health check.'}
        {databaseStatus === 'not_configured' && ' Apply the Cloudflare D1 migrations to enable database readiness.'}
        {apiStatus === 'unavailable' && ' Start the API and check that the frontend /api proxy is configured.'}
      </div>
    </section>
  )
}

type MilestoneState = 'complete' | 'next' | 'planned'
const projectMilestones: { title: string; state: MilestoneState }[] = [
  { title: 'Platform foundation & API health checks', state: 'complete' },
  { title: 'Shared tenant schema & tenant isolation', state: 'complete' },
  { title: 'Owner identity verification & protected APIs', state: 'complete' },
  { title: 'Audit log and application registry screens', state: 'complete' },
  { title: 'Release manifest validation foundation', state: 'complete' },
  { title: 'Restaurant menu, options, stock & multilingual tools', state: 'complete' },
  { title: 'QR ordering, kitchen queue & waiter workflows', state: 'complete' },
  { title: 'Payments, tax settings & GST invoice foundation', state: 'complete' },
  { title: 'Reports, daily closing & customer reviews', state: 'complete' },
  { title: 'Tenant backup export, validation & restore preflight', state: 'complete' },
  { title: 'Safe owner-only restore & atomic recovery tests', state: 'complete' },
  { title: 'Owner management & subscription controls', state: 'complete' },
  { title: 'Update Centre upload, approval, deployment & rollback workflow', state: 'next' },
  { title: 'Production hosting, identity, storage & monitoring', state: 'complete' },
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
      <p className="project-progress-note">Progress tracks implemented development milestones, not production readiness. Production hosting, identity, D1 schema and live readiness are verified. Approved updates, MFA, offsite backups and end-to-end recovery drills remain launch gates.</p>
    </section>
  )
}

function Overview({ setSection }: { setSection: (s: Section)=>void }) {
  const [apps, setApps] = useState<AppRecord[]>([])
  const [ownerCount, setOwnerCount] = useState<number | null>(null)
  const [activeSubscriptions, setActiveSubscriptions] = useState<number | null>(null)
  const [pendingUpdates, setPendingUpdates] = useState<number | null>(null)
  const [events, setEvents] = useState<OverviewEvent[]>([])
  const [registryState, setRegistryState] = useState<'loading' | 'ready' | 'unavailable'>('loading')

  useEffect(() => {
    let active = true
    Promise.all([
      apiFetch(`${API_BASE}/admin/applications`, { headers: { Accept: 'application/json' }, cache: 'no-store' }),
      apiFetch(`${API_BASE}/admin/owners`, { headers: { Accept: 'application/json' }, cache: 'no-store' }),
      apiFetch(`${API_BASE}/admin/monitoring`, { headers: { Accept: 'application/json' }, cache: 'no-store' }),
      apiFetch(`${API_BASE}/admin/audit-events?limit=5`, { headers: { Accept: 'application/json' }, cache: 'no-store' }),
    ]).then(async ([appsResponse, ownersResponse, monitoringResponse, eventsResponse]) => {
      if (![appsResponse, ownersResponse, monitoringResponse, eventsResponse].every(response => response.ok)) throw new Error('Live workspace data is not ready.')
      const [appsData, ownersData, monitoringData, eventsData] = await Promise.all([
        appsResponse.json(), ownersResponse.json(), monitoringResponse.json(), eventsResponse.json(),
      ])
      if (!active) return
      if (!Array.isArray(appsData.applications) || !Array.isArray(ownersData.owners) || !monitoringData.counts || !Array.isArray(eventsData.events)) {
        throw new Error('The platform API returned an incomplete workspace response.')
      }
      const categories: Record<string, string> = { restaurant: 'Food & hospitality', inventory: 'Operations', workforce: 'People & teams' }
      const tones = ['violet', 'blue', 'orange']
      setApps(appsData.applications.map((app: { id: string; app_key: string; name: string; status: string }, index: number) => ({
        id: app.id,
        name: app.name,
        category: categories[app.app_key] || 'Platform application',
        status: app.status === 'active' ? 'Active' : app.status === 'paused' ? 'Paused' : 'Draft',
        initials: app.name.slice(0, 2).toUpperCase(),
        tone: tones[index % tones.length],
      })))
      setOwnerCount(ownersData.owners.filter((owner: { owner_present: boolean; membership_status: string | null; tenant_status: string }) => owner.owner_present && owner.membership_status === 'active' && owner.tenant_status === 'active').length)
      setActiveSubscriptions(Number(monitoringData.counts.active_subscriptions || 0))
      setPendingUpdates(Number(monitoringData.counts.releases_awaiting_review || 0))
      setEvents(eventsData.events)
      setRegistryState('ready')
    }).catch(() => {
      if (active) setRegistryState('unavailable')
    })
    return () => { active = false }
  }, [])

  const liveValue = (value: number | null) => registryState === 'ready' && value !== null ? String(value).padStart(2, '0') : '—'
  const stats = [
    { label: 'Applications', value: liveValue(apps.length), detail: registryState === 'ready' ? 'Live application registry' : 'Awaiting live database schema', icon: AppWindow, tint: 'purple' },
    { label: 'Owners', value: liveValue(ownerCount), detail: registryState === 'ready' ? 'Active tenant owners' : 'Awaiting live database schema', icon: Users, tint: 'blue' },
    { label: 'Active subscriptions', value: liveValue(activeSubscriptions), detail: 'Live subscription records', icon: CreditCard, tint: 'green' },
    { label: 'Pending updates', value: liveValue(pendingUpdates), detail: 'Releases awaiting review', icon: FileCheck2, tint: 'orange' },
  ]
  return <>
    <ServiceHealth />
    <ProjectProgress />
    <div className="stat-grid">{stats.map(s=>{const Icon=s.icon;return <div className="stat-card" key={s.label}><div className="stat-top"><span>{s.label}</span><div className={`stat-icon ${s.tint}`}><Icon size={17}/></div></div><strong>{s.value}</strong><small>{s.detail}</small></div>})}</div>
    <div className="overview-grid"><section className="panel apps-panel"><div className="panel-heading"><div><h2>Applications</h2><p>Products registered in the live workspace.</p></div><button className="text-button" onClick={()=>setSection('Applications')}>View all <ArrowUpRight size={14}/></button></div>
      {registryState === 'loading' && <div className="empty-activity"><b>Loading live workspace data…</b></div>}
      {registryState === 'unavailable' && <div className="empty-activity"><b>Live registry not ready</b><p>The production D1 schema must be migrated and verified before real application data can be displayed.</p></div>}
      {registryState === 'ready' && (apps.length === 0 ? <div className="empty-activity"><b>No applications registered</b><p>Register an application to populate this workspace.</p></div> : <div className="app-list">{apps.slice(0,4).map(app=><div className="app-row" key={app.id}><div className={`app-icon ${app.tone}`}>{app.initials}</div><div className="app-info"><b>{app.name}</b><small>{app.category}</small></div><span className={`status ${app.status.toLowerCase()}`}>{app.status}</span></div>)}</div>)}
      <button className="add-row" onClick={()=>setSection('Applications')}><Plus size={16}/> Manage applications</button></section>
      <section className="panel activity-panel"><div className="panel-heading"><div><h2>Platform activity</h2><p>Recent audited events from your workspace.</p></div><button className="icon-button" onClick={()=>setSection('Audit Log')} aria-label="View audit log"><MoreHorizontal size={18}/></button></div>
        {registryState === 'ready' && events.length > 0 ? <div className="monitoring-event-list">{events.map(event=><div className="monitoring-event" key={event.id}><div><b>{event.action}</b><small>{event.resource_type} · {new Date(event.created_at).toLocaleString('en-IN')}</small></div></div>)}</div> : <div className="empty-activity"><div className="empty-icon"><Activity size={21}/></div><b>{registryState === 'ready' ? 'No activity yet' : 'Activity data unavailable'}</b><p>{registryState === 'ready' ? 'Audited platform actions will appear here.' : 'Activity will appear after the first audited workspace action.'}</p></div>}
      </section></div>
    <section className="panel setup-panel"><div className="setup-title"><div><span className="eyebrow">GETTING STARTED</span><h2>Set up your platform</h2><p>Complete these foundations before onboarding customers.</p></div><div className="setup-progress"><strong>3/5</strong><small>foundations verified</small></div></div><div className="setup-steps">
      <div className="setup-step done"><div className="step-check"><Check size={14}/></div><div><b>Workspace created</b><small>Your private control plane is ready.</small></div><span>Done</span></div>
      <button className="setup-step" onClick={()=>setSection('Security')}><div className="step-number"/><div><b>Secure administrator sign-in</b><small>OIDC sign-in is working; configure MFA before customer onboarding.</small></div><span>MFA pending</span><ArrowUpRight size={15}/></button>
      <div className="setup-step done"><div className="step-check"><Check size={14}/></div><div><b>Register your first application</b><small>Restaurant Suite is registered and active.</small></div><span>Done</span></div>
      <div className="setup-step done"><div className="step-check"><Check size={14}/></div><div><b>Connect the platform database</b><small>Production D1 schema and live readiness checks passed.</small></div><span>Done</span></div>
      <button className="setup-step" onClick={()=>setSection('Data & Backups')}><div className="step-number"/><div><b>Configure backup and recovery</b><small>D1 Time Travel is available for seven days; offsite backup is still needed.</small></div><span>Pending</span><ArrowUpRight size={15}/></button>
    </div></section>
    <div className="notice-strip"><div className="notice-symbol"><Zap size={17}/></div><div><b>Pre-launch workspace is active</b><p>Administrator sign-in, API health and the production D1 schema are connected. Live workspace records are loaded from D1. Complete offsite backup and recovery checks before customer onboarding.</p></div><button onClick={()=>setSection('Data & Backups')}>View setup <ArrowUpRight size={13}/></button></div>
  </>
}

function AdminArea({ setSection }: { setSection: (s: Section) => void }) {
  const tools: { title: string; description: string; section: Section; icon: typeof Settings }[] = [
    { title: 'Security & access', description: 'Administrator identity, MFA and access controls.', section: 'Security', icon: LockKeyhole },
    { title: 'Data & backups', description: 'Database health, exports and recovery readiness.', section: 'Data & Backups', icon: Database },
    { title: 'Monitoring', description: 'Service health, platform metrics and incidents.', section: 'Monitoring', icon: Activity },
    { title: 'Audit log', description: 'Review important administrative actions.', section: 'Audit Log', icon: ScrollText },
    { title: 'Data export', description: 'Export and validate tenant data when required.', section: 'Restaurant Data Export', icon: Download },
  ]
  return <section className="admin-hub">
    <div className="admin-hub-intro panel"><span className="eyebrow">CONTROL PLANE SETTINGS</span><h2>Administration</h2><p>Platform-wide controls live here. Restaurant operations such as menu, tables and QR codes belong inside each restaurant workspace—not in Super Admin navigation.</p></div>
    <div className="admin-hub-grid">{tools.map(tool => { const Icon = tool.icon; return <button className="admin-hub-card panel" key={tool.section} onClick={() => setSection(tool.section)}><span className="admin-hub-icon"><Icon size={20}/></span><span><b>{tool.title}</b><small>{tool.description}</small></span><ArrowUpRight size={17}/></button> })}</div>
  </section>
}

function Placeholder({ icon: Icon, title, description, items }: { icon: typeof Users; title: string; description: string; items: string[] }) {
  return <section className="panel feature-panel"><div className="feature-icon"><Icon size={23}/></div><div className="feature-copy"><span className="eyebrow">PLATFORM MODULE</span><h2>{title}</h2><p>{description}</p></div><div className="feature-list">{items.map((item,i)=><div key={item}><span className="feature-number">0{i+1}</span><b>{item}</b><span className="coming">Planned</span></div>)}</div><div className="feature-note"><CircleHelp size={16}/> This module is in the implementation roadmap. No live customer data or actions are connected yet.</div></section>
}

export default App