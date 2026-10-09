// One of your agents. Walking up to it opens a dialogue (chat.tsx). Everything else lives inside its
// house: its instructions on the desk, its files on the bookshelf, what it knows about you on the
// noticeboard, its apps in the stable, its team on the portrait wall, and the rest in a chest.

import { useEffect, useState } from 'react'
import { api, type City, type Connection, type Credential, type FileFull, type Grant, type MyAgent, type RunStatus } from './api'
import { BrainPicker, FileModal, ManifestModal } from './cards'
import { Dialogue } from './chat'
import { AGENT_BUILDINGS, agentBuilding } from './city/kinds'
import { STATUS_LABEL } from './city/layout'
import { Err, Md, Modal, msg, readFiles } from './ui'

type Reload = () => Promise<void>

export function AgentView({ agent, city, floor, reload, onClose, onStatus, onTool, onSetup }: {
  agent: MyAgent; city: City; floor: string | null; reload: Reload; onClose: () => void; onStatus: (s: RunStatus | null) => void
  onTool: (server: string) => void; onSetup: () => void
}) {
  const [house, setHouse] = useState(false)
  const [creds, setCreds] = useState<Credential[] | null>(null)
  useEffect(() => { api.credentials().then(d => setCreds(d.credentials), () => setCreds([])) }, [])
  useEffect(() => { if (floor) setHouse(true) }, [floor])
  return <>
    <Dialogue key={agent.id} agent={agent} hasModel={creds === null || creds.length > 0} onStatus={onStatus} onTool={onTool}
      onHouse={() => setHouse(true)} onSetup={onSetup} onClose={onClose} />
    {house && <House agent={agent} city={city} creds={creds} reload={reload} onSetup={onSetup}
      onClose={() => setHouse(false)} onGone={() => { setHouse(false); onClose() }} />}
  </>
}

type Spot = 'desk' | 'books' | 'board' | 'stable' | 'team' | 'chest'

