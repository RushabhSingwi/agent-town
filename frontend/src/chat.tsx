// Talking to your agent: opening this starts (or reuses) a sandbox for it, then polls the run's events.

import { useEffect, useRef, useState } from 'react'
import { api, type MyAgent, type Run, type RunEvent } from './api'
import { Err, Md, Modal, msg } from './ui'

const STATUS: Record<Run['status'], string> = {
  starting: 'Starting its sandbox…', ready: 'Ready', busy: 'Working…', stopped: 'Stopped', error: 'Error',
}

export function ChatModal({ agent, onClose }: { agent: MyAgent; onClose: () => void }) {
  const [run, setRun] = useState<Run | null>(null)
  const [events, setEvents] = useState<RunEvent[]>([])
  const [text, setText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const bottom = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let stop = false, after = 0, timer = 0
    const poll = async (id: number) => {
      try {
        const r = await api.runEvents(id, after)
        if (stop) return
        setRun(r.run)
        if (r.events.length) {
          after = r.events[r.events.length - 1].id
          setEvents(prev => [...prev, ...r.events])
        }
        if (r.run.ended_at) return
      } catch (e) { if (!stop) setError(msg(e)) }
      timer = window.setTimeout(() => poll(id), 1000)
    }
    api.startRun(agent.id).then(r => { if (!stop) { setRun(r); poll(r.id) } }, e => setError(msg(e)))
    return () => { stop = true; clearTimeout(timer) }
  }, [agent.id, attempt])

  useEffect(() => { bottom.current?.scrollIntoView({ block: 'end' }) }, [events.length])

  const ended = !!run?.ended_at
  async function send(e: React.FormEvent) {
    e.preventDefault()
    if (!run || !text.trim()) return
    try { await api.sendMessage(run.id, text.trim()); setText('') } catch (err) { setError(msg(err)) }
  }

  return (
    <Modal title={`Chat · ${agent.name}`} onClose={onClose} wide>
      <p className="hint">
        <span className={`dot ${run?.status ?? 'starting'}`} /> {run ? STATUS[run.status] : 'Starting its sandbox…'}
        {run?.detail && run.status !== 'ready' && <> · {run.detail}</>}
        {run && <> · {run.provider} sandbox · stops by itself when idle</>}
      </p>
      <div className="chat">
        {events.map(e => <Line key={e.id} e={e} />)}
        {run?.status === 'busy' && <p className="chat-meta">…</p>}
        <div ref={bottom} />
      </div>
      <Err error={error} />
      {ended
        ? <div className="row"><button className="primary" onClick={() => { setEvents([]); setRun(null); setError(null); setAttempt(a => a + 1) }}>Start a new run</button></div>
        : <form className="row" onSubmit={send}>
          <input className="note" autoFocus value={text} onChange={e => setText(e.target.value)}
            placeholder={run?.status === 'starting' ? 'You can type now; it reads this once it’s up' : `Message ${agent.name}`} />
          <button className="primary" disabled={!run || !text.trim()}>Send</button>
          <button type="button" disabled={!run} onClick={async () => run && setRun(await api.stopRun(run.id))}>Stop</button>
        </form>}
    </Modal>
  )
}

function Line({ e }: { e: RunEvent }) {
  const s = (k: string) => String(e.data[k] ?? '')
  switch (e.kind) {
    case 'user': return <div className="chat-user">{s('text')}</div>
    case 'text': return <div className="chat-agent"><Md text={s('text')} /></div>
    case 'tool': return <p className="chat-tool mono">→ {s('name')} <span className="meta">{s('input')}</span></p>
    case 'tool_result': return <details className="chat-tool"><summary className="meta">{e.data.is_error ? 'tool failed' : 'result'}</summary>
      <pre className="json">{s('output')}</pre></details>
    case 'error': return <p className="err">{s('detail')}</p>
    case 'status': return s('status') === 'stopped' || s('status') === 'error' ? <p className="chat-meta">{s('detail') || s('status')}</p> : null
    default: return null
  }
}
