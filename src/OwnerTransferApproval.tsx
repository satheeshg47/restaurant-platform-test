import { useEffect, useState } from 'react'
import { ArrowRight, CheckCircle2, ShieldAlert } from 'lucide-react'

const API_BASE = (import.meta.env.VITE_API_BASE_URL || '/api').replace(/\/$/, '')

export default function OwnerTransferApproval() {
  const [token,setToken]=useState('')
  const [state,setState]=useState<'checking'|'ready'|'sending'|'done'|'error'>('checking')
  const [message,setMessage]=useState('')
  useEffect(()=>{
    const saved=sessionStorage.getItem('platformcore.owner.transfer.approval')||''
    if(/^[A-Za-z0-9_-]{43}$/.test(saved)){setToken(saved);setState('ready')}
    else{setState('error');setMessage('This approval link is invalid or expired.')}
  },[])
  const approve=async()=>{
    setState('sending');setMessage('')
    try{
      const response=await fetch(API_BASE+'/owner/transfers/approve',{method:'POST',credentials:'same-origin',headers:{Accept:'application/json','Content-Type':'application/json'},body:JSON.stringify({token}),cache:'no-store'})
      const payload=await response.json().catch(()=>({})) as {error?:string;approved?:boolean}
      if(!response.ok||!payload.approved)throw new Error('This approval link is invalid, expired or already used.')
      sessionStorage.removeItem('platformcore.owner.transfer.approval')
      setToken('');setState('done')
      setMessage('Your approval is recorded. The incoming Owner must still accept before ownership or access changes.')
    }catch(cause){setState('error');setMessage(cause instanceof Error?cause.message:'Approval could not be recorded.')}
  }
  return <main className="signin-screen"><section className="signin-card">
    <div className="signin-brand"><div className="signin-mark"><ShieldAlert size={23}/></div><div><b>platform<span>core</span></b><small>OWNERSHIP APPROVAL</small></div></div>
    {state==='done'?<><div className="signin-icon"><CheckCircle2 size={22}/></div><span className="signin-eyebrow">APPROVAL RECORDED</span><h1>Thank you</h1><p>{message}</p><a className="signin-button" href="/">Close <ArrowRight size={16}/></a></>:<>
      <div className="signin-icon"><ShieldAlert size={22}/></div><span className="signin-eyebrow">CURRENT OWNER CONFIRMATION</span><h1>Approve ownership transfer?</h1>
      <p>By approving, you confirm that you agree to transfer primary ownership. Your access remains unchanged until the incoming Owner also accepts.</p>
      {message&&<p className="signin-error" role="alert">{message}</p>}
      {state==='ready'&&<button className="signin-button" onClick={()=>void approve()}>Approve transfer <ArrowRight size={16}/></button>}
      {state==='sending'&&<div className="owner-home-state">Recording your approval…</div>}
    </>}
  </section></main>
}
