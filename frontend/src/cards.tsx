// The card at the bottom of the screen: whatever you clicked in the city.

import { useEffect, useState } from 'react'
import { api, type Connection, type Credential, type FileFull, type MyAgent, type Share, type SharedFile } from './api'
import { STATUS_LABEL } from './city/layout'
import { Err, Md, Modal, msg, readFiles } from './ui'

type Reload = () => Promise<void>

const ago = (iso: string | null) => {
  if (!iso) return 'never'
  const s = (Date.now() - Date.parse(iso)) / 1000
  return s < 60 ? 'just now' : s < 3600 ? `${(s / 60) | 0}m ago` : s < 86400 ? `${(s / 3600) | 0}h ago` : `${(s / 86400) | 0}d ago`
}

export function FileModal({ file, editable, onClose, onSave }: { file: FileFull; editable: boolean; onClose: () => void; onSave?: (content: string) => Promise<void> }) {
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState(file.content)
  const [error, setError] = useState<string | null>(null)
  return (
    <Modal title={file.path} onClose={onClose} wide>
      <p className="hint">{file.lines} lines · {file.bytes.toLocaleString()} bytes</p>
      {editing ? <>
        <textarea className="editor" value={text} onChange={e => setText(e.target.value)} rows={20} spellCheck={false} />
        <Err error={error} />
        <div className="row"><button className="primary" onClick={async () => {
          try { await onSave!(text); setEditing(false) } catch (e) { setError(msg(e)) }
        }}>Save</button><button onClick={() => { setEditing(false); setText(file.content) }}>Cancel</button></div>
      </> : <>
        <Md text={file.content} />
        {editable && <button onClick={() => setEditing(true)}>Edit</button>}
      </>}
    </Modal>
  )
}

export function ManifestModal({ agentId, onClose }: { agentId: number; onClose: () => void }) {
  const [data, setData] = useState<string>('Loading…')
  useEffect(() => { api.manifest(agentId).then(m => setData(JSON.stringify(m, null, 2)), e => setData(msg(e))) }, [agentId])
  return (
    <Modal title="Manifest" onClose={onClose} wide>
      <p className="hint">What this agent is handed when it runs: its instructions, files, the tools it may use, and the public
        items it can read. Its sandbox starts from exactly this. Credentials are never in it: the sandbox
        fetches them separately, with a token that only works for that one run.</p>
      <pre className="json">{data}</pre>
    </Modal>
  )
}

// ---------- an MCP connection ----------
export function StationCard({ conn, reload, onClose }: { conn: Connection; reload: Reload; onClose: () => void }) {
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [auth, setAuth] = useState('')
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true); setError(null)
    try { await fn(); await reload() } catch (e) { setError(msg(e)) } finally { setBusy(false) }
  }
  return (
    <div className="card">
      <button className="x" onClick={onClose} aria-label="Close">×</button>
      <h2><span className={`dot big ${conn.status}`} />{conn.name}<span className="pill">{STATUS_LABEL[conn.status]}</span></h2>
      <p className="tag mono">{conn.transport === 'http' ? conn.url : `$ ${conn.command}`}</p>
      <p className="hint">{conn.status_detail} · checked {ago(conn.last_checked_at)}
        {conn.server_name && <> · server <b>{conn.server_name}</b> {conn.server_version}</>}
        {conn.has_auth && <> · credentials stored</>}</p>
      <div className="cols">
        <section>
          <h3>Tools · {conn.tools.length}</h3>
          {conn.tools.length ? <ul className="list">{conn.tools.map(t => (
            <li key={t.name}><span className="grow"><b className="mono">{t.name}</b><div className="meta wrap">{t.description}</div></span></li>))}</ul>
            : <p className="empty">{conn.transport === 'stdio' ? 'Listed once it runs in a sandbox.' : 'None listed yet.'}</p>}
        </section>
        <section>
          <h3>Used by</h3>
          {conn.granted_to.length ? <ul className="list">{conn.granted_to.map((g, i) => (
            <li key={i}><span className="grow">{g.agent}</span><span className="meta">{g.tool_name ?? 'all tools'}</span></li>))}</ul>
            : <p className="empty">No agent yet. Open an agent and tick this tool.</p>}
          {conn.transport === 'http' && <div className="row">
            <input className="note" type="password" placeholder={conn.has_auth ? 'Replace Authorization header' : 'Authorization header (e.g. Bearer …)'}
              value={auth} onChange={e => setAuth(e.target.value)} autoComplete="off" />
            <button disabled={!auth || busy} onClick={() => run(async () => { await api.updateConnection(conn.id, { auth_header: auth }); setAuth('') })}>Save</button>
          </div>}
        </section>
      </div>
      <div className="row">
        <button className="primary" disabled={busy} onClick={() => run(() => api.checkConnection(conn.id))}>{busy ? 'Checking…' : 'Check again'}</button>
        <span className="grow" />
        <button className="danger" onClick={() => { if (confirm(`Remove ${conn.name}?`)) run(async () => { await api.deleteConnection(conn.id); onClose() }) }}>Remove</button>
      </div>
      <Err error={error} />
    </div>
  )
}

