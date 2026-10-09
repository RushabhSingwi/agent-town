// Clicking one of your agents: what it is on the left, a chat with it on the right, the city in between.
// On a phone the two sides become tabs.

import { useEffect, useState } from 'react'
import { api, type City, type Connection, type Credential, type FileFull, type Grant, type MyAgent, type RunStatus } from './api'
import { FileModal, ManifestModal, ModelPicker } from './cards'
import { ChatPanel } from './chat'
import { AGENT_BUILDINGS, agentBuilding } from './city/kinds'
import { STATUS_LABEL } from './city/layout'
import { Err, msg, readFiles } from './ui'

type Reload = () => Promise<void>

export function AgentView({ agent, city, floor, reload, onClose, onStatus, onSetup }: {
  agent: MyAgent; city: City; floor: string | null; reload: Reload; onClose: () => void; onStatus: (s: RunStatus | null) => void
  onSetup: () => void
}) {
  const [tab, setTab] = useState<'chat' | 'about'>('chat')
  const [creds, setCreds] = useState<Credential[] | null>(null)
  useEffect(() => { api.credentials().then(d => setCreds(d.credentials), () => setCreds([])) }, [])
  return (
    <div className={`agent-view tab-${tab}`}>
      <div className="agent-tabs">
        <button className={tab === 'chat' ? 'on' : ''} onClick={() => setTab('chat')}>Chat</button>
        <button className={tab === 'about' ? 'on' : ''} onClick={() => setTab('about')}>About {agent.name}</button>
        <button className="x" onClick={onClose} aria-label="Close">×</button>
      </div>
      <aside className="side side-left">
        <About agent={agent} city={city} floor={floor} creds={creds} reload={reload} onClose={onClose} onSetup={onSetup} />
      </aside>
      <aside className="side side-right">
        <ChatPanel key={agent.id} agent={agent} hasModel={creds === null || creds.length > 0} onStatus={onStatus} />
      </aside>
    </div>
  )
}

