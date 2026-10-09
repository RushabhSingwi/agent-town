import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, type City } from './api'
import { AgentView } from './agent'
import { LibraryCard, SharedAgentCard, SharedFilesCard, StationCard } from './cards'
import { layout, type Thing } from './city/layout'
import { CityView } from './city/render'
import { THEMES, THEME_NAMES, type ThemeName } from './city/themes'
import { AuthModal, NewAgentModal, NewToolModal } from './modals'
import { AccountModal } from './account'
import { AddModal } from './importer'

type Sel = { key: string; floor: string | null } | null

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const viewRef = useRef<CityView | null>(null)
  const cardRef = useRef<HTMLDivElement>(null)
  const [city, setCity] = useState<City | null>(null)
  const [sel, setSel] = useState<Sel>(null)
  const [modal, setModal] = useState<'login' | 'signup' | 'add' | 'agent' | 'tool' | 'account' | null>(null)
  const [refit, setRefit] = useState(true)
  const [theme, setTheme] = useState<ThemeName>(() => {
    try { const t = localStorage.getItem('agenttown.theme'); if (t && t in THEMES) return t as ThemeName } catch { /* private mode */ }
    return 'retro'
  })

  const reload = useCallback(async () => { setCity(await api.city()) }, [])
  useEffect(() => { reload() }, [reload])

  useEffect(() => {
    const v = new CityView(canvasRef.current!)
    viewRef.current = v
    return () => v.destroy()
  }, [])

  useEffect(() => {
    viewRef.current?.setTheme(theme)
    try { localStorage.setItem('agenttown.theme', theme) } catch { /* private mode */ }
  }, [theme])

  useEffect(() => { viewRef.current?.setPlayerName(city?.me ? `@${city.me.username}` : 'you') }, [city?.me])

  const L = useMemo(() => (city ? layout(city) : null), [city])
  useEffect(() => {
    if (!L || !viewRef.current) return
    viewRef.current.setLayout(L, refit)
    setRefit(false)
  }, [L]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const v = viewRef.current
    if (!v) return
    v.onSelect = (t: Thing | null, floor: string | null) => setSel(t ? { key: t.key, floor } : null)
    v.setSelected(sel?.key ?? null)
  }, [sel])

  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape' && !modal) setSel(null) }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [modal])

  // keep the selection valid after a reload (e.g. the agent was deleted)
  const thing = sel && L ? L.things.find(t => t.key === sel.key) : null
  useEffect(() => { if (sel && L && !thing) setSel(null) }, [sel, L, thing])

  // one of your agents: side panels (about + chat) instead of the bottom card
  const agent = city && thing?.kind === 'agent' ? city.agents.find(x => x.id === thing.id) : undefined

  const card = (() => {
    if (!city || !thing || thing.kind === 'agent') return null
    const close = () => setSel(null)
    if (thing.kind === 'station') {
      const c = city.connections.find(x => x.id === thing.id)
      return c && <StationCard key={c.id} conn={c} reload={reload} onClose={close} />
    }
    if (thing.kind === 'files') return <SharedFilesCard files={city.shared_files} reload={reload} onClose={close} />
    if (thing.kind === 'shared') {
      const s = city.public.find(x => x.id === thing.id)
      return s && <SharedAgentCard key={s.id} share={s} onClose={close} />
    }
    return <LibraryCard shares={city.public.filter(s => s.kind === 'file')} me={city.me?.username ?? null} reload={reload} onClose={close} />
  })()

  useEffect(() => { viewRef.current?.setBottomInset(cardRef.current?.offsetHeight ?? 0) })
  const hasCard = !!card, hasAgent = !!agent
  useEffect(() => {
    const v = viewRef.current
    if (!v || !sel || !(hasCard || hasAgent)) return
    const wide = innerWidth > 900
    v.setSideInsets(hasAgent && wide ? 372 : 0, hasAgent && wide ? 432 : 0)
    v.setBottomInset(hasAgent ? (wide ? 0 : innerHeight * 0.62) : cardRef.current?.offsetHeight ?? 0)
    v.focusOn(sel.key)
  }, [sel?.key, hasCard, hasAgent]) // eslint-disable-line react-hooks/exhaustive-deps

  const me = city?.me
  return (
    <>
      <canvas ref={canvasRef} className="city" />
      <header className="bar">
        <h1>Agent Town</h1>
        <span className="grow" />
        <select className="style-pick" value={theme} onChange={e => setTheme(e.target.value as ThemeName)} title="How the map looks">
          {THEME_NAMES.map(n => <option key={n} value={n}>{THEMES[n].title}</option>)}
        </select>
        <button onClick={() => viewRef.current?.fit()}>Fit</button>
        {me ? <>
          <button className="primary" onClick={() => setModal('add')}>+ Add agents</button>
          <button className="primary" onClick={() => setModal('tool')}>+ Tool</button>
          <button className="who" onClick={() => setModal('account')} title="Models and API tokens">@{me.username}</button>
          <button onClick={async () => { await api.logout(); setSel(null); setRefit(true); reload() }}>Sign out</button>
        </> : <>
          <button onClick={() => setModal('login')}>Sign in</button>
          <button className="primary" onClick={() => setModal('signup')}>Create account</button>
        </>}
      </header>

      {city && !me && !thing && <div className="hello">
        <b>Welcome to Agent Town.</b> Every agent here is a markdown file, drawn as a building.
        This is the public district: what people chose to share. <a href="#" onClick={e => { e.preventDefault(); setModal('signup') }}>Create an account</a> to
        build your own private district and connect your MCP tools.
      </div>}
      {city && me && city.agents.length === 0 && !thing && <div className="hello">
        <b>Your district is empty.</b> Click <b>+ Add agents</b> and drop in your agent files or a whole folder
        (like a <code>.claude</code> folder). Then open an agent and press <b>Chat</b>.
      </div>}

      {!thing && <div className="controls-hint"><b>W A S D</b> or arrows to walk · <b>Shift</b> to run · <b>E</b> to talk · click the ground to walk there</div>}
      {card && <div ref={cardRef} className="dock">{card}</div>}
      {agent && city && <AgentView key={agent.id} agent={agent} city={city} floor={sel!.floor} reload={reload} onClose={() => setSel(null)}
        onStatus={s => viewRef.current?.setAgentStatus(agent.id, s)} />}

      {(modal === 'login' || modal === 'signup') && <AuthModal mode={modal} onClose={() => setModal(null)}
        onDone={() => { setModal(null); setRefit(true); reload() }} />}
      {modal === 'account' && me && <AccountModal username={me.username} onClose={() => { setModal(null); reload() }} />}
      {modal === 'add' && <AddModal onClose={() => setModal(null)} onWrite={() => setModal('agent')}
        onDone={async id => { setModal(null); setRefit(true); await reload(); if (id) setSel({ key: `agent:${id}`, floor: null }) }} />}
      {modal === 'agent' && <NewAgentModal onClose={() => setModal(null)}
        onDone={async id => { setModal(null); setRefit(true); await reload(); setSel({ key: `agent:${id}`, floor: null }) }} />}
      {modal === 'tool' && <NewToolModal onClose={() => setModal(null)}
        onDone={async id => { setModal(null); setRefit(true); await reload(); setSel({ key: `station:${id}`, floor: null }) }} />}
    </>
  )
}