// ---------- the public district ----------
export function SharedAgentCard({ share, onClose }: { share: Share; onClose: () => void }) {
  const [full, setFull] = useState<Share | null>(null)
  const [open, setOpen] = useState<FileFull | null>(null)
  useEffect(() => { api.getShare(share.id).then(setFull) }, [share.id])
  const a = (full ?? share).agent!
  return (
    <div className="card">
      <button className="x" onClick={onClose} aria-label="Close">×</button>
      <h2><span className="sw" style={{ background: a.color }} />{a.name}<span className="pill">by @{share.owner}</span></h2>
      {a.description && <p className="tag">{a.description}</p>}
      {share.note && <p className="note-box">“{share.note}”</p>}
      <p className="hint">{share.allow_agent_use ? 'Other people’s agents can read and consult it.' : 'Readable by people; not offered to other agents.'}</p>
      <h3>Floors · {a.files.length} files · {a.lines} lines</h3>
      <ul className="list">{a.files.map(f => (
        <li key={f.id} onClick={() => 'content' in f && setOpen(f as FileFull)}><span className="grow">{f.path}</span><span className="meta">{f.lines} ln</span></li>))}</ul>
      {open && <FileModal file={open} editable={false} onClose={() => setOpen(null)} />}
    </div>
  )
}

export function LibraryCard({ shares, me, reload, onClose }: { shares: Share[]; me: string | null; reload: Reload; onClose: () => void }) {
  const [open, setOpen] = useState<FileFull | null>(null)
  return (
    <div className="card">
      <button className="x" onClick={onClose} aria-label="Close">×</button>
      <h2>📚 Library<span className="pill">{shares.length} shared files</span></h2>
      <p className="tag">Knowledge people shared from their agents. Agents that may read the public district get these.</p>
      <ul className="list">{shares.map(s => (
        <li key={s.id} onClick={async () => { const full = await api.getShare(s.id); setOpen(full.file as FileFull) }}>
          <span className="grow">{s.title}<div className="meta">@{s.owner} · from {s.file && 'agent' in s.file ? s.file.agent : ''}{s.note ? ` · ${s.note}` : ''}</div></span>
          <span className="meta">{s.file?.lines} ln</span>
          {me === s.owner && <button className="tiny" onClick={async e => { e.stopPropagation(); await api.unshare(s.id); await reload() }}>unshare</button>}
        </li>))}</ul>
      {open && <FileModal file={open} editable={false} onClose={() => setOpen(null)} />}
    </div>
  )
}

export function ModelPicker({ agent, run }: { agent: MyAgent; run: (fn: () => Promise<unknown>) => Promise<void> }) {
  const [creds, setCreds] = useState<Credential[] | null>(null)
  const [model, setModel] = useState(agent.model)
  useEffect(() => { api.credentials().then(d => setCreds(d.credentials), () => setCreds([])) }, [])
  if (creds === null) return null
  const def = creds.find(c => c.is_default)
  return (
    <>
      <h3>Runs on</h3>
      {creds.length === 0 ? <p className="empty">No model key yet. Add your API key under your @username (top right).</p> :
        <div className="row tight">
          <select value={agent.model_credential_id ?? 0}
            onChange={e => run(() => api.updateAgent(agent.id, { model_credential_id: Number(e.target.value) }))}>
            <option value={0}>Default{def ? ` (${def.label})` : ''}</option>
            {creds.map(c => <option key={c.id} value={c.id}>{c.label}{c.hint ? ` …${c.hint}` : ''}</option>)}
          </select>
          <input className="note" value={model} placeholder="model (blank = provider default)" onChange={e => setModel(e.target.value)}
            onBlur={() => model !== agent.model && run(() => api.updateAgent(agent.id, { model }))} />
        </div>}
    </>
  )
}

// ---------- your shared files ----------
export function SharedFilesCard({ files, reload, onClose }: { files: SharedFile[]; reload: Reload; onClose: () => void }) {
  const [open, setOpen] = useState<FileFull | null>(null)
  const [error, setError] = useState<string | null>(null)
  const run = async (fn: () => Promise<unknown>) => {
    setError(null)
    try { await fn(); await reload() } catch (e) { setError(msg(e)) }
  }
  return (
    <div className="card">
      <button className="x" onClick={onClose} aria-label="Close">×</button>
      <h2>🗂 Shared files<span className="pill">private · {files.length} files</span></h2>
      <p className="tag">Knowledge every one of your agents can read: put things several agents need here once, like "about us" or a style guide.</p>
      <ul className="list">{files.map(f => (
        <li key={f.id} onClick={async () => { const full = await api.sharedFile(f.id); setOpen({ ...full, content: full.content }) }}>
          <span className="grow">{f.path}</span><span className="meta">{f.lines} ln</span>
          <button className="tiny" title="Delete file" onClick={e => { e.stopPropagation(); if (confirm(`Delete ${f.path}?`)) run(() => api.deleteSharedFile(f.id)) }}>✕</button>
        </li>))}</ul>
      <label className="linklike">+ add files
        <input type="file" multiple accept=".md,.txt" hidden onChange={async e => {
          const picked = await readFiles(e.target.files)
          run(async () => { for (const f of picked) await api.putSharedFile(f.path, f.content) })
        }} /></label>
      <Err error={error} />
      {open && <FileModal file={open} editable onClose={() => setOpen(null)}
        onSave={async content => { await api.putSharedFile(open.path, content); await reload(); setOpen(null) }} />}
    </div>
  )
}
