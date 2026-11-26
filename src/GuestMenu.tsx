import { useEffect, useMemo, useRef, useState } from 'react'
import { BellRing, CheckCircle2, ChevronRight, Clock3, Droplets, Minus, Plus, ReceiptText, ShoppingBag, Utensils, X } from 'lucide-react'

const API_BASE = (import.meta.env.VITE_API_BASE_URL || '/api').replace(/\/$/, '')
type Localized = string | Record<string, string> | null | undefined
type Addon = { id: string; name: Localized; price_minor: number | string; available: boolean }
type AddonGroup = { id: string; name: Localized; required: boolean; min_pick: number; max_pick: number; addons: Addon[] }
type Variant = { id: string; name: Localized; price_minor: number | string; available: boolean }
type MenuItem = {
  id: string; name: Localized; description: Localized; base_price_minor: number | string
  food_type: 'veg' | 'non_veg' | 'egg'; available: boolean; photo_url?: string | null
  prep_minutes?: number; variants: Variant[]; addon_groups: AddonGroup[]
}
type Category = { id: string; name: Localized; items: MenuItem[] }
type MenuPayload = {
  restaurant: { display_name?: string; currency_code?: string; default_language?: string; accepting_orders?: boolean } | null
  table: { label: string; table_type: string }
  session: { id: string; status: string } | null
  categories: Category[]
}
type CartLine = { key: string; item: MenuItem; variantId: string | null; addonIds: string[]; quantity: number }

function localized(value: Localized, language: string) {
  if (typeof value === 'string') return value
  if (!value) return ''
  return value[language] || value.en || value.hi || value.kn || value.ta || value.te || value.ml || ''
}
function money(value: number | string, currency = 'INR') {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency, maximumFractionDigits: 2 }).format(Number(value || 0) / 100)
}
function errorText(code: string) {
  const messages: Record<string, string> = {
    table_session_not_open: 'Please ask your server to open this table before placing an order.',
    restaurant_not_accepting_orders: 'This restaurant is not accepting orders right now.',
    order_rate_limited: 'Please wait a moment before placing another order.',
    no_orderable_items: 'These items are no longer available. Please refresh the menu.',
    qr_not_found: 'This QR code is invalid or has been deactivated.',
  }
  return messages[code] || 'Something went wrong. Please try again or ask your server for help.'
}

