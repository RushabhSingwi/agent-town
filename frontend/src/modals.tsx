import { useState } from 'react'
import { api } from './api'
import { Err, Modal, msg, readFiles } from './ui'

export function AuthModal({ mode: initial, onClose, onDone }: { mode: 'login' | 'signup'; onClose: () => void; onDone: () => void }) {
  const [mode, setMode] = useState(initial)
  const [email, setEmail] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true); setError(null)
    try {
      if (mode === 'signup') await api.signup(email, username, password)
      else await api.login(email, password)
      onDone()
    } catch (err) { setError(msg(err)) } finally { setBusy(false) }
  }

  return (
    <Modal title={mode === 'signup' ? 'Create your account' : 'Sign in'} onClose={onClose}>
      <form onSubmit={submit} className="form">
        <label>{mode === 'signup' ? 'Email' : 'Email or username'}
          <input autoFocus value={email} onChange={e => setEmail(e.target.value)} type={mode === 'signup' ? 'email' : 'text'} required /></label>
        {mode === 'signup' && <label>Username <span className="hint">lowercase, 3–30 chars: your district's name</span>
          <input value={username} onChange={e => setUsername(e.target.value.toLowerCase())} pattern="[a-z0-9][a-z0-9_-]{2,29}" required /></label>}
        <label>Password {mode === 'signup' && <span className="hint">8+ characters</span>}
          <input value={password} onChange={e => setPassword(e.target.value)} type="password" minLength={mode === 'signup' ? 8 : 1} required /></label>
        <Err error={error} />
        <button className="primary" disabled={busy}>{mode === 'signup' ? 'Create account' : 'Sign in'}</button>
        <p className="switch">{mode === 'signup' ? 'Have an account? ' : 'New here? '}
          <a href="#" onClick={e => { e.preventDefault(); setMode(mode === 'signup' ? 'login' : 'signup'); setError(null) }}>
            {mode === 'signup' ? 'Sign in' : 'Create an account'}</a></p>
      </form>
    </Modal>
  )
}

const TEMPLATE = `---
name: my-agent
description: What this agent does, in one line.
---

# My agent

You are … Describe how it should behave, what it knows, and what it must not do.
`

export function NewAgentModal({ onClose, onDone }: { onClose: () => void; onDone: (id: number) => void }) {
  const [markdown, setMarkdown] = useState(TEMPLATE)
  const [name, setName] = useState('')
  const [extra, setExtra] = useState<{ path: string; content: string }[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function pickDefinition(list: FileList | null) {
    const [f] = await readFiles(list)
    if (f) setMarkdown(f.content)
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true); setError(null)
    try {
      const a = await api.createAgent(markdown, name || null, extra)
      onDone(a.id)
    } catch (err) { setError(msg(err)) } finally { setBusy(false) }
  }

  return (
    <Modal title="New agent" onClose={onClose} wide>
      <form onSubmit={submit} className="form">
        <p className="hint">An agent is a markdown file, like a Claude Code agent in <code>.claude/agents/</code>.
          It becomes a building in your private district: one floor per file, taller for longer files.</p>
        <label>AGENT.md <span className="hint">paste it, or <label className="linklike">load a .md file<input type="file" accept=".md,.txt" hidden onChange={e => pickDefinition(e.target.files)} /></label></span>
          <textarea value={markdown} onChange={e => setMarkdown(e.target.value)} rows={12} spellCheck={false} /></label>
        <label>Name <span className="hint">optional when the frontmatter has <code>name:</code></span>
          <input value={name} onChange={e => setName(e.target.value)} /></label>
        <label>Knowledge files <span className="hint">optional .md / .txt: extra floors the agent can read</span>
          <input type="file" multiple accept=".md,.txt" onChange={async e => setExtra(await readFiles(e.target.files))} /></label>
        {extra.length > 0 && <p className="hint">{extra.map(f => f.path).join(', ')}</p>}
        <Err error={error} />
        <button className="primary" disabled={busy}>Build it</button>
      </form>
    </Modal>
  )
}

export function NewToolModal({ onClose, onDone }: { onClose: () => void; onDone: (id: number) => void }) {
  const [name, setName] = useState('')
  const [transport, setTransport] = useState<'http' | 'stdio'>('http')
  const [url, setUrl] = useState('')
  const [command, setCommand] = useState('')
  const [auth, setAuth] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true); setError(null)
    try {
      const c = await api.addConnection(transport === 'http'
        ? { name, transport, url, auth_header: auth || undefined }
        : { name, transport, command })
      onDone(c.id)
    } catch (err) { setError(msg(err)) } finally { setBusy(false) }
  }

  return (
    <Modal title="Connect an MCP server" onClose={onClose}>
      <form onSubmit={submit} className="form">
        <p className="hint">Tools live in Utilities. Agent Town connects, lists the server's tools, and shows its status.
          Then you choose which agents may use which tools.</p>
        <label>Name<input autoFocus value={name} onChange={e => setName(e.target.value)} placeholder="notion" required /></label>
        <div className="seg">
          <button type="button" className={transport === 'http' ? 'on' : ''} onClick={() => setTransport('http')}>Remote (HTTP)</button>
          <button type="button" className={transport === 'stdio' ? 'on' : ''} onClick={() => setTransport('stdio')}>Local command (stdio)</button>
        </div>
        {transport === 'http' ? <>
          <label>Server URL<input value={url} onChange={e => setUrl(e.target.value)} placeholder="https://example.com/mcp" required /></label>
          <label>Authorization header <span className="hint">optional, e.g. <code>Bearer sk-…</code>. Stored encrypted, never shown again</span>
            <input value={auth} onChange={e => setAuth(e.target.value)} type="password" autoComplete="off" /></label>
        </> : <>
          <label>Command<input value={command} onChange={e => setCommand(e.target.value)} placeholder="npx -y @modelcontextprotocol/server-filesystem /data" required /></label>
          <p className="hint">stdio servers start inside the agent's sandbox, so they show as “runs in sandbox” until a sandbox provider is wired up.</p>
        </>}
        <Err error={error} />
        <button className="primary" disabled={busy}>{busy ? 'Connecting…' : 'Connect'}</button>
      </form>
    </Modal>
  )
}
