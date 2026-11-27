import { useState } from 'react'
import { ChefHat, ClipboardList, Settings, Store, Table2, LogOut, BarChart3 } from 'lucide-react'
import RestaurantOperations from './RestaurantOperations'
import RestaurantTables from './RestaurantTables'
import RestaurantMenu from './RestaurantMenu'
import RestaurantSettings from './RestaurantSettings'
import RestaurantReports from './RestaurantReports'

type StaffRole = 'cook' | 'waiter' | 'manager'
type Tool = 'menu' | 'tables' | 'operations' | 'settings' | 'reports'
type Props = { slug: string; role: StaffRole; displayName: string; onSignOut: () => void }

const managerTools: { id: Tool; label: string; icon: typeof Store }[] = [
  { id: 'menu', label: 'Menu', icon: Store },
  { id: 'tables', label: 'Tables', icon: Table2 },
  { id: 'operations', label: 'Operations', icon: ClipboardList },
  { id: 'settings', label: 'Settings', icon: Settings },
  { id: 'reports', label: 'Reports', icon: BarChart3 },
]

export default function StaffPortal({ slug, role, displayName, onSignOut }: Props) {
  const [activeTool, setActiveTool] = useState<Tool>(role === 'manager' ? 'operations' : role === 'waiter' ? 'operations' : 'operations')
  const roleLabel = role === 'cook' ? 'Kitchen staff' : role === 'waiter' ? 'Service staff' : 'Restaurant manager'

  return <div className="staff-portal">
    <header className="staff-portal-header">
      <div className="staff-portal-brand"><span><ChefHat size={20}/></span><div><b>platform<span>core</span></b><small>TEAM WORKSPACE</small></div></div>
      <div className="staff-portal-user"><div><b>{displayName || 'Team member'}</b><small>{roleLabel}</small></div><button type="button" onClick={onSignOut}><LogOut size={15}/> Sign out</button></div>
    </header>
    <main className="staff-portal-main">
      <div className="staff-portal-heading"><span className="owner-comms-kicker">STAFF WORKSPACE</span><h1>{role === 'cook' ? 'Kitchen queue' : role === 'waiter' ? 'Service board' : 'Restaurant operations'}</h1><p>Your access is limited to the role assigned by the restaurant owner.</p></div>
      {role === 'cook' ? <RestaurantOperations initialSlug={slug} initialTab="kitchen" allowedTabs={['kitchen']}/> :
       role === 'waiter' ? <RestaurantOperations initialSlug={slug} initialTab="waiter" allowedTabs={['waiter']}/> :
       <>
         <nav className="staff-portal-tabs">{managerTools.map(tool => { const Icon=tool.icon; return <button key={tool.id} className={activeTool===tool.id?'active':''} onClick={()=>setActiveTool(tool.id)}><Icon size={15}/>{tool.label}</button> })}</nav>
         {activeTool === 'menu' && <RestaurantMenu initialSlug={slug}/>}
         {activeTool === 'tables' && <RestaurantTables initialSlug={slug}/>}
         {activeTool === 'operations' && <RestaurantOperations initialSlug={slug}/>}
         {activeTool === 'settings' && <RestaurantSettings initialSlug={slug}/>}
         {activeTool === 'reports' && <RestaurantReports initialSlug={slug}/>}
       </>}
    </main>
  </div>
}
