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
import { AppList, SetupModal } from './setup'
import { Modal } from './ui'

type Sel = { key: string; floor: string | null } | null

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const viewRef = useRef<CityView | null>(null)
  const cardRef = useRef<HTMLDivElement>(null)
  const [city, setCity] = useState<City | null>(null)
  const [sel, setSel] = useState<Sel>(null)
  const [modal, setModal] = useState<'login' | 'signup' | 'add' | 'agent' | 'tool' | 'account' | 'apps' | null>(null)
  const [setupId, setSetupId] = useState<number | null>(null)   // "Make it your own" for this agent
  const [menu, setMenu] = useState(false)
  const [setupStep, setSetupStep] = useState(0)
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null)

  // back from Google's consent screen: say how it went, and pick up "Make it your own" where it was
  useEffect(() => {
    const q = new URLSearchParams(window.location.search)
    const connected = q.get('connected'), failed = q.get('connect_error')
    if (!connected && !failed) return
    const names = (connected ?? '').split(',').map(a => a === 'gmail' ? 'Gmail' : a === 'calendar' ? 'Google Calendar' : '').filter(Boolean)
    setNotice(failed ? { ok: false, text: failed } : { ok: true, text: names.length ? `Connected ${names.join(' and ')}.` : 'Google didn\'t grant any access.' })
    window.history.replaceState(null, '', window.location.pathname)
    try {
      const resume = sessionStorage.getItem('agenttown.resumeSetup')
      sessionStorage.removeItem('agenttown.resumeSetup')
      if (resume) { setSetupStep(1); setSetupId(Number(resume)) }
    } catch { /* private mode */ }
    const t = window.setTimeout(() => setNotice(null), 8000)
    return () => clearTimeout(t)
  }, [])
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

  // who's awake: lanterns, z's and NPCs on the map follow every agent's run, not just the open chat
  const signedIn = !!city?.me
  useEffect(() => {
    if (!signedIn) return
    let stop = false
    const tick = () => api.awake().then(a => { if (!stop) viewRef.current?.setStatuses(a) }, () => {})
    tick()
    const t = window.setInterval(tick, 6000)
    return () => { stop = true; clearInterval(t) }
  }, [signedIn, city])

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
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') { if (menu) setMenu(false); else if (!modal && setupId === null) setSel(null) } }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [modal, menu, setupId])

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
    v.setSideInsets(0, 0)                                    // talking happens in a dialogue box at the bottom
    v.setBottomInset(hasAgent ? (document.querySelector('.dialogue') as HTMLElement | null)?.offsetHeight ?? 260 : cardRef.current?.offsetHeight ?? 0)
    v.focusOn(sel.key)
  }, [sel?.key, hasCard, hasAgent]) // eslint-disable-line react-hooks/exhaustive-deps

  const me = city?.me
  const setupAgent = setupId !== null ? city?.agents.find(a => a.id === setupId) : undefined
  return (
    <>
      <canvas ref={canvasRef} className="city" />
      <header className="bar">
        <h1>Agent Town</h1>
        <span className="grow" />
        {me ? <>
          <button className="primary" onClick={() => setModal('add')}>+ Add agents</button>
          <button onClick={() => setModal('apps')}>Connect apps</button>
          <button className="who" onClick={() => setModal('account')} title="Your account and AI models">@{me.username}</button>
        </> : <>
          <button onClick={() => setModal('login')}>Sign in</button>
          <button className="primary" onClick={() => setModal('signup')}>Create account</button>
        </>}
        <div className="menu-wrap">
          <button className="more" aria-label="More" aria-expanded={menu} onClick={() => setMenu(!menu)}>⋯</button>
          {menu && <div className="menu" onMouseLeave={() => setMenu(false)}>
            <div className="menu-label">Map style</div>
            <div className="seg">{THEME_NAMES.map(n => (
              <button key={n} className={theme === n ? 'on' : ''} onClick={() => setTheme(n)}>{THEMES[n].title}</button>))}</div>
            <button onClick={() => { viewRef.current?.fit(); setMenu(false) }}>Show the whole town</button>
            {me && <button onClick={async () => { setMenu(false); await api.logout(); setSel(null); setRefit(true); reload() }}>Sign out</button>}
            <a className="menu-link" href="https://github.com/RushabhSingwi/agent-town/blob/main/PRIVACY.md" target="_blank" rel="noreferrer">Privacy policy</a>
          </div>}
        </div>
      </header>

      {city && !me && !thing && <div className="hello">
        <b>Welcome to Agent Town.</b> Your AI agents live here as characters in a little town: each has its own house,
        its own tools, and a chat window. Walk around with <b>W A S D</b>. <a href="#" onClick={e => { e.preventDefault(); setModal('signup') }}>Create
        an account</a> to build your own town, privately, and talk to your agents.
      </div>}
      {city && me && city.agents.length === 0 && !thing && <div className="hello">
        <b>Your town is empty.</b> Click <b>+ Add agents</b> to pick ready-made ones from the agent market, or bring your own
        (a single <code>.md</code> file, or a whole folder like <code>.claude</code>). Then walk up to one and press <b>E</b> to chat.
      </div>}

      {!thing && !(city && (!me || city.agents.length === 0)) &&
        <div className="controls-hint"><b>W A S D</b> or arrows to walk · <b>Shift</b> to run · <b>E</b> to talk · click the ground to walk there</div>}
      {card && <div ref={cardRef} className="dock">{card}</div>}
      {agent && city && <AgentView key={agent.id} agent={agent} city={city} floor={sel!.floor} reload={reload} onClose={() => setSel(null)}
        onStatus={s => viewRef.current?.setAgentStatus(agent.id, s)} onTool={server => viewRef.current?.sendCourier(agent.id, server)}
        onSetup={() => setSetupId(agent.id)} />}
      {notice && <div className={`notice ${notice.ok ? 'ok' : 'bad'}`} role="status">{notice.text}
        <button className="x" onClick={() => setNotice(null)} aria-label="Dismiss">×</button></div>}
      {setupAgent && city && !modal && <SetupModal key={`${setupAgent.id}:${setupStep}`} initialStep={setupStep} agent={setupAgent} city={city} reload={reload}
        onClose={() => { setSetupId(null); setSetupStep(0) }}
        onChat={() => { setSel({ key: `agent:${setupAgent.id}`, floor: null }); setSetupId(null); setSetupStep(0) }}
        onAccount={() => setModal('account')} onAdvanced={() => setModal('tool')} />}
      {modal === 'apps' && city && <Modal title="Connect your apps" onClose={() => setModal(null)} wide>
        <p className="hint">Connect an app once; then choose, per agent, which ones it may use (in its panel, or in "Make it your own").</p>
        <AppList city={city} reload={reload} onAdvanced={() => setModal('tool')} />
      </Modal>}

      {(modal === 'login' || modal === 'signup') && <AuthModal mode={modal} onClose={() => setModal(null)}
        onDone={() => { setModal(null); setRefit(true); reload() }} />}
      {modal === 'account' && me && <AccountModal username={me.username} onClose={() => { setModal(null); reload() }}
        onDeleted={() => { setModal(null); setSel(null); setSetupId(null); setRefit(true); reload() }} />}
      {modal === 'add' && <AddModal onClose={() => setModal(null)} onWrite={() => setModal('agent')}
        onDone={async id => { setModal(null); setRefit(true); await reload(); if (id) { setSel({ key: `agent:${id}`, floor: null }); setSetupId(id) } }} />}
      {modal === 'agent' && <NewAgentModal onClose={() => setModal(null)}
        onDone={async id => { setModal(null); setRefit(true); await reload(); setSel({ key: `agent:${id}`, floor: null }); setSetupId(id) }} />}
      {modal === 'tool' && <NewToolModal onClose={() => setModal(null)}
        onDone={async id => { setModal(null); setRefit(true); await reload(); if (setupId === null) setSel({ key: `station:${id}`, floor: null }) }} />}
    </>
  )
}
