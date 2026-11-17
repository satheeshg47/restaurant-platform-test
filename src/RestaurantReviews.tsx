import { useState } from 'react'
import { AlertCircle, Eye, EyeOff, MessageSquare, RefreshCw, Save, Star } from 'lucide-react'

const API_BASE=(import.meta.env.VITE_API_BASE_URL||'/api').replace(/\/$/,'')
type Review={id:string;rating:number;comment:string|null;visibility:'published'|'hidden';owner_response:string|null;created_at:string;responded_at:string|null;table_label:string;closed_at:string|null}
export default function RestaurantReviews(){
 const [slug,setSlug]=useState('')
 const [reviews,setReviews]=useState<Review[]>([])
 const [drafts,setDrafts]=useState<Record<string,string>>({})
 const [busy,setBusy]=useState(false)
 const [error,setError]=useState('')
 const [notice,setNotice]=useState('')
 async function load(){
  const clean=slug.trim().toLowerCase()
  if(!/^[a-z0-9][a-z0-9-]{1,62}$/.test(clean)){setError('Enter a valid restaurant slug.');return}
  setBusy(true);setError('');setNotice('')
  try{
   const res=await fetch(`${API_BASE}/restaurant/${encodeURIComponent(clean)}/reviews`,{credentials:'same-origin',cache:'no-store',headers:{Accept:'application/json'}})
   const data=await res.json().catch(()=>({}))
   if(!res.ok)throw new Error(data.error||'Could not load reviews')
   setReviews(data.reviews||[])
   setDrafts(Object.fromEntries((data.reviews||[]).map((r:Review)=>[r.id,r.owner_response||''])))
  }catch(e){setReviews([]);setError(e instanceof Error?e.message:'Could not load reviews')}
  finally{setBusy(false)}
 }
 async function update(review:Review,patch:Partial<Pick<Review,'visibility'|'owner_response'>>){
  setError('');setNotice('')
  try{
   const res=await fetch(`${API_BASE}/restaurant/${encodeURIComponent(slug.trim().toLowerCase())}/reviews/${review.id}`,{method:'PATCH',credentials:'same-origin',headers:{'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify(patch)})
   const data=await res.json().catch(()=>({}))
   if(!res.ok)throw new Error(data.error||'Could not update review')
   setReviews(current=>current.map(item=>item.id===review.id?{...item,...data.review}:item))
   setNotice('Review updated.')
  }catch(e){setError(e instanceof Error?e.message:'Could not update review')}
 }
 return <section className="restaurant-menu">
  <div className="restaurant-menu-heading"><div className="restaurant-menu-title"><div className="restaurant-menu-icon"><MessageSquare size={20}/></div><div><span className="eyebrow">RESTAURANT SUITE</span><h2>Customer reviews</h2><p>Read guest feedback, hide inappropriate reviews and post an owner response.</p></div></div></div>
  <div className="restaurant-review-filter"><label>Restaurant slug<input value={slug} onChange={e=>setSlug(e.target.value)} placeholder="e.g. my-restaurant" autoCapitalize="none"/></label><button className="button primary" onClick={()=>void load()} disabled={busy}><RefreshCw size={15}/>{busy?'Loading…':'Load reviews'}</button></div>
  {error&&<div className="restaurant-menu-alert"><AlertCircle size={16}/>{error}</div>}
  {notice&&<div className="restaurant-settings-success">{notice}</div>}
  {!reviews.length?<div className="restaurant-menu-empty">Load a restaurant to see guest reviews. New reviews can be submitted after a table session is closed.</div>:<div className="restaurant-review-list">
   {reviews.map(review=><article className="restaurant-review-card" key={review.id}>
    <div className="restaurant-review-top"><div><div className="restaurant-review-stars" aria-label={`${review.rating} out of 5 stars`}>{Array.from({length:5},(_,i)=><Star key={i} size={15} fill={i<review.rating?'currentColor':'none'}/>)}</div><b>{review.table_label||'Guest review'}</b><small>{new Date(review.created_at).toLocaleString('en-IN',{dateStyle:'medium',timeStyle:'short'})}</small></div><span className={`restaurant-review-state ${review.visibility}`}>{review.visibility}</span></div>
    <p className="restaurant-review-comment">{review.comment||'No written comment.'}</p>
    <label className="restaurant-review-response">Owner response<textarea rows={3} maxLength={1000} value={drafts[review.id]??''} onChange={e=>setDrafts(current=>({...current,[review.id]:e.target.value}))} placeholder="Write a polite public reply…"/></label>
    <div className="restaurant-review-actions"><button className="button secondary" onClick={()=>void update(review,{visibility:review.visibility==='published'?'hidden':'published'})}>{review.visibility==='published'?<EyeOff size={15}/>:<Eye size={15}/>} {review.visibility==='published'?'Hide review':'Publish review'}</button><button className="button primary" onClick={()=>void update(review,{owner_response:drafts[review.id]??''})}><Save size={15}/>Save response</button></div>
   </article>)}
  </div>}
 </section>
}
