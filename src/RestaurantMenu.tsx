import { apiFetch } from './auth'
import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import { AlertCircle, Check, ChevronDown, CirclePlus, Clock3, Leaf, LoaderCircle, Plus, RefreshCw, Save, Store, Utensils, X, ImagePlus } from 'lucide-react'

const API_BASE = (import.meta.env.VITE_API_BASE_URL || '/api').replace(/\/$/, '')
type Category = { id: string; name: Record<string,string>; sort_order: number; station: string | null; active: boolean }
type MenuItem = { id: string; category_id: string; name: Record<string,string>; description: Record<string,string>; base_price_minor: number; food_type: 'veg'|'non_veg'|'egg'; prep_minutes: number; priority: number; available: boolean; stock_tracking: boolean; stock_quantity: number | null; hsn_sac_code?: string | null; photo_object_key?: string | null; sort_order: number; active: boolean }
type Variant = { id:string; item_id:string; name:Record<string,string>; price_minor:number; available:boolean; active:boolean; sort_order:number }
type AddonGroup = { id:string; name:Record<string,string>; required:boolean; min_pick:number; max_pick:number; active:boolean; sort_order:number }
type Addon = { id:string; group_id:string; name:Record<string,string>; price_minor:number; available:boolean; active:boolean; sort_order:number }
type ItemAddonGroup = { item_id:string; group_id:string }
type MenuPayload = { categories: Category[]; items: MenuItem[]; variants:Variant[]; addon_groups:AddonGroup[]; addons:Addon[]; item_addon_groups:ItemAddonGroup[] }
type ViewState = 'idle'|'loading'|'ready'|'auth'|'forbidden'|'not_found'|'unavailable'

function messageFor(state: ViewState) {
  if (state === 'auth') return ['Owner sign-in required', 'Sign in with an identity that has owner or manager access to this restaurant.']
  if (state === 'forbidden') return ['Access denied', 'Your account does not have permission to manage this restaurant menu.']
  if (state === 'not_found') return ['Restaurant not found or not enabled', 'Check the restaurant slug and confirm that Restaurant Suite is enabled for this tenant.']
  if (state === 'unavailable') return ['Could not connect to the menu API', 'Check that the backend, database and /api proxy are configured. No changes have been saved.']
  return ['', '']
}