function House({ agent, city, creds, reload, onSetup, onClose, onGone }: {
  agent: MyAgent; city: City; creds: Credential[] | null; reload: Reload; onSetup: () => void; onClose: () => void; onGone: () => void
}) {
  const [spot, setSpot] = useState<Spot | null>(null)
  const [open, setOpen] = useState<FileFull | null>(null)
  const [manifest, setManifest] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState('')

  const run = async (fn: () => Promise<unknown>) => {
    setError(null)
    try { await fn(); await reload() } catch (e) { setError(msg(e)) }
  }

  const grants = agent.grants
  const has = (c: Connection, tool: string | null) => grants.some(g => g.connection_id === c.id && g.tool_name === tool)
  const toggleTool = (c: Connection, tool: string) => {
    let next: Grant[]
    if (has(c, null)) next = [...grants.filter(g => g.connection_id !== c.id),                       // all but this one
      ...c.tools.filter(x => x.name !== tool).map(x => ({ connection_id: c.id, tool_name: x.name }))]
    else if (has(c, tool)) next = grants.filter(g => !(g.connection_id === c.id && g.tool_name === tool))
    else next = [...grants, { connection_id: c.id, tool_name: tool }]
    run(() => api.setGrants(agent.id, next))
  }

  const definition = agent.files.find(f => f.path === 'AGENT.md')
  const about = agent.files.find(f => f.path === 'about-me.md')
  const books = agent.files.filter(f => f.path !== 'AGENT.md' && f.path !== 'about-me.md')
  const shared = city.shared_files ?? []
  const apps = city.connections.filter(c => grants.some(g => g.connection_id === c.id))
  const others = city.agents.filter(a => a.id !== agent.id)
  const team = others.filter(a => agent.team.includes(a.id))
  const cred = creds && (creds.find(c => c.id === agent.model_credential_id) ?? creds.find(c => c.is_default))
  const claude = !cred || cred.provider === 'anthropic'

  const furniture: { key: Spot; icon: string; name: string; says: string }[] = [
    { key: 'desk', icon: '📜', name: 'Desk', says: 'its instructions' },
    { key: 'books', icon: '📚', name: 'Bookshelf', says: `${books.length + shared.length} book${books.length + shared.length === 1 ? '' : 's'}` },
    { key: 'board', icon: '📌', name: 'Noticeboard', says: about ? 'what it knows about you' : 'nothing about you yet' },
    { key: 'stable', icon: '🐴', name: 'Stable', says: apps.length ? apps.map(a => a.name).join(', ') : 'no apps yet' },
    { key: 'team', icon: '🖼️', name: 'Portraits', says: team.length ? `its team of ${team.length}` : 'works alone' },
    { key: 'chest', icon: '🧰', name: 'Chest', says: 'its brain and settings' },
  ]

  return (
    <Modal title={`Inside ${agent.name}'s house`} onClose={onClose} wide>
      <div className="room">
        {furniture.map(f => (
          <button key={f.key} className={`furniture${spot === f.key ? ' on' : ''}`} onClick={() => setSpot(spot === f.key ? null : f.key)}>
            <span className="f-icon" aria-hidden="true">{f.icon}</span><b>{f.name}</b><span className="f-says">{f.says}</span>
          </button>))}
      </div>
      {!spot && <p className="hint room-hint">Look around: click anything in the room.</p>}

      {spot === 'desk' && definition && <section className="spot">
        <h3>Its instructions</h3>
        <p className="hint">This is who {agent.name} is and how it works. Change it if you like; it takes effect next chat.</p>
        <button className="primary" onClick={() => setOpen(definition)}>Read or edit ({definition.lines} lines)</button>
      </section>}

      {spot === 'books' && <section className="spot">
        <h3>Bookshelf</h3>
        {books.length === 0 && shared.length === 0 && <p className="empty">No books yet. Add notes, playbooks or examples it should read.</p>}
        <ul className="list">
          {[...books].sort((a, b) => b.lines - a.lines).map(f => (
            <li key={f.id} onClick={() => setOpen(f)}><span className="grow">📕 {f.path}</span><span className="meta">{f.lines} lines</span>
              <button className="tiny" title="Throw away" onClick={e => { e.stopPropagation(); if (confirm(`Delete ${f.path}?`)) run(() => api.deleteFile(agent.id, f.id)) }}>✕</button></li>))}
          {shared.map(f => <li key={`s${f.id}`}><span className="grow">📗 {f.path}</span><span className="meta">shared, all your agents</span></li>)}
        </ul>
        <label className="linklike">+ put a book on the shelf
          <input type="file" multiple accept=".md,.txt" hidden onChange={async e => {
            const files = await readFiles(e.target.files)
            run(async () => { for (const f of files) await api.putFile(agent.id, f.path, f.content) })
          }} /></label>
      </section>}

      {spot === 'board' && <section className="spot">
        <h3>Noticeboard: about you</h3>
        {about ? <div className="pinned"><Md text={about.content} /></div> : <p className="empty">{agent.name} doesn't know anything about you yet.</p>}
        <button className="primary" onClick={onSetup}>{about ? 'Change what it knows' : 'Tell it about you'}</button>
      </section>}

      {spot === 'stable' && <section className="spot">
        <h3>Stable: apps it can use</h3>
        {city.connections.length === 0 ? <p className="empty">No apps connected yet. Use <b>Connect apps</b> at the top, or <b>Make it your own</b>.</p> :
          <ul className="list tools">{city.connections.map(c => {
            const any = grants.some(g => g.connection_id === c.id)
            return <li key={c.id} className="tool">
              <label className="grow"><input type="checkbox" checked={any}
                onChange={() => run(() => api.setGrants(agent.id, any ? grants.filter(g => g.connection_id !== c.id) : [...grants, { connection_id: c.id, tool_name: null }]))} />
                <b>{c.name}</b> <span className={`dot ${c.status}`} /> <span className="meta">{STATUS_LABEL[c.status]}</span></label>
              {any && c.tools.length > 0 && <details><summary className="meta">which of its tools</summary><div className="subtools">
                {c.tools.map(t => <label key={t.name} title={t.description}>
                  <input type="checkbox" checked={has(c, null) || has(c, t.name)} onChange={() => toggleTool(c, t.name)} />{t.name}</label>)}</div></details>}
            </li>
          })}</ul>}
      </section>}

      {spot === 'team' && <section className="spot">
        <h3>Portrait wall: its team</h3>
        {others.length === 0 ? <p className="empty">Add more agents and {agent.name} can hand work to them.</p> : <>
          <ul className="list tools">{others.map(o => (
            <li key={o.id} className="tool"><label className="grow"><input type="checkbox" checked={agent.team.includes(o.id)}
              onChange={() => run(() => api.setTeam(agent.id, agent.team.includes(o.id) ? agent.team.filter(i => i !== o.id) : [...agent.team, o.id]))} />
              <b>{o.name}</b> <span className="meta wrap">{o.description.slice(0, 80)}</span></label></li>))}</ul>
          <p className="hint">It can hand a job to anyone ticked here.{!claude && ' Needs a Claude model: on ChatGPT it works alone.'}</p>
        </>}
      </section>}

      {spot === 'chest' && <section className="spot">
        <h3>Its brain</h3>
        <BrainPicker agent={agent} run={run} />
        <h3>Its house on the map</h3>
        <div className="row tight">
          <select value={agent.building || ''} onChange={e => run(() => api.updateAgent(agent.id, { building: e.target.value }))}>
            <option value="">Automatic ({AGENT_BUILDINGS[agentBuilding({ ...agent, building: '' })]})</option>
            {Object.entries(AGENT_BUILDINGS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </div>
        <h3>Sharing</h3>
        <label className="check"><input type="checkbox" checked={agent.can_use_public}
          onChange={e => run(() => api.updateAgent(agent.id, { can_use_public: e.target.checked }))} />
          May read what other people shared publicly</label>
        <div className="row">
          {agent.share_id
            ? <button onClick={() => run(() => api.unshare(agent.share_id!))}>Make private</button>
            : <><input className="note" placeholder="Note for others (optional)" value={note} onChange={e => setNote(e.target.value)} />
              <button onClick={() => run(() => api.share({ kind: 'agent', agent_id: agent.id, note }))}>Share publicly</button></>}
        </div>
        <div className="row">
          <button onClick={() => setManifest(true)} title="Exactly what its sandbox is handed">Under the hood</button>
          <span className="grow" />
          <button className="danger" onClick={() => { if (confirm(`Delete ${agent.name} and its house?`)) run(async () => { await api.deleteAgent(agent.id); onGone() }) }}>Delete {agent.name}</button>
        </div>
      </section>}

      <Err error={error} />
      {open && <FileModal file={open} editable onClose={() => setOpen(null)}
        onSave={async content => { await api.putFile(agent.id, open.path, content); await reload(); setOpen(null) }} />}
      {manifest && <ManifestModal agentId={agent.id} onClose={() => setManifest(false)} />}
    </Modal>
  )
}
