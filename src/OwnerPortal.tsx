import { useCallback, useEffect, useState } from 'react'
import { AlertCircle, BarChart3, Building2, CheckCircle2, ChefHat, LogOut, Menu as MenuIcon, QrCode, RefreshCw, Settings, Star, Store, Utensils, Users, X } from 'lucide-react'
import OwnerCommunications from './OwnerCommunications'
import { apiFetch } from './auth'
import RestaurantMenu from './RestaurantMenu'
import RestaurantTables from './RestaurantTables'
import RestaurantOperations from './RestaurantOperations'
import RestaurantSettings from './RestaurantSettings'
import RestaurantReports from './RestaurantReports'
import RestaurantReviews from './RestaurantReviews'
import OwnerStaff from './OwnerStaff'

type Restaurant = {
  tenant_id: string
  tenant_name: string
  tenant_slug: string
  tenant_status: string
  role: string
  display_name: string | null
  city: string | null
  state_name: string | null
  currency_code: string | null
  timezone: string | null
  accepting_orders: boolean | null
}

type Props = { accessToken: string; apiBaseUrl?: string; onSignOut?: () => void }
type OwnerTool = 'menu' | 'tables' | 'operations' | 'settings' | 'reports' | 'reviews' | 'staff'
const ownerTools: { id: OwnerTool; label: string; icon: typeof Store }[] = [
  { id: 'menu', label: 'Menu', icon: Utensils }, { id: 'tables', label: 'Tables & QR', icon: QrCode },
  { id: 'operations', label: 'Kitchen & service', icon: ChefHat }, { id: 'settings', label: 'Settings', icon: Settings },
  { id: 'reports', label: 'Reports', icon: BarChart3 }, { id: 'reviews', label: 'Reviews', icon: Star }, { id: 'staff', label: 'Staff access', icon: Users },
]