function About({ agent, city, floor, creds, reload, onClose, onSetup }: {
  agent: MyAgent; city: City; floor: string | null; creds: Credential[] | null; reload: Reload; onClose: () => void; onSetup: () => void
}) {
  const [open, setOpen] = useState<FileFull | null>(null)
  const [manifest, setManifest] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState('')

  useEffect(() => {
    const f = floor ? agent.files.find(x => x.path === floor) : null
    if (f) setOpen(f)
  }, [floor, agent.files])

  const run = async (fn: () => Promise<unknown>) => {
    setError(null)
    try { await fn(); await reload() } catch (e) { setError(msg(e)) }
  }

  const grants = agent.grants
  const has = (c: Connection, tool: string | null) => grants.some(g => g.connection_id === c.id && g.tool_name === tool)
  const toggle = (c: Connection, tool: string | null) => {
    let next: Grant[]
    if (has(c, tool)) next = grants.filter(g => !(g.connection_id === c.id && g.tool_name === tool))
    else if (tool === null) next = [...grants.filter(g => g.connection_id !== c.id), { connection_id: c.id, tool_name: null }]
    else next = [...grants.filter(g => !(g.connection_id === c.id && g.tool_name === null)), { connection_id: c.id, tool_name: tool }]
    run(() => api.setGrants(agent.id, next))
  }

  const own = agent.files.filter(f => f.path !== 'AGENT.md')
  const shared = city.shared_files ?? []
  const tools = city.connections.filter(c => grants.some(g => g.connection_id === c.id))
  const cred = creds && (creds.find(c => c.id === agent.model_credential_id) ?? creds.find(c => c.is_default))
  const publicItems = city.public.filter(s => s.allow_agent_use && s.agent?.id !== agent.id).length
  const definition = agent.files.find(f => f.path === 'AGENT.md')
  const others = city.agents.filter(a => a.id !== agent.id)
  const team = others.filter(a => agent.team.includes(a.id))
  const claude = !cred || cred.provider === 'anthropic'

  return (
    <div className="about">
      <div className="about-head">
        <h2><span className="sw" style={{ background: agent.color }} />{agent.name}
          <span className="pill">{agent.share_id ? 'shared publicly' : 'private'}</span></h2>
        <button className="x desktop-only" onClick={onClose} aria-label="Close">×</button>
      </div>
      {agent.description && <p className="tag">{agent.description}</p>}
      <button className="primary setup-btn" onClick={onSetup}>{agent.files.some(f => f.path === 'about-me.md') ? 'Personalize it' : 'Make it your own'}</button>

      <h3>What it can do</h3>
      <ul className="can">
        <li>📄 Knows {own.length ? `${own.length} file${own.length === 1 ? '' : 's'}` : 'its instructions'}
          {shared.length > 0 && <> and your {shared.length} shared file{shared.length === 1 ? '' : 's'}</>}</li>
        {agent.files.some(f => f.path === 'about-me.md') && <li>🙋 Knows about you</li>}
        {tools.map(c => <li key={c.id}>🔌 Uses <b>{c.name}</b> <span className={`dot ${c.status}`} /></li>)}
        {team.length > 0 && <li>👥 Hands work to {team.map(a => a.name).join(', ')}{!claude && ' (needs a Claude model)'}</li>}
        {creds !== null && (cred
          ? <li>🧠 Thinks with <b>{cred.label}</b></li>
          : <li className="warn">🧠 Needs an AI account to think with: use the button above</li>)}
      </ul>

      <h3>Apps it can use</h3>
      {city.connections.length === 0 ? <p className="empty">No apps connected yet. Use <b>Make it your own</b> or <b>Connect apps</b> at the top.</p> :
        <ul className="list tools">
          {city.connections.map(c => {
            const any = grants.some(g => g.connection_id === c.id)
            return <li key={c.id} className="tool">
              <label className="grow"><input type="checkbox" checked={any}
                onChange={() => run(() => api.setGrants(agent.id, any ? grants.filter(g => g.connection_id !== c.id) : [...grants, { connection_id: c.id, tool_name: null }]))} />
                <b>{c.name}</b> <span className={`dot ${c.status}`} /></label>
            </li>
          })}
        </ul>}

      <h3>What it knows</h3>
      <ul className="list">
        {definition && <li onClick={() => setOpen(definition)}>
          <span className="grow"><b>Its instructions</b></span><span className="meta">{definition.lines} lines</span></li>}
        {[...own].sort((a, b) => b.lines - a.lines).map(f => (
          <li key={f.id} onClick={() => setOpen(f)}>
            <span className="grow">{f.path === 'about-me.md' ? <b>About you</b> : f.path}</span>
            <span className="meta">{f.lines} lines</span>
            <button className="tiny" title="Delete file" onClick={e => { e.stopPropagation(); if (confirm(`Delete ${f.path}?`)) run(() => api.deleteFile(agent.id, f.id)) }}>✕</button>
          </li>))}
      </ul>
      <label className="linklike">+ add files it should know
        <input type="file" multiple accept=".md,.txt" hidden onChange={async e => {
          const files = await readFiles(e.target.files)
          run(async () => { for (const f of files) await api.putFile(agent.id, f.path, f.content) })
        }} /></label>

      {others.length > 0 && <>
        <h3>Its team</h3>
        <ul className="list tools">{others.map(o => (
          <li key={o.id} className="tool"><label className="grow"><input type="checkbox" checked={agent.team.includes(o.id)}
            onChange={() => run(() => api.setTeam(agent.id, agent.team.includes(o.id) ? agent.team.filter(i => i !== o.id) : [...agent.team, o.id]))} />
            <b>{o.name}</b> <span className="meta wrap">{o.description.slice(0, 80)}</span></label></li>))}</ul>
        <p className="hint">It can hand a job to anyone ticked here.{!claude && ' Needs a Claude model: on ChatGPT it works alone.'}</p>
      </>}

      <details className="more-settings">
        <summary>More settings</summary>
        <ModelPicker agent={agent} run={run} />

        <h3>Its building on the map</h3>
        <div className="row tight">
          <select value={agent.building || ''} onChange={e => run(() => api.updateAgent(agent.id, { building: e.target.value }))}>
            <option value="">Automatic ({AGENT_BUILDINGS[agentBuilding({ ...agent, building: '' })]})</option>
            {Object.entries(AGENT_BUILDINGS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </div>

        {tools.length > 0 && <>
          <h3>Pick individual app tools</h3>
          <ul className="list tools">{tools.map(c => (
            <li key={c.id} className="tool"><b>{c.name}</b>
              <div className="subtools">{c.tools.map(t => <label key={t.name} title={t.description}>
                <input type="checkbox" checked={has(c, null) || has(c, t.name)} onChange={() => has(c, null)
                  ? run(() => api.setGrants(agent.id, [...grants.filter(g => g.connection_id !== c.id),          // all but this one
                    ...c.tools.filter(x => x.name !== t.name).map(x => ({ connection_id: c.id, tool_name: x.name }))]))
                  : toggle(c, t.name)} />{t.name}</label>)}
                {c.tools.length === 0 && <span className="meta">{STATUS_LABEL[c.status]}</span>}</div></li>))}</ul>
        </>}

        {shared.length > 0 && <>
          <h3>Shared files it also reads</h3>
          <ul className="list">{shared.map(f => <li key={f.id}><span className="grow">{f.path}</span><span className="meta">{f.lines} lines</span></li>)}</ul>
        </>}

        <h3>Sharing</h3>
        <label className="check"><input type="checkbox" checked={agent.can_use_public}
          onChange={e => run(() => api.updateAgent(agent.id, { can_use_public: e.target.checked }))} />
          May read what other people shared publicly{publicItems > 0 ? ` (${publicItems})` : ''}</label>
        <div className="row">
          {agent.share_id
            ? <button onClick={() => run(() => api.unshare(agent.share_id!))}>Make private</button>
            : <><input className="note" placeholder="Note for others (optional)" value={note} onChange={e => setNote(e.target.value)} />
              <button onClick={() => run(() => api.share({ kind: 'agent', agent_id: agent.id, note }))}>Share publicly</button></>}
        </div>
        <div className="row">
          <button onClick={() => setManifest(true)} title="Exactly what its sandbox is handed">Under the hood</button>
          <span className="grow" />
          <button className="danger" onClick={() => { if (confirm(`Delete ${agent.name} and its files?`)) run(async () => { await api.deleteAgent(agent.id); onClose() }) }}>Delete</button>
        </div>
      </details>
      <Err error={error} />
      {open && <FileModal file={open} editable onClose={() => setOpen(null)}
        onSave={async content => { await api.putFile(agent.id, open.path, content); await reload(); setOpen(null) }} />}
      {manifest && <ManifestModal agentId={agent.id} onClose={() => setManifest(false)} />}
    </div>
  )
}