export default function RestaurantMenu({ initialSlug = '' }: { initialSlug?: string } = {}) {
  const [slug, setSlug] = useState(initialSlug)
  const [state, setState] = useState<ViewState>('idle')
  const [menu, setMenu] = useState<MenuPayload>({ categories: [], items: [], variants: [], addon_groups: [], addons: [], item_addon_groups: [] })
  const [error, setError] = useState('')
  const [modalError, setModalError] = useState('')
  const [translating, setTranslating] = useState(false)
  const [busy, setBusy] = useState(false)
  const [showCategory, setShowCategory] = useState(false)
  const [showItem, setShowItem] = useState(false)
  const [categoryName, setCategoryName] = useState('')
  const [categoryNameHi, setCategoryNameHi] = useState('')
  const [categoryNameKn, setCategoryNameKn] = useState('')
  const [categoryStation, setCategoryStation] = useState('')
  const [itemName, setItemName] = useState('')
  const [itemNameHi, setItemNameHi] = useState('')
  const [itemTranslations, setItemTranslations] = useState<Record<string,string>>({})
  const [itemDescription, setItemDescription] = useState('')
  const [descriptionTranslations, setDescriptionTranslations] = useState<Record<string,string>>({})
  const [itemAvailable, setItemAvailable] = useState(true)
  const [hasPortions, setHasPortions] = useState(false)
  const [portionDrafts, setPortionDrafts] = useState<Array<{id?:string;name:string;price:string}>>([{name:'Half Plate',price:''},{name:'Full Plate',price:''}])
  const [selectedAddonGroups, setSelectedAddonGroups] = useState<string[]>([])
  const [itemPrice, setItemPrice] = useState('')
  const [itemCategory, setItemCategory] = useState('')
  const [itemType, setItemType] = useState<'veg'|'non_veg'|'egg'>('veg')
  const [itemPrep, setItemPrep] = useState('10')
  const [itemHsnSac, setItemHsnSac] = useState('')
  const [stockTracking, setStockTracking] = useState(false)
  const [stockQuantity, setStockQuantity] = useState('')
  const [stockDelta, setStockDelta] = useState<Record<string,string>>({})
  const [stockReason, setStockReason] = useState<Record<string,string>>({})
  const [editing, setEditing] = useState<MenuItem | null>(null)
  const [optionItem, setOptionItem] = useState('')
  const [variantName, setVariantName] = useState('')
  const [variantNameHi, setVariantNameHi] = useState('')
  const [variantNameKn, setVariantNameKn] = useState('')
  const [variantPrice, setVariantPrice] = useState('')
  const [groupName, setGroupName] = useState('')
  const [groupNameHi, setGroupNameHi] = useState('')
  const [groupNameKn, setGroupNameKn] = useState('')
  const [groupMin, setGroupMin] = useState('0')
  const [groupMax, setGroupMax] = useState('1')
  const [addonGroup, setAddonGroup] = useState('')
  const [addonName, setAddonName] = useState('')
  const [addonNameHi, setAddonNameHi] = useState('')
  const [addonNameKn, setAddonNameKn] = useState('')
  const [addonPrice, setAddonPrice] = useState('')
  const [showOptions, setShowOptions] = useState(false)

  const endpoint = useMemo(() => slug.trim().toLowerCase(), [slug])
  const request = useCallback(async (path: string, init?: RequestInit) => {
    const response = await apiFetch(`${API_BASE}/restaurant/${encodeURIComponent(endpoint)}${path}`, {
      ...init,
      credentials: 'same-origin',
      headers: { Accept: 'application/json', ...(init?.body ? { 'Content-Type': 'application/json' } : {}), ...init?.headers },
      cache: 'no-store',
    })
    let payload: any = {}
    try { payload = await response.json() } catch { /* handled below */ }
    if (response.status === 401) { setState('auth'); throw new Error('Owner sign-in is required.') }
    if (response.status === 403) { setState('forbidden'); throw new Error('Owner or manager access is required.') }
    if (response.status === 404) { setState('not_found'); throw new Error('Restaurant not found or not enabled.') }
    if (!response.ok) throw new Error(payload.error || 'The menu request failed.')
    return payload
  }, [endpoint])

  const load = useCallback(async () => {
    if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(endpoint)) {
      setError('Enter a valid restaurant slug (2–63 lowercase letters, numbers or hyphens).')
      return
    }
    setBusy(true); setError(''); setState('loading')
    try {
      const payload = await request('/menu')
      if (!Array.isArray(payload.categories) || !Array.isArray(payload.items)) throw new Error('The menu API returned an invalid response.')
      setMenu({ ...payload, variants: payload.variants || [], addon_groups: payload.addon_groups || [], addons: payload.addons || [], item_addon_groups: payload.item_addon_groups || [] }); setState('ready')
    } catch (cause) {
      setState(current => ['auth','forbidden','not_found'].includes(current) ? current : 'unavailable')
      setError(cause instanceof Error ? cause.message : 'Unexpected menu API error.')
    } finally { setBusy(false) }
  }, [endpoint, request, state])

  useEffect(() => { setState('idle'); setMenu({ categories: [], items: [], variants: [], addon_groups: [], addons: [], item_addon_groups: [] }) }, [endpoint])
  useEffect(() => { if (initialSlug) void load() }, [initialSlug])

  async function saveCategory() {
    if (!categoryName.trim()) return
    setBusy(true); setError('')
    try {
      await request('/menu/categories', { method: 'POST', body: JSON.stringify({ name: { en: categoryName.trim(), ...(categoryNameHi.trim() ? { hi: categoryNameHi.trim() } : {}), ...(categoryNameKn.trim() ? { kn: categoryNameKn.trim() } : {}) }, station: categoryStation.trim() || null }) })
      setCategoryName(''); setCategoryNameHi(''); setCategoryNameKn(''); setCategoryStation(''); setShowCategory(false); await load()
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not save category.') }
    finally { setBusy(false) }
  }

  function openNewItem() {
    setModalError('')
    setEditing(null); setItemName(''); setItemNameHi(''); setItemTranslations({}); setItemDescription(''); setDescriptionTranslations({}); setItemAvailable(true); setHasPortions(false); setPortionDrafts([{name:'Half Plate',price:''},{name:'Full Plate',price:''}]); setSelectedAddonGroups([]); setItemPrice(''); setItemPrep('10'); setItemHsnSac(''); setStockTracking(false); setStockQuantity('')
    setItemCategory(menu.categories.find(category => category.active)?.id || '')
    setItemType('veg'); setShowItem(true)
  }

  function openEditItem(item: MenuItem) {
    setModalError('')
    setEditing(item); setItemName(item.name.en || ''); setItemNameHi(item.name.hi || ''); setItemTranslations(Object.fromEntries(Object.entries(item.name).filter(([key])=>!['en','hi'].includes(key)))); setItemDescription(item.description?.en || ''); setDescriptionTranslations(Object.fromEntries(Object.entries(item.description || {}).filter(([key])=>key!=='en'))); setItemAvailable(item.available); setHasPortions(menu.variants.some(v=>v.item_id===item.id&&v.active)); setPortionDrafts(menu.variants.filter(v=>v.item_id===item.id&&v.active).map(v=>({id:v.id,name:v.name.en||'',price:(Number(v.price_minor)/100).toFixed(2)}))); setSelectedAddonGroups(menu.item_addon_groups.filter(link=>link.item_id===item.id).map(link=>link.group_id))
    setItemPrice((Number(item.base_price_minor) / 100).toFixed(2))
    setItemPrep(String(item.prep_minutes)); setItemHsnSac(item.hsn_sac_code || ''); setItemCategory(item.category_id); setItemType(item.food_type); setStockTracking(item.stock_tracking); setStockQuantity(item.stock_quantity === null ? '' : String(item.stock_quantity)); setShowItem(true)
  }

  async function translateItem(target: 'hi' | 'kn' | 'ta' | 'te' | 'ml') {
    const source = itemName.trim()
    if (!source) { setModalError('Enter the English food name before translating.'); return }
    setTranslating(true); setModalError('')
    try {
      const url = 'https://translate.googleapis.com/translate_a/single?' + new URLSearchParams({ client: 'gtx', sl: 'en', tl: target, dt: 't', q: source }).toString()
      const response = await fetch(url, { headers: { Accept: 'application/json' } })
      if (!response.ok) throw new Error('Translation service is temporarily unavailable. You can type the translation manually.')
      const payload = await response.json()
      const translated = Array.isArray(payload?.[0]) ? payload[0].map((part: unknown[]) => String(part?.[0] || '')).join('').trim() : ''
      if (!translated) throw new Error('No translation was returned. Please enter it manually.')
      if (target === 'hi') setItemNameHi(translated)
      else setItemTranslations(current=>({...current,[target]:translated}))
      if(itemDescription.trim()){const descriptionUrl='https://translate.googleapis.com/translate_a/single?'+new URLSearchParams({client:'gtx',sl:'en',tl:target,dt:'t',q:itemDescription.trim()}).toString();const descriptionResponse=await fetch(descriptionUrl,{headers:{Accept:'application/json'}});if(descriptionResponse.ok){const descriptionPayload=await descriptionResponse.json();const translatedDescription=Array.isArray(descriptionPayload?.[0])?descriptionPayload[0].map((part:unknown[])=>String(part?.[0]||'')).join('').trim():'';if(translatedDescription)setDescriptionTranslations(current=>({...current,[target]:translatedDescription}))}}
    } catch (cause) { setModalError(cause instanceof Error ? cause.message : 'Translation failed. Please enter the translation manually.') }
    finally { setTranslating(false) }
  }

  async function saveItem() {
    const price = Number(itemPrice)
    const prep = Number(itemPrep)
    const stock = stockQuantity.trim() === '' ? null : Number(stockQuantity)
    if (!itemName.trim() || !itemCategory || (!hasPortions && !itemPrice.trim()) || !Number.isFinite(price) || price < 0 || !Number.isInteger(price * 100) || !Number.isInteger(prep) || prep < 0 || prep > 1440 || (stockTracking && (stock === null || !Number.isFinite(stock) || stock < 0))) {
      setModalError('Enter a name, category, valid price (up to 2 decimals) and preparation time.')
      return
    }
    setBusy(true); setModalError('')
    const name={en:itemName.trim(),...(itemNameHi.trim()?{hi:itemNameHi.trim()}:{}),...Object.fromEntries(Object.entries(itemTranslations).filter(([,value])=>value.trim()).map(([key,value])=>[key,value.trim()]))}
    const description={...(itemDescription.trim()?{en:itemDescription.trim()}:{}),...Object.fromEntries(Object.entries(descriptionTranslations).filter(([,value])=>value.trim()).map(([key,value])=>[key,value.trim()]))}
    const body={category_id:itemCategory,hsn_sac_code:itemHsnSac.trim()||null,name,description,base_price_minor:Math.round(price*100),food_type:itemType,available:itemAvailable,prep_minutes:prep,stock_tracking:stockTracking,...(!editing?{stock_quantity:stockTracking?stock:null}:{})}
    try {
      const saved=editing?await request(`/menu/items/${editing.id}`,{method:'PATCH',body:JSON.stringify(body)}):await request('/menu/items',{method:'POST',body:JSON.stringify(body)})
      const savedItemId=editing?.id||saved.item?.id
      if(!savedItemId)throw new Error('The item was saved but its ID was not returned; refresh before adding options.')
      const existingVariants=menu.variants.filter(v=>v.item_id===savedItemId&&v.active)
      if(hasPortions){const valid=portionDrafts.filter(option=>option.name.trim()&&option.price.trim());if(valid.length<2)throw new Error('Add at least two portion names and prices.');for(const option of valid){const amount=Number(option.price);if(!Number.isFinite(amount)||amount<0||!Number.isInteger(amount*100))throw new Error('Each portion needs a valid price (up to 2 decimals).');const variantBody={name:{en:option.name.trim()},price_minor:Math.round(amount*100),active:true};if(option.id)await request(`/menu/variants/${option.id}`,{method:'PATCH',body:JSON.stringify(variantBody)});else await request(`/menu/items/${savedItemId}/variants`,{method:'POST',body:JSON.stringify(variantBody)})}for(const oldVariant of existingVariants){if(!portionDrafts.some(option=>option.id===oldVariant.id))await request(`/menu/variants/${oldVariant.id}`,{method:'PATCH',body:JSON.stringify({active:false})})}}else if(editing){for(const variant of existingVariants)await request(`/menu/variants/${variant.id}`,{method:'PATCH',body:JSON.stringify({active:false})})}
      for(const groupId of selectedAddonGroups){if(!menu.item_addon_groups.some(link=>link.item_id===savedItemId&&link.group_id===groupId))await request(`/menu/items/${savedItemId}/addon-groups`,{method:'POST',body:JSON.stringify({group_id:groupId})})}
      setShowItem(false);setEditing(null);await load()
    } catch (cause) { setModalError(cause instanceof Error ? cause.message : 'Could not save food item.') }
    finally { setBusy(false) }
  }


  async function uploadPhoto(item: MenuItem, file?: File) {
    if (!file) return
    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/avif']
    if (!allowed.includes(file.type)) { setError('Choose a JPG, PNG, WebP or AVIF image.'); return }
    if (file.size > 5 * 1024 * 1024) { setError('Choose an image smaller than 5 MB.'); return }
    setBusy(true); setError('')
    try {
      const upload = await request(`/menu/items/${item.id}/photo-upload`, {
        method: 'POST', body: JSON.stringify({ content_type: file.type }),
      })
      const sent = await fetch(upload.upload_url, {
        method: 'PUT', headers: { 'Content-Type': file.type }, body: file,
      })
      if (!sent.ok) throw new Error('The private image upload failed. Check the storage CORS settings and try again.')
      await request(`/menu/items/${item.id}/photo-complete`, {
        method: 'POST', body: JSON.stringify({ content_type: file.type }),
      })
      await load()
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not upload menu photo.') }
    finally { setBusy(false) }
  }

  async function adjustStock(item: MenuItem) {
    const delta = Number(stockDelta[item.id])
    const reason = (stockReason[item.id] || '').trim()
    if (!Number.isFinite(delta) || delta === 0 || !Number.isInteger(delta * 1000) || !reason) {
      setError('Enter a non-zero stock change (up to 3 decimals) and a reason.')
      return
    }
    setBusy(true); setError('')
    try {
      await request(`/menu/items/${item.id}/stock-adjustments`, { method:'POST', body:JSON.stringify({ quantity_delta:delta, reason }) })
      setStockDelta(current=>({...current,[item.id]:''})); setStockReason(current=>({...current,[item.id]:''})); await load()
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not adjust stock.') }
    finally { setBusy(false) }
  }

  async function toggleAvailable(item: MenuItem) {
    setBusy(true); setError('')
    try { await request(`/menu/items/${item.id}`, { method: 'PATCH', body: JSON.stringify({ available: !item.available }) }); await load() }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not update availability.') }
    finally { setBusy(false) }
  }

  async function saveVariant() {
    const price = Number(variantPrice)
    if (!optionItem || !variantName.trim() || !Number.isFinite(price) || price < 0 || !Number.isInteger(price * 100)) {
      setError('Choose a food item and enter a variant name and valid price.')
      return
    }
    setBusy(true); setError('')
    try {
      await request(`/menu/items/${optionItem}/variants`, { method:'POST', body:JSON.stringify({ name:{en:variantName.trim(), ...(variantNameHi.trim()?{hi:variantNameHi.trim()}:{}), ...(variantNameKn.trim()?{kn:variantNameKn.trim()}:{})}, price_minor:Math.round(price*100) }) })
      setVariantName(''); setVariantNameHi(''); setVariantNameKn(''); setVariantPrice(''); await load()
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not save variant.') }
    finally { setBusy(false) }
  }

  async function saveAddonGroup() {
    const min = Number(groupMin), max = Number(groupMax)
    if (!groupName.trim() || !Number.isInteger(min) || !Number.isInteger(max) || min < 0 || max < min || max > 20) {
      setError('Enter a group name and valid selection limits (0–20).')
      return
    }
    setBusy(true); setError('')
    try {
      const result = await request('/menu/addon-groups', { method:'POST', body:JSON.stringify({ name:{en:groupName.trim(), ...(groupNameHi.trim()?{hi:groupNameHi.trim()}:{}), ...(groupNameKn.trim()?{kn:groupNameKn.trim()}:{})}, min_pick:min, max_pick:max, required:min>0 }) })
      setAddonGroup(result.addon_group.id); setGroupName(''); setGroupNameHi(''); setGroupNameKn(''); await load()
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not save add-on group.') }
    finally { setBusy(false) }
  }

  async function saveAddon() {
    const price = Number(addonPrice)
    if (!addonGroup || !addonName.trim() || !Number.isFinite(price) || price < 0 || !Number.isInteger(price*100)) {
      setError('Choose an add-on group and enter a name and valid price.')
      return
    }
    setBusy(true); setError('')
    try {
      await request(`/menu/addon-groups/${addonGroup}/addons`, { method:'POST', body:JSON.stringify({ name:{en:addonName.trim(), ...(addonNameHi.trim()?{hi:addonNameHi.trim()}:{}), ...(addonNameKn.trim()?{kn:addonNameKn.trim()}:{})}, price_minor:Math.round(price*100) }) })
      setAddonName(''); setAddonNameHi(''); setAddonNameKn(''); setAddonPrice(''); await load()
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not save add-on.') }
    finally { setBusy(false) }
  }

  async function attachAddonGroup() {
    if (!optionItem || !addonGroup) { setError('Choose a food item and an add-on group first.'); return }
    setBusy(true); setError('')
    try {
      await request(`/menu/items/${optionItem}/addon-groups`, { method:'POST', body:JSON.stringify({ group_id:addonGroup }) })
      await load()
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not attach add-on group.') }
    finally { setBusy(false) }
  }

  async function toggleOption(path:string, body:Record<string,unknown>) {
    setBusy(true); setError('')
    try { await request(path,{method:'PATCH',body:JSON.stringify(body)}); await load() }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not update menu option.') }
    finally { setBusy(false) }
  }

  const categoryLabel = (category: Category) => category.name.en || category.name.hi || category.name.kn || 'Untitled category'
  const itemLabel = (item: MenuItem) => item.name.en || item.name.hi || item.name.kn || 'Untitled item'
  const rupees = (minor: number) => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 }).format(Number(minor) / 100)

  return <section className="restaurant-menu-screen" aria-live="polite">
    <div className="restaurant-menu-hero panel">
      <div className="restaurant-menu-brand"><div className="restaurant-menu-mark"><Store size={21}/></div><div><span className="eyebrow">RESTAURANT SUITE</span><h2>Menu management</h2><p>Manage categories, food items, prices and availability.</p></div></div>
      {!initialSlug && <div className="restaurant-slug-control"><label htmlFor="restaurant-slug">Restaurant workspace slug</label><div><input id="restaurant-slug" value={slug} onChange={event => setSlug(event.target.value.toLowerCase().replace(/[^a-z0-9-]/g,''))} placeholder="e.g. my-restaurant" maxLength={63}/><button className="button primary" onClick={() => void load()} disabled={busy || !endpoint}><RefreshCw size={14} className={busy ? 'spin' : ''}/>{busy ? 'Loading' : 'Load menu'}</button></div><small>Uses your signed-in owner or manager session. No demo records are shown.</small></div>}
    </div>

    {error && <div className="restaurant-menu-alert"><AlertCircle size={16}/><span>{error}</span><button onClick={() => setError('')} aria-label="Dismiss"><X size={15}/></button></div>}

    {state === 'idle' && <div className="panel restaurant-menu-empty"><div className="restaurant-menu-empty-icon"><Utensils size={22}/></div><b>Connect a restaurant workspace</b><p>Enter the tenant slug above to load its live menu.</p></div>}
    {state === 'loading' && <div className="panel restaurant-menu-empty"><LoaderCircle size={22} className="spin"/><b>Loading restaurant menu…</b></div>}
    {['auth','forbidden','not_found','unavailable'].includes(state) && <div className="panel restaurant-menu-empty restaurant-menu-blocked"><div className="restaurant-menu-empty-icon"><AlertCircle size={22}/></div><b>{messageFor(state)[0]}</b><p>{messageFor(state)[1]}</p></div>}

    {state === 'ready' && <>
      <div className="restaurant-menu-summary">
        <div><strong>{menu.categories.length}</strong><span>Categories</span></div><div><strong>{menu.items.length}</strong><span>Food items</span></div><div><strong>{menu.items.filter(item => item.available && item.active).length}</strong><span>Available now</span></div>
        <button className="button secondary small" onClick={() => void load()} disabled={busy}><RefreshCw size={14}/>Refresh</button>
      </div>
      <div className="restaurant-menu-toolbar"><div><h3>Your menu</h3><p>Changes are saved to this restaurant’s database.</p></div><div><button className="button secondary" onClick={() => setShowCategory(true)} disabled={busy}><Plus size={15}/>Category</button><button className="button primary" onClick={openNewItem} disabled={busy || menu.categories.filter(c => c.active).length === 0}><CirclePlus size={15}/>Add food</button></div></div>
      {menu.categories.length === 0 && <div className="panel restaurant-menu-empty"><b>No categories yet</b><p>Create a category before adding food items.</p></div>}
      {menu.categories.filter(category => category.active).map(category => <section className="panel restaurant-category" key={category.id}>
        <div className="restaurant-category-heading"><div><h3>{categoryLabel(category)}</h3><small>{menu.items.filter(item => item.category_id === category.id && item.active).length} items{category.station ? ` · ${category.station}` : ''}</small></div><span className="restaurant-category-chevron"><ChevronDown size={17}/></span></div>
        {menu.items.filter(item => item.category_id === category.id && item.active).length === 0 && <p className="restaurant-category-empty">No food items in this category.</p>}
        {menu.items.filter(item => item.category_id === category.id && item.active).map(item => <Fragment key={item.id}>
        <div className="restaurant-food-row" key={item.id}>
          <div className={`restaurant-food-type ${item.food_type}`}>{item.food_type === 'veg' ? <Leaf size={14}/> : <Utensils size={14}/>}</div>
          <div className="restaurant-food-copy"><b>{itemLabel(item)}</b><small><Clock3 size={11}/>{item.prep_minutes} min · {item.food_type.replace('_',' ')}{item.stock_tracking ? ` · Stock: ${item.stock_quantity ?? 0}` : ''}</small></div>
          <strong className="restaurant-food-price">{rupees(item.base_price_minor)}</strong>
          <button className={`restaurant-availability ${item.available ? 'on' : 'off'}`} onClick={() => void toggleAvailable(item)} disabled={busy}>{item.available ? 'Available' : 'Sold out'}</button>
          <label className="restaurant-edit-button" htmlFor={`photo-${item.id}`} style={{display:"inline-flex",alignItems:"center",gap:4,cursor:busy?"not-allowed":"pointer",opacity:busy?0.55:1}}><ImagePlus size={13}/>Photo</label><input id={`photo-${item.id}`} type="file" accept="image/jpeg,image/png,image/webp,image/avif" hidden disabled={busy} onChange={event=>{void uploadPhoto(item,event.target.files?.[0]);event.currentTarget.value=""}}/><button className="restaurant-edit-button" onClick={() => openEditItem(item)} disabled={busy}>Edit</button>
        </div>
        {item.stock_tracking && <div className="restaurant-stock-adjust-row"><span>Stock: <b>{item.stock_quantity ?? 0}</b></span><input aria-label={`Stock adjustment for ${itemLabel(item)}`} type="number" step="0.001" value={stockDelta[item.id] || ''} onChange={event=>setStockDelta(current=>({...current,[item.id]:event.target.value}))} placeholder="+/- quantity"/><input aria-label={`Stock adjustment reason for ${itemLabel(item)}`} value={stockReason[item.id] || ''} onChange={event=>setStockReason(current=>({...current,[item.id]:event.target.value}))} placeholder="Reason (e.g. delivery)"/><button className="button secondary small" onClick={()=>void adjustStock(item)} disabled={busy}>Adjust</button></div>}
      </Fragment>)}
      </section>)}
      <section className="panel restaurant-options-panel">
        <div className="restaurant-category-heading"><div><h3>Variants & extras</h3><small>Sizes, add-ons and item choices</small></div><button className="button secondary small" onClick={()=>setShowOptions(value=>!value)}>{showOptions?'Hide':'Manage options'}</button></div>
        {showOptions && <>
          <div className="restaurant-option-block">
            <b>1. Add a variant</b><p>Examples: Regular, Large, Family size.</p>
            <label htmlFor="option-item">Food item</label>
            <select id="option-item" className="modal-input" value={optionItem} onChange={event=>setOptionItem(event.target.value)}><option value="">Choose food item</option>{menu.items.filter(item=>item.active).map(item=><option key={item.id} value={item.id}>{itemLabel(item)}</option>)}</select>
            <div className="restaurant-form-grid"><div><label htmlFor="variant-name">Variant · English</label><input id="variant-name" className="modal-input" value={variantName} onChange={event=>setVariantName(event.target.value)} placeholder="Large"/><label htmlFor="variant-name-hi">Hindi</label><input id="variant-name-hi" className="modal-input" value={variantNameHi} onChange={event=>setVariantNameHi(event.target.value)} placeholder="बड़ा"/><label htmlFor="variant-name-kn">Kannada</label><input id="variant-name-kn" className="modal-input" value={variantNameKn} onChange={event=>setVariantNameKn(event.target.value)} placeholder="ದೊಡ್ಡ"/></div><div><label htmlFor="variant-price">Price (₹)</label><input id="variant-price" className="modal-input" type="number" min="0" step="0.01" value={variantPrice} onChange={event=>setVariantPrice(event.target.value)} placeholder="0.00"/></div></div>
            <button className="button primary small" onClick={()=>void saveVariant()} disabled={busy}><Plus size={13}/>Add variant</button>
            {menu.variants.filter(v=>v.item_id===optionItem && v.active).map(v=><div className="restaurant-option-row" key={v.id}><span>{v.name.en||'Variant'} · {rupees(v.price_minor)}</span><button className={`restaurant-availability ${v.available?'on':'off'}`} onClick={()=>void toggleOption(`/menu/variants/${v.id}`,{available:!v.available})} disabled={busy}>{v.available?'Available':'Unavailable'}</button></div>)}
          </div>
          <div className="restaurant-option-block">
            <b>2. Create an add-on group</b><p>Example: Choose toppings. Set minimum and maximum selections.</p>
            <label htmlFor="group-name">Group name · English</label><input id="group-name" className="modal-input" value={groupName} onChange={event=>setGroupName(event.target.value)} placeholder="Choose toppings"/><div className="restaurant-form-grid"><div><label htmlFor="group-name-hi">Hindi</label><input id="group-name-hi" className="modal-input" value={groupNameHi} onChange={event=>setGroupNameHi(event.target.value)} placeholder="टॉपिंग चुनें"/></div><div><label htmlFor="group-name-kn">Kannada</label><input id="group-name-kn" className="modal-input" value={groupNameKn} onChange={event=>setGroupNameKn(event.target.value)} placeholder="ಟಾಪಿಂಗ್ಸ್ ಆಯ್ಕೆಮಾಡಿ"/></div></div>
            <div className="restaurant-form-grid"><div><label htmlFor="group-min">Minimum picks</label><input id="group-min" className="modal-input" type="number" min="0" max="20" value={groupMin} onChange={event=>setGroupMin(event.target.value)}/></div><div><label htmlFor="group-max">Maximum picks</label><input id="group-max" className="modal-input" type="number" min="0" max="20" value={groupMax} onChange={event=>setGroupMax(event.target.value)}/></div></div>
            <button className="button primary small" onClick={()=>void saveAddonGroup()} disabled={busy}><Plus size={13}/>Create group</button>
          </div>
          <div className="restaurant-option-block">
            <b>3. Add an extra</b><p>Examples: Extra cheese, paneer, egg.</p>
            <label htmlFor="addon-group">Add-on group</label><select id="addon-group" className="modal-input" value={addonGroup} onChange={event=>setAddonGroup(event.target.value)}><option value="">Choose group</option>{menu.addon_groups.filter(g=>g.active).map(g=><option key={g.id} value={g.id}>{g.name.en||'Untitled group'}</option>)}</select>
            <div className="restaurant-form-grid"><div><label htmlFor="addon-name">Extra · English</label><input id="addon-name" className="modal-input" value={addonName} onChange={event=>setAddonName(event.target.value)} placeholder="Extra cheese"/><label htmlFor="addon-name-hi">Hindi</label><input id="addon-name-hi" className="modal-input" value={addonNameHi} onChange={event=>setAddonNameHi(event.target.value)} placeholder="अतिरिक्त चीज़"/><label htmlFor="addon-name-kn">Kannada</label><input id="addon-name-kn" className="modal-input" value={addonNameKn} onChange={event=>setAddonNameKn(event.target.value)} placeholder="ಹೆಚ್ಚುವರಿ ಚೀಸ್"/></div><div><label htmlFor="addon-price">Price (₹)</label><input id="addon-price" className="modal-input" type="number" min="0" step="0.01" value={addonPrice} onChange={event=>setAddonPrice(event.target.value)} placeholder="0.00"/></div></div>
            <button className="button primary small" onClick={()=>void saveAddon()} disabled={busy}><Plus size={13}/>Add extra</button>
            {menu.addons.filter(a=>a.group_id===addonGroup && a.active).map(a=><div className="restaurant-option-row" key={a.id}><span>{a.name.en||'Extra'} · {rupees(a.price_minor)}</span><button className={`restaurant-availability ${a.available?'on':'off'}`} onClick={()=>void toggleOption(`/menu/addons/${a.id}`,{available:!a.available})} disabled={busy}>{a.available?'Available':'Unavailable'}</button></div>)}
          </div>
          <div className="restaurant-option-block">
            <b>4. Attach this group to a food item</b><p>Guests will see these extras when they order the selected item.</p>
            <button className="button secondary small" onClick={()=>void attachAddonGroup()} disabled={busy || !optionItem || !addonGroup}>Attach group to selected item</button>
            {menu.item_addon_groups.filter(link=>link.item_id===optionItem).map(link=><div className="restaurant-option-row" key={link.group_id}><span>{menu.addon_groups.find(g=>g.id===link.group_id)?.name.en||'Add-on group attached'}</span><span className="restaurant-option-attached">Attached</span></div>)}
          </div>
        </>}
      </section>
      <p className="restaurant-menu-footnote"><Check size={13}/> Menu data and options are loaded from the protected tenant API. Private menu photo uploads are available when storage is configured. Multilingual menu fields are supported.</p>
    </>}
    {showCategory && <div className="modal-backdrop" role="presentation"><div className="modal restaurant-editor" role="dialog" aria-modal="true" aria-labelledby="category-modal-title"><div className="modal-top"><div><span className="eyebrow">MENU SETUP</span><h2 id="category-modal-title">Add category</h2></div><button className="icon-button" onClick={() => setShowCategory(false)} aria-label="Close"><X size={18}/></button></div><p className="modal-desc">Create a category to organize your restaurant menu.</p><label htmlFor="category-name">Category name · English (required)</label><input className="modal-input" id="category-name" value={categoryName} onChange={event => setCategoryName(event.target.value)} placeholder="e.g. Starters" maxLength={120}/><div className="restaurant-form-grid"><div><label htmlFor="category-name-hi">Hindi (हिन्दी)</label><input className="modal-input" id="category-name-hi" value={categoryNameHi} onChange={event=>setCategoryNameHi(event.target.value)} placeholder="शुरुआती व्यंजन" maxLength={120}/></div><div><label htmlFor="category-name-kn">Kannada (ಕನ್ನಡ)</label><input className="modal-input" id="category-name-kn" value={categoryNameKn} onChange={event=>setCategoryNameKn(event.target.value)} placeholder="ಸ್ಟಾರ್ಟರ್ಸ್" maxLength={120}/></div></div><label htmlFor="category-station" className="restaurant-field-label">Kitchen station (optional)</label><input className="modal-input" id="category-station" value={categoryStation} onChange={event => setCategoryStation(event.target.value)} placeholder="e.g. Grill" maxLength={80}/><div className="modal-actions"><button className="button secondary" onClick={() => setShowCategory(false)}>Cancel</button><button className="button primary" onClick={() => void saveCategory()} disabled={busy || !categoryName.trim()}><Save size={14}/>Save category</button></div></div></div>}
    {showItem && <div className="modal-backdrop menu-item-backdrop" role="presentation" onClick={event=>{if(event.target===event.currentTarget)setShowItem(false)}}><div className="modal restaurant-editor menu-item-editor" role="dialog" aria-modal="true" aria-labelledby="item-modal-title">
      <div className="modal-top"><div><span className="eyebrow">MENU ITEM</span><h2 id="item-modal-title">{editing?'Edit food item':'Add food item'}</h2></div><button className="icon-button" onClick={()=>setShowItem(false)} aria-label="Close"><X size={18}/></button></div>
      <p className="modal-desc">Set food details, translations, portions and availability.</p>
      {modalError&&<div className="restaurant-menu-modal-alert" role="alert"><AlertCircle size={15}/><span>{modalError}</span><button type="button" onClick={()=>setModalError('')} aria-label="Dismiss"><X size={14}/></button></div>}
      <label htmlFor="item-name">Food name · English (required)</label><input className="modal-input" id="item-name" value={itemName} onChange={event=>setItemName(event.target.value)} placeholder="e.g. Masala dosa" maxLength={120}/>
      <div className="restaurant-translation-grid">{(['hi','kn','ta','te','ml'] as const).map(code=><div key={code}><label htmlFor={'item-name-'+code}>{{hi:'Hindi',kn:'Kannada',ta:'Tamil',te:'Telugu',ml:'Malayalam'}[code]}</label><input className="modal-input" id={'item-name-'+code} value={code==='hi'?itemNameHi:(itemTranslations[code]||'')} onChange={event=>code==='hi'?setItemNameHi(event.target.value):setItemTranslations(current=>({...current,[code]:event.target.value}))} placeholder="Optional translation"/><button type="button" className="translate-inline" onClick={()=>void translateItem(code)} disabled={translating||!itemName.trim()}>{translating?'Translating…':'Auto translate name + description'}</button></div>)}</div>
      <label htmlFor="item-description">Description (optional)</label><textarea className="modal-input" id="item-description" rows={2} maxLength={300} value={itemDescription} onChange={event=>setItemDescription(event.target.value)} placeholder="Short description of ingredients or preparation"/>
      {Object.keys(descriptionTranslations).length>0&&<small className="restaurant-menu-translation-note">Translated descriptions: {Object.keys(descriptionTranslations).join(', ')}</small>}
      <label htmlFor="item-category" className="restaurant-field-label">Category</label><select className="modal-input" id="item-category" value={itemCategory} onChange={event=>setItemCategory(event.target.value)}>{menu.categories.filter(c=>c.active).map(category=><option key={category.id} value={category.id}>{categoryLabel(category)}</option>)}</select>
      <div className="restaurant-form-grid"><div><label htmlFor="item-price">Base price (₹)</label><input className="modal-input" id="item-price" type="number" min="0" step="0.01" value={itemPrice} onChange={event=>setItemPrice(event.target.value)} placeholder="0.00"/></div><div><label htmlFor="item-prep">Prep time (min)</label><input className="modal-input" id="item-prep" type="number" min="0" max="1440" step="1" value={itemPrep} onChange={event=>setItemPrep(event.target.value)}/></div></div>
      <label>Dietary type</label><div className="restaurant-dietary-pills">{(['veg','non_veg','egg'] as const).map(type=><button type="button" key={type} className={itemType===type?'selected':''} aria-pressed={itemType===type} onClick={()=>setItemType(type)}>{type==='veg'?'🟢 Veg':type==='non_veg'?'🔴 Non-Veg':'🟡 Egg'}</button>)}</div>
      <label className="restaurant-toggle-row"><input type="checkbox" checked={itemAvailable} onChange={event=>setItemAvailable(event.target.checked)}/> In Stock / Available</label>
      <label htmlFor="item-hsn-sac">HSN / SAC code (4, 6 or 8 digits)</label><input className="modal-input" id="item-hsn-sac" inputMode="numeric" maxLength={8} value={itemHsnSac} onChange={event=>setItemHsnSac(event.target.value.replace(/[^0-9]/g,''))} placeholder="e.g. 996331"/>
      <div className="restaurant-stock-control"><label><input type="checkbox" checked={stockTracking} onChange={event=>setStockTracking(event.target.checked)}/> Track stock quantity</label>{stockTracking&&<div><label htmlFor="item-stock">Available quantity</label><input className="modal-input" id="item-stock" type="number" min="0" step="0.01" value={stockQuantity} onChange={event=>setStockQuantity(event.target.value)} placeholder="e.g. 25"/></div>}</div>
      <label className="restaurant-toggle-row"><input type="checkbox" checked={hasPortions} onChange={event=>setHasPortions(event.target.checked)}/> Has portions / variants (Half, Full, Small, Large)</label>
      {hasPortions&&<div className="restaurant-portion-editor"><b>Portion options and prices</b>{portionDrafts.map((option,index)=><div className="restaurant-portion-row" key={index}><input className="modal-input" aria-label={'Portion '+(index+1)+' name'} value={option.name} onChange={event=>setPortionDrafts(current=>current.map((value,i)=>i===index?{...value,name:event.target.value}:value))} placeholder="e.g. Half Plate"/><input className="modal-input" aria-label={'Portion '+(index+1)+' price'} type="number" min="0" step="0.01" value={option.price} onChange={event=>setPortionDrafts(current=>current.map((value,i)=>i===index?{...value,price:event.target.value}:value))} placeholder="₹ price"/><button type="button" onClick={()=>setPortionDrafts(current=>current.filter((_,i)=>i!==index))} aria-label="Remove portion"><X size={15}/></button></div>)}<button type="button" className="button secondary small" onClick={()=>setPortionDrafts(current=>[...current,{name:'',price:''}])}><Plus size={13}/>Add portion</button>{editing&&<small>Existing portions are preserved. Manage their prices in Variants & extras.</small>}</div>}
      <label>Add-on groups (optional)</label><div className="restaurant-addon-picker">{menu.addon_groups.filter(group=>group.active).map(group=><label key={group.id}><input type="checkbox" checked={selectedAddonGroups.includes(group.id)} onChange={event=>setSelectedAddonGroups(current=>event.target.checked?[...current,group.id]:current.filter(id=>id!==group.id))}/><span>{group.name.en||'Add-on group'}{group.required?' · Required':' · Optional'}</span></label>)}{menu.addon_groups.filter(group=>group.active).length===0&&<small>Create add-on groups in Manage options first.</small>}</div>
      <div className="modal-actions"><button className="button secondary" onClick={()=>setShowItem(false)}>Cancel</button><button className="button primary" onClick={()=>void saveItem()} disabled={busy||translating}><Save size={14}/>{busy?'Saving…':'Save item'}</button></div>
    </div></div>}
  </section>
}