export default function OwnerPortal({ accessToken, apiBaseUrl = '/api', onSignOut }: Props) {
  const base = apiBaseUrl.replace(/\/$/, '')
  const [restaurants, setRestaurants] = useState<Restaurant[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState('')
  const [selectedSlug, setSelectedSlug] = useState('')
  const [activeTool, setActiveTool] = useState<OwnerTool>('menu')
  const [mobileNavOpen, setMobileNavOpen] = useState(false)
  const selectedRestaurant = restaurants.find(item => item.tenant_slug === selectedSlug)

  const load = useCallback(async () => {
    if (!accessToken) return
    setRefreshing(true)
    setError('')
    try {
      const wantsDemo = new URLSearchParams(window.location.search).get('demo') === '1'
      if (wantsDemo) {
        // Reuse an already-provisioned demo before attempting to seed it again.
        // Re-running the full 365-day demo seed on every visit is unnecessary
        // and could make a healthy existing demo appear unavailable on retries.
        const existingResponse = await apiFetch(base + '/owner/restaurants', {
          headers: { Accept: 'application/json' },
          credentials: 'same-origin',
          cache: 'no-store',
        })
        const existingPayload = await existingResponse.json().catch(() => ({}))
        const existingRestaurants = Array.isArray(existingPayload.restaurants) ? existingPayload.restaurants as Restaurant[] : []
        if (existingResponse.ok && existingRestaurants.some(item => item.tenant_slug === 'platform-demo-restaurant')) {
          setRestaurants(existingRestaurants)
          setSelectedSlug('platform-demo-restaurant')
          setActiveTool('menu')
          return
        }

        const provision = await apiFetch(base + '/admin/demo-restaurant/provision', {
          method: 'POST',
          headers: { Accept: 'application/json' },
          credentials: 'same-origin',
          cache: 'no-store',
        })
        const provisionPayload = await provision.json().catch(() => ({})) as { error?: string; detail?: string }
        if (!provision.ok) {
          const reason = [provisionPayload.error || 'The demo restaurant could not be prepared.', provisionPayload.detail].filter(Boolean).join(': ')
          throw new Error(reason)
        }
      }
      const response = await apiFetch(base + '/owner/restaurants', {
        headers: { Accept: 'application/json' },
        credentials: 'same-origin',
        cache: 'no-store',
      })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(payload.error || 'Your restaurant list could not be loaded.')
      const nextRestaurants = Array.isArray(payload.restaurants) ? payload.restaurants : []
      setRestaurants(nextRestaurants)
      if (new URLSearchParams(window.location.search).get('demo') === '1' &&
          nextRestaurants.some((item: Restaurant) => item.tenant_slug === 'platform-demo-restaurant')) {
        setSelectedSlug('platform-demo-restaurant')
        setActiveTool('menu')
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Your restaurant list could not be loaded.')
      setRestaurants([])
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [accessToken, base])

  useEffect(() => { void load() }, [load])

  return <div className="owner-portal-content">
    <section className="owner-home panel" aria-live="polite">
      <div className="owner-home-heading">
        <div><span className="owner-comms-kicker">OWNER WORKSPACE</span><h1>Your restaurants</h1><p>Active restaurants connected to your owner account.</p></div>
        <div className="owner-home-heading-actions"><button type="button" onClick={() => void load()} disabled={refreshing} aria-label="Refresh restaurants"><RefreshCw size={17} className={refreshing ? 'owner-comms-spin' : ''}/></button>{onSignOut && <button type="button" onClick={onSignOut} aria-label="Sign out"><LogOut size={16}/></button>}</div>
      </div>
      {loading ? <div className="owner-home-state">Loading your restaurant memberships…</div> :
      error ? <div className="owner-home-error"><AlertCircle size={17}/><span>{error}</span></div> :
      restaurants.length === 0 ? <div className="owner-home-state"><Building2 size={24}/><b>No active restaurant memberships</b><p>When the platform administrator invites you as a restaurant owner, your restaurant will appear here.</p></div> :
      <div className="owner-home-grid">{restaurants.map(restaurant => <article className="owner-home-card" key={restaurant.tenant_id}>
        <div className="owner-home-card-top"><span className="owner-home-icon"><Store size={19}/></span><span className="owner-home-status"><CheckCircle2 size={13}/> Active</span></div>
        <h2>{restaurant.display_name || restaurant.tenant_name}</h2>
        <p>{[restaurant.city, restaurant.state_name].filter(Boolean).join(', ') || 'Restaurant location not configured'}</p>
        <div className="owner-home-meta"><span>Account role</span><b>{restaurant.role}</b></div>
        <div className="owner-home-meta"><span>Ordering</span><b>{restaurant.accepting_orders === null ? 'Not configured' : restaurant.accepting_orders ? 'Accepting orders' : 'Paused'}</b></div>
        <div className="owner-home-meta"><span>Currency</span><b>{restaurant.currency_code || 'Not configured'}</b></div>
        <small className="owner-home-slug">{restaurant.tenant_slug}</small>
        <button type="button" className="owner-home-open" onClick={() => { setSelectedSlug(restaurant.tenant_slug); setActiveTool('menu') }}>Open restaurant workspace</button>
      </article>)}</div>}
      {error && <button type="button" className="owner-home-retry" onClick={() => void load()}>Try again</button>}
    </section>
    {selectedRestaurant && <section className="owner-workspace">
      <div className="owner-workspace-heading"><div><span className="owner-comms-kicker">RESTAURANT WORKSPACE</span><h2>{selectedRestaurant.display_name || selectedRestaurant.tenant_name}</h2><p>Changes are saved to this restaurant's live workspace.</p></div><button type="button" className="owner-workspace-back" onClick={() => setSelectedSlug('')}>Back to restaurants</button></div>
      <div className="owner-workspace-layout">
        <button type="button" className="owner-mobile-nav-toggle" onClick={() => setMobileNavOpen(value => !value)} aria-expanded={mobileNavOpen}><MenuIcon size={17}/>{ownerTools.find(tool => tool.id === activeTool)?.label}<span>Navigate</span></button>
        {mobileNavOpen && <button type="button" className="owner-workspace-scrim" aria-label="Close navigation" onClick={() => setMobileNavOpen(false)}/>} 
        <aside className={"owner-workspace-sidebar " + (mobileNavOpen ? "open" : "")} aria-label="Restaurant workspace navigation">
          <div className="owner-workspace-sidebar-title"><span>WORKSPACE MENU</span><button type="button" onClick={() => setMobileNavOpen(false)} aria-label="Close menu"><X size={17}/></button></div>
          <nav>{ownerTools.map(tool => { const Icon = tool.icon; return <button type="button" key={tool.id} className={activeTool === tool.id ? "active" : ""} onClick={() => { setActiveTool(tool.id); setMobileNavOpen(false) }}><Icon size={17}/><span>{tool.label}</span></button> })}</nav>
        </aside>
        <div className="owner-workspace-main">
          {activeTool === 'menu' && <RestaurantMenu initialSlug={selectedSlug}/>}
          {activeTool === 'tables' && <RestaurantTables initialSlug={selectedSlug}/>}
          {activeTool === 'operations' && <RestaurantOperations initialSlug={selectedSlug}/>}
          {activeTool === 'settings' && <RestaurantSettings initialSlug={selectedSlug}/>}
          {activeTool === 'reports' && <RestaurantReports initialSlug={selectedSlug}/>}
          {activeTool === 'reviews' && <RestaurantReviews initialSlug={selectedSlug}/>}
          {activeTool === 'staff' && <OwnerStaff tenantId={selectedRestaurant.tenant_id} apiBaseUrl={apiBaseUrl} demoMode={selectedSlug === 'platform-demo-restaurant'}/>}
        </div>
      </div>
    </section>}
    <OwnerCommunications accessToken={accessToken} apiBaseUrl={apiBaseUrl}/>
  </div>
}
