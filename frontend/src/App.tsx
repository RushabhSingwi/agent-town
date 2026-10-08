import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, type City } from './api'
import { AgentCard, LibraryCard, SharedAgentCard, StationCard } from './cards'
import { layout, type Thing } from './city/layout'
import { CityView } from './city/render'
import { AuthModal, NewAgentModal, NewToolModal } from './modals'
import { AccountModal } from './account'

type Sel = { key: string; floor: string | null } | null

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const viewRef = useRef<CityView | null>(null)
  const cardRef = useRef<HTMLDivElement>(null)
  const [city, setCity] = useState<City | null>(null)
  const [sel, setSel] = useState<Sel>(null)
  const [modal, setModal] = useState<'login' | 'signup' | 'agent' | 'tool' | 'account' | null>(null)
  const [refit, setRefit] = useState(true)

  const reload = useCallback(async () => { setCity(await api.city()) }, [])
  useEffect(() => { reload() }, [reload])

  useEffect(() => {
    const v = new CityView(canvasRef.current!)
    viewRef.current = v
    return () => v.destroy()
  }, [])

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

  const card = (() => {
    if (!city || !thing) return null
    const close = () => setSel(null)
    if (thing.kind === 'agent') {
      const a = city.agents.find(x => x.id === thing.id)
      return a && <AgentCard key={a.id} agent={a} city={city} floor={sel!.floor} reload={reload} onClose={close} />
    }
    if (thing.kind === 'station') {
      const c = city.connections.find(x => x.id === thing.id)
      return c && <StationCard key={c.id} conn={c} reload={reload} onClose={close} />
    }
    if (thing.kind === 'shared') {
      const s = city.public.find(x => x.id === thing.id)
      return s && <SharedAgentCard key={s.id} share={s} onClose={close} />
    }
    return <LibraryCard shares={city.public.filter(s => s.kind === 'file')} me={city.me?.username ?? null} reload={reload} onClose={close} />
  })()

  useEffect(() => { viewRef.current?.setBottomInset(cardRef.current?.offsetHeight ?? 0) })
  const hasCard = !!card
  useEffect(() => {
    const v = viewRef.current
    if (!v || !sel || !hasCard) return
    v.setBottomInset(cardRef.current?.offsetHeight ?? 0)
    v.focusOn(sel.key)
  }, [sel?.key, hasCard]) // eslint-disable-line react-hooks/exhaustive-deps

  const me = city?.me
  return (
    <>
      <canvas ref={canvasRef} className="city" />
      <header className="bar">
        <h1>Agent Town</h1>
        <span className="grow" />
        <button onClick={() => viewRef.current?.fit()}>Fit</button>
        {me ? <>
          <button className="primary" onClick={() => setModal('agent')}>+ Agent</button>
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
        <b>Your district is empty.</b> Add an agent (a markdown file, like a Claude Code agent) with <b>+ Agent</b>, and connect MCP servers with <b>+ Tool</b>.
      </div>}

      {card && <div ref={cardRef} className="dock">{card}</div>}

      {(modal === 'login' || modal === 'signup') && <AuthModal mode={modal} onClose={() => setModal(null)}
        onDone={() => { setModal(null); setRefit(true); reload() }} />}
      {modal === 'account' && me && <AccountModal username={me.username} onClose={() => { setModal(null); reload() }} />}
      {modal === 'agent' && <NewAgentModal onClose={() => setModal(null)}
        onDone={async id => { setModal(null); setRefit(true); await reload(); setSel({ key: `agent:${id}`, floor: null }) }} />}
      {modal === 'tool' && <NewToolModal onClose={() => setModal(null)}
        onDone={async id => { setModal(null); setRefit(true); await reload(); setSel({ key: `station:${id}`, floor: null }) }} />}
    </>
  )
}
