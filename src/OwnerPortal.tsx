import { useCallback, useEffect, useState } from 'react'
import { AlertCircle, Building2, CheckCircle2, RefreshCw, Store } from 'lucide-react'
import OwnerCommunications from './OwnerCommunications'

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

type Props = { accessToken: string; apiBaseUrl?: string }

export default function OwnerPortal({ accessToken, apiBaseUrl = '/api' }: Props) {
  const base = apiBaseUrl.replace(/\/$/, '')
  const [restaurants, setRestaurants] = useState<Restaurant[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    if (!accessToken) return
    setRefreshing(true)
    setError('')
    try {
      const response = await fetch(base + '/owner/restaurants', {
        headers: { Accept: 'application/json', Authorization: 'Bearer ' + accessToken },
        cache: 'no-store',
      })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(payload.error || 'Your restaurant list could not be loaded.')
      setRestaurants(Array.isArray(payload.restaurants) ? payload.restaurants : [])
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
        <button type="button" onClick={() => void load()} disabled={refreshing} aria-label="Refresh restaurants"><RefreshCw size={17} className={refreshing ? 'owner-comms-spin' : ''}/></button>
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
      </article>)}</div>}
      {error && <button type="button" className="owner-home-retry" onClick={() => void load()}>Try again</button>}
    </section>
    <OwnerCommunications accessToken={accessToken} apiBaseUrl={apiBaseUrl}/>
  </div>
}