export default function GuestMenu({ slug, token }: { slug: string; token: string }) {
  const [menu, setMenu] = useState<MenuPayload | null>(null)
  const [language, setLanguage] = useState('en')
  const [activeCategory, setActiveCategory] = useState('')
  const categoryScrollLock = useRef(false)
  const categoryUnlockTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [selected, setSelected] = useState<MenuItem | null>(null)
  const [variantId, setVariantId] = useState('')
  const [addonIds, setAddonIds] = useState<string[]>([])
  const [selectedQuantity, setSelectedQuantity] = useState(1)
  const [cart, setCart] = useState<CartLine[]>([])
  const [cartOpen, setCartOpen] = useState(false)
  const [sending, setSending] = useState(false)
  const [notice, setNotice] = useState('')
  const [placed, setPlaced] = useState<{ id: string; number: number | string; total: number | string } | null>(null)
  const [orderStatus, setOrderStatus] = useState('new')
  const [lastOpenSessionId, setLastOpenSessionId] = useState('')
  const [reviewSessionId, setReviewSessionId] = useState('')
  const [reviewRating, setReviewRating] = useState(5)
  const [reviewComment, setReviewComment] = useState('')
  const [reviewSending, setReviewSending] = useState(false)
  const [reviewSubmitted, setReviewSubmitted] = useState(false)
  const [reviewError, setReviewError] = useState('')

  async function loadReviewEligibility() {
    try {
      const response = await fetch(`${API_BASE}/restaurant/${encodeURIComponent(slug)}/guest/${encodeURIComponent(token)}/reviews`, { headers: { Accept: 'application/json' } })
      if (!response.ok) return
      const body = await response.json()
      setReviewSessionId(body.review_session?.id || '')
    } catch { /* review availability is optional; keep the menu usable */ }
  }

  async function loadMenu() {
    setLoading(true)
    setLoadError('')
    try {
      const response = await fetch(`${API_BASE}/restaurant/${encodeURIComponent(slug)}/guest/${encodeURIComponent(token)}/menu`, { headers: { Accept: 'application/json' } })
      const body = await response.json()
      if (!response.ok) throw new Error(body.error || 'menu_unavailable')
      setMenu(body)
      if (body.session?.id) setLastOpenSessionId(body.session.id)
      else await loadReviewEligibility()
      setLanguage(body.restaurant?.default_language || 'en')
      setActiveCategory(current => current || body.categories?.[0]?.id || '')
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : 'menu_unavailable')
    } finally {
      setLoading(false)
    }
  }


  function selectCategory(id: string) {
    setActiveCategory(id)
    categoryScrollLock.current = true
    if (categoryUnlockTimer.current) clearTimeout(categoryUnlockTimer.current)
    document.querySelector<HTMLElement>(`[data-category-section="${CSS.escape(id)}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    categoryUnlockTimer.current = setTimeout(() => { categoryScrollLock.current = false }, 1200)
  }

  useEffect(() => { void loadMenu() }, [slug, token])

  useEffect(() => {
    const pollSession = async () => {
      try {
        const response = await fetch(`${API_BASE}/restaurant/${encodeURIComponent(slug)}/guest/${encodeURIComponent(token)}/menu`, { headers: { Accept: 'application/json' } })
        if (!response.ok) return
        const body = await response.json()
        if (body.session?.id) setLastOpenSessionId(body.session.id)
        else await loadReviewEligibility()
        setMenu(body)
      } catch { /* keep the last known table state visible */ }
    }
    const timer = window.setInterval(() => void pollSession(), 15000)
    return () => window.clearInterval(timer)
  }, [slug, token])

  useEffect(() => {
    if (!placed) return
    const refresh = async () => {
      try {
        const response = await fetch(`${API_BASE}/restaurant/${encodeURIComponent(slug)}/guest/${encodeURIComponent(token)}/orders/${placed.id}`)
        if (!response.ok) return
        const body = await response.json()
        setOrderStatus(body.order?.status || 'new')
      } catch { /* keep the last known status visible */ }
    }
    void refresh()
    const timer = window.setInterval(() => void refresh(), 12000)
    return () => window.clearInterval(timer)
  }, [placed, slug, token])

  const currency = menu?.restaurant?.currency_code || 'INR'
  const categories = menu?.categories || []

  useEffect(() => {
    if (!categories.length) return
    const sections = Array.from(document.querySelectorAll<HTMLElement>('[data-category-section]'))
    if (!sections.length) return
    let scheduled = false
    const updateActiveCategory = () => {
      if (categoryScrollLock.current || scheduled) return
      scheduled = true
      window.requestAnimationFrame(() => {
        scheduled = false
        if (categoryScrollLock.current) return
        const headerHeight = document.querySelector('.guest-header')?.getBoundingClientRect().height || 0
        const categoryHeight = document.querySelector('.guest-categories')?.getBoundingClientRect().height || 0
        const activeLine = Math.max(headerHeight + categoryHeight + 12, window.innerHeight * 0.4)
        let current = categories[0]?.id || ''
        for (const section of sections) {
          if (section.getBoundingClientRect().top <= activeLine) current = section.getAttribute('data-category-section') || current
          else break
        }
        if (current) setActiveCategory(current)
      })
    }
    updateActiveCategory()
    window.addEventListener('scroll', updateActiveCategory, { passive: true })
    window.addEventListener('resize', updateActiveCategory)
    return () => {
      window.removeEventListener('scroll', updateActiveCategory)
      window.removeEventListener('resize', updateActiveCategory)
    }
  }, [categories])
  const cartCount = cart.reduce((sum, line) => sum + line.quantity, 0)
  const cartTotal = useMemo(() => cart.reduce((sum, line) => {
    const variant = line.item.variants.find(value => value.id === line.variantId)
    const addons = line.item.addon_groups.flatMap(group => group.addons).filter(addon => line.addonIds.includes(addon.id))
    const unit = Number(variant?.price_minor ?? line.item.base_price_minor) + addons.reduce((n, addon) => n + Number(addon.price_minor), 0)
    return sum + unit * line.quantity
  }, 0), [cart])

  function openItem(item: MenuItem) {
    setSelected(item)
    setVariantId(item.variants.find(value => value.available)?.id || '')
    setAddonIds([])
    setSelectedQuantity(1)
    setNotice('')
  }
  function toggleAddon(id: string, group: AddonGroup) {
    setAddonIds(current => {
      const exists = current.includes(id)
      if (exists) return current.filter(value => value !== id)
      const selectedInGroup = current.filter(value => group.addons.some(addon => addon.id === value))
      if (selectedInGroup.length >= group.max_pick) return current
      return [...current, id]
    })
  }
  function addSelected() {
    if (!selected) return
    if (selected.variants.some(value => value.available) && !variantId) { setNotice('Choose an option to continue.'); return }
    for (const group of selected.addon_groups) {
      if (!group.addons.some(addon => addon.available)) continue
      const count = addonIds.filter(id => group.addons.some(addon => addon.id === id)).length
      const minimum = group.required ? Math.max(1, group.min_pick) : group.min_pick
      if (count < minimum || count > group.max_pick) {
        setNotice(`Choose ${minimum === group.max_pick ? minimum : `at least ${minimum}`} from ${localized(group.name, language)}.`)
        return
      }
    }
    const key = [selected.id, variantId, [...addonIds].sort().join(',')].join(':')
    setCart(current => {
      const found = current.find(line => line.key === key)
      return found
        ? current.map(line => line.key === key ? { ...line, quantity: line.quantity + selectedQuantity } : line)
        : [...current, { key, item: selected, variantId: variantId || null, addonIds: [...addonIds], quantity: selectedQuantity }]
    })
    setSelected(null)
    setSelectedQuantity(1)
    setNotice('')
  }
  function changeQuantity(key: string, delta: number) {
    setCart(current => current.flatMap(line => line.key !== key ? [line] : line.quantity + delta <= 0 ? [] : [{ ...line, quantity: line.quantity + delta }]))
  }

  async function placeOrder() {
    if (!menu?.session?.id || !cart.length || sending) return
    setSending(true)
    setNotice('')
    try {
      const response = await fetch(`${API_BASE}/restaurant/${encodeURIComponent(slug)}/guest/${encodeURIComponent(token)}/orders`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          session_id: menu.session.id,
          idempotency_key: crypto.randomUUID(),
          items: cart.map(line => ({ item_id: line.item.id, quantity: line.quantity, ...(line.variantId ? { variant_id: line.variantId } : {}), addon_ids: line.addonIds })),
        }),
      })
      const body = await response.json()
      if (!response.ok) throw new Error(body.error || 'order_placement_failed')
      setPlaced({ id: body.order.id, number: body.order.order_number, total: body.order.total_minor })
      setOrderStatus(body.order.status || 'new')
      setCart([])
      setCartOpen(false)
    } catch (error) {
      setNotice(errorText(error instanceof Error ? error.message : 'order_placement_failed'))
    } finally {
      setSending(false)
    }
  }

  async function submitReview() {
    const sessionId = reviewSessionId || lastOpenSessionId
    if (!sessionId || reviewSending || reviewSubmitted) return
    setReviewSending(true); setReviewError('')
    try {
      const response = await fetch(`${API_BASE}/restaurant/${encodeURIComponent(slug)}/guest/${encodeURIComponent(token)}/reviews`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ session_id: sessionId, rating: reviewRating, comment: reviewComment.trim() }),
      })
      const body = await response.json()
      if (!response.ok) throw new Error(body.error || 'review_failed')
      setReviewSubmitted(true)
    } catch (error) {
      const code = error instanceof Error ? error.message : 'review_failed'
      setReviewError(code === 'duplicate_or_conflicting_request' ? 'A review has already been submitted for this visit.' : code === 'review_available_after_session_close' ? 'You can review after your table session is closed.' : 'Your review could not be sent. Please try again.')
    } finally { setReviewSending(false) }
  }

  async function callWaiter(requestType: 'call_waiter' | 'need_water' | 'request_bill') {
    if (!menu?.session?.id) { setNotice('Please ask your server for assistance.'); return }
    try {
      const response = await fetch(`${API_BASE}/restaurant/${encodeURIComponent(slug)}/guest/${encodeURIComponent(token)}/requests`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: menu.session.id, request_type: requestType }),
      })
      if (!response.ok) throw new Error('request_failed')
      setNotice(requestType === 'call_waiter' ? 'Your server has been notified.' : requestType === 'need_water' ? 'Your water request has been sent.' : 'Your bill request has been sent.')
    } catch { setNotice('Could not send your request. Please ask a server.') }
  }

  if (loading) return <div className="guest-screen"><div className="guest-state"><div className="guest-spinner"/><b>Loading menu…</b><span>Please wait a moment</span></div></div>
  if (loadError || !menu) return <div className="guest-screen"><div className="guest-state"><div className="guest-state-icon">!</div><h2>Menu unavailable</h2><p>{errorText(loadError)}</p><button className="guest-primary" onClick={() => void loadMenu()}>Try again</button></div></div>

  if (placed) return <div className="guest-screen"><div className="guest-success"><div className="guest-success-icon"><CheckCircle2 size={34}/></div><span className="guest-kicker">ORDER PLACED</span><h1>Thank you!</h1><p>Your order has been sent to the kitchen.</p><div className="guest-order-card"><small>ORDER NUMBER</small><strong>#{placed.number}</strong><div><span>Status</span><b>{orderStatus.replace(/_/g, ' ')}</b></div><div><span>Order total</span><b>{money(placed.total, currency)}</b></div></div><button className="guest-primary" onClick={() => setPlaced(null)}>Back to menu</button><p className="guest-muted">Please keep this page open to follow your order.</p></div></div>

  return (
    <div className="guest-screen">
      <header className="guest-header">
        <div className="guest-brand"><div className="guest-brand-mark"><Utensils size={19}/></div><div><b>{menu.restaurant?.display_name || 'Restaurant'}</b><span>{menu.table?.label || 'Guest menu'}</span></div></div>
        <select aria-label="Menu language" value={language} onChange={event => setLanguage(event.target.value)}><option value="en">English</option><option value="hi">हिन्दी</option><option value="kn">ಕನ್ನಡ</option><option value="ta">தமிழ்</option><option value="te">తెలుగు</option><option value="ml">മലയാളം</option></select>
      </header>
      <section className="guest-welcome"><span className="guest-kicker">WELCOME</span><h1>What would you like today?</h1><p>Browse the menu and add your favourites to the order.</p><div className="guest-table-pill"><span/> {menu.table?.label || 'Your table'} {menu.session ? '· Service is open' : '· Waiting for service'}</div></section>
      {!menu.session && (reviewSessionId || lastOpenSessionId) && <section className="guest-review-card" aria-label="Share your feedback">
        {reviewSubmitted ? <><b>Thank you for your feedback!</b><p>Your review has been received.</p></> : <>
          <span className="guest-kicker">HOW WAS YOUR VISIT?</span><h2>Rate your experience</h2><p>Your feedback helps this restaurant improve.</p>
          <div className="guest-review-stars" role="group" aria-label="Rating from one to five stars">
            {[1,2,3,4,5].map(value=><button type="button" key={value} className={value<=reviewRating?'selected':''} aria-label={`${value} star${value===1?'':'s'}`} aria-pressed={reviewRating===value} onClick={()=>setReviewRating(value)}>★</button>)}
          </div>
          <textarea maxLength={1000} rows={3} value={reviewComment} onChange={event=>setReviewComment(event.target.value)} placeholder="Tell us about your experience (optional)"/>
          {reviewError && <p className="guest-form-error" role="alert">{reviewError}</p>}
          <button className="guest-primary" disabled={reviewSending} onClick={()=>void submitReview()}>{reviewSending?'Sending review…':'Submit review'}</button>
        </>}
      </section>}
      <div className="guest-quick-actions" aria-label="Table service requests"><button className="guest-service-action waiter" onClick={() => void callWaiter('call_waiter')}><BellRing size={17}/><span>Call waiter</span></button><button className="guest-service-action water" onClick={() => void callWaiter('need_water')}><Droplets size={17}/><span>Request water</span></button><button className="guest-service-action bill" onClick={() => void callWaiter('request_bill')}><ReceiptText size={17}/><span>Request bill</span></button></div>
      {notice && <div className="guest-notice" role="status">{notice}<button onClick={() => setNotice('')} aria-label="Dismiss"><X size={15}/></button></div>}
      <nav className="guest-categories" aria-label="Menu categories">{categories.map(category => <button key={category.id} type="button" className={activeCategory === category.id ? 'active' : ''} aria-current={activeCategory === category.id ? 'location' : undefined} onClick={() => selectCategory(category.id)}>{localized(category.name, language)}</button>)}</nav>
      <main className="guest-menu-list">
        {categories.map(category => <section className="guest-category-section" data-category-section={category.id} key={category.id}>
          <div className="guest-section-title"><div><span className="guest-kicker">OUR MENU</span><h2>{localized(category.name, language)}</h2></div><span>{category.items?.length || 0} items</span></div>
          {(category.items || []).map(item => { const quantity = cart.filter(line => line.item.id === item.id).reduce((sum, line) => sum + line.quantity, 0); const firstLine = cart.find(line => line.item.id === item.id); return <article className={`guest-item ${!item.available ? 'unavailable' : ''}`} key={item.id}>
            {item.photo_url ? <img className="guest-item-photo" src={item.photo_url} alt={localized(item.name, language)} loading="lazy"/> : <div className="guest-item-photo guest-photo-placeholder"><Utensils size={23}/></div>}
            <div className="guest-item-info"><div className="guest-food-tag"><i className={item.food_type === 'non_veg' ? 'nonveg' : item.food_type === 'egg' ? 'egg' : ''}/>{item.food_type === 'non_veg' ? 'NON-VEG' : item.food_type === 'egg' ? 'EGG' : 'VEG'}</div><h3>{localized(item.name, language)}</h3>{item.description && <p>{localized(item.description, language)}</p>}<div className="guest-item-bottom"><strong>{money(item.variants.filter(variant=>variant.available).length?Math.min(...item.variants.filter(variant=>variant.available).map(variant=>Number(variant.price_minor))):Number(item.base_price_minor), currency)}{item.variants.some(variant=>variant.available)?<small> · From</small>:null}</strong>{item.prep_minutes ? <span><Clock3 size={12}/> {item.prep_minutes} min</span> : null}</div><div className="guest-item-option-badges">
              {item.variants.filter(variant=>variant.available).slice(0,2).map(variant=><span className="guest-option-badge portion" key={variant.id}>{localized(variant.name, language)} · {money(variant.price_minor, currency)}</span>)}
              {item.variants.filter(variant=>variant.available).length>2&&<span className="guest-option-badge">+{item.variants.filter(variant=>variant.available).length-2} portions</span>}
              {item.addon_groups.filter(group=>group.addons.some(addon=>addon.available)).slice(0,2).map(group=><span className="guest-option-badge addon" key={group.id}>+ {localized(group.name, language)}</span>)}
            </div></div>
            {quantity > 0 ? <div className="guest-item-quantity"><button type="button" aria-label={`Remove one ${localized(item.name, language)}`} onClick={() => firstLine && changeQuantity(firstLine.key, -1)}><Minus size={14}/></button><b>{quantity}</b><button type="button" aria-label={`Add one ${localized(item.name, language)}`} disabled={!item.available || !menu.restaurant?.accepting_orders} onClick={() => openItem(item)}><Plus size={14}/></button></div> : <button className="guest-add-button" disabled={!item.available || !menu.restaurant?.accepting_orders} onClick={() => openItem(item)}>{item.available ? 'ADD +' : 'Sold out'}</button>}
          </article>})}
          {!category.items?.length && <div className="guest-empty">No items in this category yet.</div>}
        </section>)}
      </main>
      <footer className="guest-footer">Freshly prepared · Thank you for visiting</footer>
      {cartCount > 0 && !selected && !cartOpen && <button className="guest-cart-bar" onClick={() => setCartOpen(true)}><span><ShoppingBag size={18}/> {cartCount} {cartCount === 1 ? 'item' : 'items'}</span><b><span className="guest-cart-action-label">Review order</span><small>{money(cartTotal, currency)}</small></b><ChevronRight size={18}/></button>}

      {selected && <div className="guest-modal-backdrop" onClick={() => setSelected(null)}><section className="guest-modal" onClick={event => event.stopPropagation()}>
        <div className="guest-modal-head"><div><span className="guest-kicker">CUSTOMISE</span><h2>{localized(selected.name, language)}</h2></div><button onClick={() => setSelected(null)} aria-label="Close"><X size={20}/></button></div>
        {selected.variants.length > 0 && <div className="guest-choice-group"><h3>Choose option <em>Required</em></h3>{selected.variants.filter(v => v.available).map(variant => <label key={variant.id}><input type="radio" name="guest-variant" checked={variantId === variant.id} onChange={() => setVariantId(variant.id)}/><span>{localized(variant.name, language)}</span><b>{money(variant.price_minor, currency)}</b></label>)}</div>}
        {selected.addon_groups.map(group => <div className="guest-choice-group" key={group.id}><h3>{localized(group.name, language)} <em>{group.required ? 'Required' : 'Optional'} · max {group.max_pick}</em></h3>{group.addons.filter(addon => addon.available).map(addon => <label key={addon.id}><input type="checkbox" checked={addonIds.includes(addon.id)} onChange={() => toggleAddon(addon.id, group)} /><span>{localized(addon.name, language)}</span><b>{Number(addon.price_minor) ? '+ ' + money(addon.price_minor, currency) : 'Free'}</b></label>)}</div>)}
        {!selected.variants.some(variant => variant.available) && !selected.addon_groups.some(group => group.addons.some(addon => addon.available)) && <div className="guest-choice-group guest-default-portion"><h3>Portion <em>Standard</em></h3><div className="guest-default-portion-row"><span>Regular serving</span><b>{money(selected.base_price_minor, currency)}</b></div></div>}
        <div className="guest-choice-group guest-modal-quantity"><h3>Quantity</h3><div className="guest-quantity"><button type="button" aria-label="Decrease selected quantity" disabled={selectedQuantity<=1} onClick={()=>setSelectedQuantity(value=>Math.max(1,value-1))}><Minus size={14}/></button><b>{selectedQuantity}</b><button type="button" aria-label="Increase selected quantity" onClick={()=>setSelectedQuantity(value=>Math.min(99,value+1))}><Plus size={14}/></button></div></div>
        {notice && <p className="guest-form-error">{notice}</p>}
        <button className="guest-primary" onClick={addSelected}>Add to order</button>
      </section></div>}

      {cartOpen && <div className="guest-modal-backdrop" onClick={() => setCartOpen(false)}><section className="guest-modal guest-cart-modal" onClick={event => event.stopPropagation()}>
        <div className="guest-modal-head"><div><span className="guest-kicker">YOUR ORDER</span><h2>Order summary</h2></div><button onClick={() => setCartOpen(false)} aria-label="Close"><X size={20}/></button></div>
        {cart.map(line => { const variant = line.item.variants.find(value => value.id === line.variantId); const addons = line.item.addon_groups.flatMap(group => group.addons).filter(addon => line.addonIds.includes(addon.id)); const unit = Number(variant?.price_minor ?? line.item.base_price_minor) + addons.reduce((n, addon) => n + Number(addon.price_minor), 0); return <div className="guest-cart-line" key={line.key}><div><b>{localized(line.item.name, language)}</b><small>{[variant && localized(variant.name, language), ...addons.map(a => localized(a.name, language))].filter(Boolean).join(' · ')}</small><strong>{money(unit * line.quantity, currency)}</strong></div><div className="guest-quantity"><button onClick={() => changeQuantity(line.key, -1)} aria-label="Decrease quantity"><Minus size={14}/></button><b>{line.quantity}</b><button onClick={() => changeQuantity(line.key, 1)} aria-label="Increase quantity"><Plus size={14}/></button></div></div> })}
        <div className="guest-cart-total"><span>Estimated total</span><strong>{money(cartTotal, currency)}</strong></div>
        {!menu.session && <p className="guest-form-error">Please ask your server to open this table before ordering.</p>}
        {notice && <p className="guest-form-error">{notice}</p>}
        <button className="guest-primary" disabled={!menu.session || sending || !cart.length || !menu.restaurant?.accepting_orders} onClick={() => void placeOrder()}>{sending ? 'Sending order…' : 'Place order · ' + money(cartTotal, currency)}</button>
        <button className="guest-secondary" onClick={() => setCartOpen(false)}>Continue browsing</button>
      </section></div>}
    </div>
  )
}
