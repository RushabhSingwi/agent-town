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

export function AgentView({ agent, city, floor, reload, onClose, onStatus }: {
  agent: MyAgent; city: City; floor: string | null; reload: Reload; onClose: () => void; onStatus: (s: RunStatus | null) => void
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
        <About agent={agent} city={city} floor={floor} creds={creds} reload={reload} onClose={onClose} />
      </aside>
      <aside className="side side-right">
        <ChatPanel key={agent.id} agent={agent} hasModel={creds === null || creds.length > 0} onStatus={onStatus} />
      </aside>
    </div>
  )
}

function About({ agent, city, floor, creds, reload, onClose }: { agent: MyAgent; city: City; floor: string | null; creds: Credential[] | null; reload: Reload; onClose: () => void }) {
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

  return (
    <div className="about">
      <div className="about-head">
        <h2><span className="sw" style={{ background: agent.color }} />{agent.name}
          <span className="pill">{agent.share_id ? 'shared publicly' : 'private'}</span></h2>
        <button className="x desktop-only" onClick={onClose} aria-label="Close">×</button>
      </div>
      {agent.description && <p className="tag">{agent.description}</p>}

      <h3>What it can do</h3>
      <ul className="can">
        <li>📄 Reads its {own.length ? `${own.length} file${own.length === 1 ? '' : 's'}` : 'instructions'}
          {shared.length > 0 && <> and your {shared.length} shared file{shared.length === 1 ? '' : 's'}</>}</li>
        <li>✍️ Writes and edits files while it works</li>
        {tools.map(c => {
          const g = grants.filter(x => x.connection_id === c.id)
          const n = g.some(x => x.tool_name === null) ? 'all its tools' : `${g.length} tool${g.length === 1 ? '' : 's'}`
          return <li key={c.id}>🔌 Uses <b>{c.name}</b> ({n}) <span className={`dot ${c.status}`} /></li>
        })}
        {agent.can_use_public && publicItems > 0 && <li>🌐 Reads {publicItems} thing{publicItems === 1 ? '' : 's'} people shared publicly</li>}
        {creds !== null && (cred
          ? <li>🧠 Thinks with <b>{cred.label}</b>{agent.model ? ` · ${agent.model}` : ''}</li>
          : <li className="warn">🧠 No model yet: add your Claude or ChatGPT account under your @username → Models</li>)}
      </ul>

      <h3>What it knows · {own.length + 1} files</h3>
      <ul className="list">
        {definition && <li onClick={() => setOpen(definition)}>
          <span className="grow"><b>Instructions</b> <span className="meta">AGENT.md</span></span>
          <span className="meta">{definition.lines} ln</span></li>}
        {[...own].sort((a, b) => b.lines - a.lines).map(f => (
          <li key={f.id} onClick={() => setOpen(f)}>
            <span className="grow">{f.path}{f.share_id ? <span className="mini">in library</span> : null}</span>
            <span className="meta">{f.lines} ln</span>
            <button className="tiny" title={f.share_id ? 'Remove from the public library' : 'Share in the public library'}
              onClick={e => { e.stopPropagation(); run(() => f.share_id ? api.unshare(f.share_id) : api.share({ kind: 'file', file_id: f.id })) }}>
              {f.share_id ? 'unshare' : 'share'}</button>
            <button className="tiny" title="Delete file" onClick={e => { e.stopPropagation(); if (confirm(`Delete ${f.path}?`)) run(() => api.deleteFile(agent.id, f.id)) }}>✕</button>
          </li>))}
      </ul>
      <label className="linklike">+ add files it should know
        <input type="file" multiple accept=".md,.txt" hidden onChange={async e => {
          const files = await readFiles(e.target.files)
          run(async () => { for (const f of files) await api.putFile(agent.id, f.path, f.content) })
        }} /></label>
      {shared.length > 0 && <details className="shared-pick">
        <summary className="meta">+ {shared.length} shared file{shared.length === 1 ? '' : 's'} all your agents read</summary>
        <ul className="list">{shared.map(f => <li key={f.id}><span className="grow">{f.path}</span><span className="meta">{f.lines} ln</span></li>)}</ul>
      </details>}

      <h3>Tools it may use</h3>
      {city.connections.length === 0 ? <p className="empty">No tools connected yet. Add one with <b>+ Tool</b> (for example Notion or GitHub).</p> :
        <ul className="list tools">
          {city.connections.map(c => (
            <li key={c.id} className="tool">
              <label className="grow"><input type="checkbox" checked={has(c, null)} onChange={() => toggle(c, null)} />
                <b>{c.name}</b> <span className={`dot ${c.status}`} /> <span className="meta">{has(c, null) ? 'all tools' : STATUS_LABEL[c.status]}</span></label>
              {!has(c, null) && c.tools.length > 0 && <div className="subtools">
                {c.tools.map(t => <label key={t.name} title={t.description}><input type="checkbox" checked={has(c, t.name)} onChange={() => toggle(c, t.name)} />{t.name}</label>)}
              </div>}
            </li>))}
        </ul>}

      <ModelPicker agent={agent} run={run} />

      <h3>Its building</h3>
      <div className="row tight">
        <select value={agent.building || ''} onChange={e => run(() => api.updateAgent(agent.id, { building: e.target.value }))}>
          <option value="">Automatic ({AGENT_BUILDINGS[agentBuilding({ ...agent, building: '' })]})</option>
          {Object.entries(AGENT_BUILDINGS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
      </div>

      <h3>Settings</h3>
      <label className="check"><input type="checkbox" checked={agent.can_use_public}
        onChange={e => run(() => api.updateAgent(agent.id, { can_use_public: e.target.checked }))} />
        May read what others shared in the public district</label>
      <div className="row">
        {agent.share_id
          ? <button onClick={() => run(() => api.unshare(agent.share_id!))}>Make private</button>
          : <><input className="note" placeholder="Note for the public (optional)" value={note} onChange={e => setNote(e.target.value)} />
            <button onClick={() => run(() => api.share({ kind: 'agent', agent_id: agent.id, note }))}>Share publicly</button></>}
      </div>
      <div className="row">
        <button onClick={() => setManifest(true)} title="Exactly what its sandbox is handed">Under the hood</button>
        <span className="grow" />
        <button className="danger" onClick={() => { if (confirm(`Delete ${agent.name} and its files?`)) run(async () => { await api.deleteAgent(agent.id); onClose() }) }}>Delete</button>
      </div>
      <Err error={error} />
      {open && <FileModal file={open} editable onClose={() => setOpen(null)}
        onSave={async content => { await api.putFile(agent.id, open.path, content); await reload(); setOpen(null) }} />}
      {manifest && <ManifestModal agentId={agent.id} onClose={() => setManifest(false)} />}
    </div>
  )
}
