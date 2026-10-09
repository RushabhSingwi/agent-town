// Talking to your agent. Opening the panel starts nothing: it picks up a chat that's already running,
// and otherwise the agent's sandbox starts with your first message (and stops by itself when idle).

import { useCallback, useEffect, useRef, useState } from 'react'
import { api, type MyAgent, type Run, type RunEvent } from './api'
import { Err, Md, msg } from './ui'

const STATUS: Record<Run['status'], string> = {
  starting: 'Waking up…', ready: 'Ready', busy: 'Working…', stopped: 'Asleep', error: 'Something went wrong',
}

export function ChatPanel({ agent, hasModel }: { agent: MyAgent; hasModel: boolean }) {
  const [run, setRun] = useState<Run | null>(null)
  const [events, setEvents] = useState<RunEvent[]>([])
  const [text, setText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const bottom = useRef<HTMLDivElement>(null)
  const cursor = useRef(0)
  const timer = useRef(0)
  const alive = useRef(true)

  const poll = useCallback(async function tick(id: number) {
    clearTimeout(timer.current)
    try {
      const r = await api.runEvents(id, cursor.current)
      if (!alive.current) return
      setRun(r.run)
      if (r.events.length) {
        cursor.current = r.events[r.events.length - 1].id
        setEvents(prev => [...prev, ...r.events])
      }
      if (r.run.ended_at) return
    } catch (e) { if (alive.current) setError(msg(e)) }
    timer.current = window.setTimeout(() => tick(id), 1000)
  }, [])

  // pick up a chat that's already running (looking never starts a sandbox)
  useEffect(() => {
    alive.current = true
    api.activeRun(agent.id).then(r => { if (r && alive.current) { setRun(r); poll(r.id) } }, () => {})
    return () => { alive.current = false; clearTimeout(timer.current) }
  }, [agent.id, poll])

  useEffect(() => { bottom.current?.scrollIntoView({ block: 'end' }) }, [events.length, run?.status])

  async function send(e: React.FormEvent) {
    e.preventDefault()
    const t = text.trim()
    if (!t || sending) return
    setSending(true); setError(null)
    try {
      let r = run
      if (!r || r.ended_at) {  // first message, or the last chat went to sleep: wake it up
        r = await api.startRun(agent.id)
        cursor.current = 0
        setEvents([]); setRun(r)
      }
      await api.sendMessage(r.id, t)
      setText('')
      poll(r.id)
    } catch (err) { setError(msg(err)) } finally { setSending(false) }
  }

  async function stop() {
    if (!run) return
    clearTimeout(timer.current)
    setRun(await api.stopRun(run.id))
  }

  const live = run && !run.ended_at
  const status = run ? STATUS[run.status] : 'Asleep'
  return (
    <div className="chat-panel">
      <div className="panel-head">
        <span className={`dot ${run?.status ?? 'stopped'}`} />
        <b>Chat</b><span className="meta">{status}</span>
        <span className="grow" />
        {live && <button className="tiny" onClick={stop} title="Put it to sleep now (it also sleeps by itself when idle)">End chat</button>}
      </div>
      <div className="chat">
        {events.length === 0 && <div className="chat-empty">
          <b>Say hi to {agent.name}.</b>
          <p>{agent.description || 'Ask it anything it was made for.'}</p>
          <p className="hint">Your first message wakes it up in its own private sandbox (a few seconds). It reads its files,
            uses the tools you gave it, and goes back to sleep when you stop talking.</p>
        </div>}
        {events.map(e => <Line key={e.id} e={e} />)}
        {run?.status === 'starting' && <p className="chat-meta">Waking up {agent.name}…</p>}
        {run?.status === 'busy' && <p className="chat-meta typing">{agent.name} is working<span>.</span><span>.</span><span>.</span></p>}
        <div ref={bottom} />
      </div>
      <Err error={error} />
      {hasModel
        ? <form className="chat-input" onSubmit={send}>
          <textarea value={text} rows={2} placeholder={`Message ${agent.name}`} onChange={e => setText(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(e) } }} />
          <button className="primary" disabled={!text.trim() || sending}>Send</button>
        </form>
        : <p className="note-box">To talk to it, add your Claude or ChatGPT account (or an API key) under your
          @username (top right) → Models.</p>}
    </div>
  )
}

function Line({ e }: { e: RunEvent }) {
  const s = (k: string) => String(e.data[k] ?? '')
  switch (e.kind) {
    case 'user': return <div className="chat-user">{s('text')}</div>
    case 'text': return <div className="chat-agent"><Md text={s('text')} /></div>
    case 'tool': return <p className="chat-tool">🔧 <b>{s('name')}</b> <span className="meta mono">{s('input').slice(0, 140)}</span></p>
    case 'tool_result': return <details className="chat-tool"><summary className="meta">{e.data.is_error ? 'tool failed: details' : 'result'}</summary>
      <pre className="json">{s('output')}</pre></details>
    case 'error': return <p className="err">{s('detail')}</p>
    case 'status': return s('status') === 'stopped' || s('status') === 'error' ? <p className="chat-meta">{s('detail') || s('status')}</p> : null
    default: return null
  }
}
