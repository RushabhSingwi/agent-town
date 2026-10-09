// Talking to an agent, like talking to someone in an RPG: a dialogue box with its portrait, its words
// typed out, and what it's doing in plain words. Opening it starts nothing: it picks up a chat that's
// already running, and otherwise the agent's sandbox starts with your first message.

import { useCallback, useEffect, useRef, useState } from 'react'
import { api, type MyAgent, type Run, type RunEvent, type RunStatus } from './api'
import { Portrait } from './portrait'
import { Err, Md, msg } from './ui'

const STATUS: Record<Run['status'], string> = {
  starting: 'waking up…', ready: 'awake', busy: 'working…', stopped: 'asleep', error: 'something went wrong',
}
const APP_WORDS: Record<string, string> = { gmail: 'Gmail', calendar: 'Calendar', github: 'GitHub', notion: 'Notion', slack: 'Slack' }

/** "mcp__gmail__search_emails" → { server: "gmail", words: "Gmail: search emails" } */
function toolWords(name: string): { server: string | null; words: string } {
  const m = /^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/.exec(name)
  if (!m) return { server: null, words: name === 'Task' ? 'asks a teammate' : name.toLowerCase() }
  return { server: m[1], words: `${APP_WORDS[m[1]] ?? m[1]}: ${m[2].replace(/_/g, ' ')}` }
}

export function Dialogue({ agent, hasModel, onStatus, onTool, onHouse, onSetup, onClose }: {
  agent: MyAgent; hasModel: boolean; onStatus?: (s: RunStatus | null) => void; onTool?: (server: string) => void
  onHouse: () => void; onSetup: () => void; onClose: () => void
}) {
  const [run, setRun] = useState<Run | null>(null)
  const [events, setEvents] = useState<RunEvent[]>([])
  const [text, setText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const [typing, setTyping] = useState<{ id: number; shown: number } | null>(null)
  const log = useRef<HTMLDivElement>(null)
  const cursor = useRef(0)
  const timer = useRef(0)
  const alive = useRef(true)
  const live = useRef(false)              // past the first load: new words get typed out, couriers sent

  const poll = useCallback(async function tick(id: number) {
    clearTimeout(timer.current)
    try {
      const r = await api.runEvents(id, cursor.current)
      if (!alive.current) return
      setRun(r.run)
      if (r.events.length) {
        cursor.current = r.events[r.events.length - 1].id
        setEvents(prev => [...prev, ...r.events])
        if (live.current) {
          for (const e of r.events) {
            if (e.kind === 'tool') { const s = toolWords(String(e.data.name ?? '')).server; if (s) onTool?.(s) }
          }
          const said = [...r.events].reverse().find(e => e.kind === 'text')
          if (said) setTyping({ id: said.id, shown: 0 })
        }
      }
      live.current = true
      if (r.run.ended_at) return
    } catch (e) { if (alive.current) setError(msg(e)) }
    timer.current = window.setTimeout(() => tick(id), 1000)
  }, [onTool])

  useEffect(() => {
    alive.current = true
    api.activeRun(agent.id).then(r => { if (r && alive.current) { setRun(r); poll(r.id) } else live.current = true }, () => {})
    return () => { alive.current = false; clearTimeout(timer.current) }
  }, [agent.id, poll])

  useEffect(() => { onStatus?.(run && !run.ended_at ? run.status : null) }, [run?.status, run?.ended_at]) // eslint-disable-line react-hooks/exhaustive-deps

  // type the newest reply out, a few letters at a time
  useEffect(() => {
    if (!typing) return
    const full = String(events.find(e => e.id === typing.id)?.data.text ?? '')
    if (typing.shown >= full.length) return
    const t = window.setTimeout(() => setTyping({ id: typing.id, shown: Math.min(full.length, typing.shown + 3) }), 16)
    return () => clearTimeout(t)
  }, [typing, events])

  useEffect(() => { log.current?.scrollTo({ top: log.current.scrollHeight }) }, [events.length, typing?.shown, run?.status])

  async function send(e: React.FormEvent) {
    e.preventDefault()
    const t = text.trim()
    if (!t || sending) return
    setSending(true); setError(null)
    try {
      let r = run
      if (!r || r.ended_at) {                // first message, or it went back to sleep: wake it up
        r = await api.startRun(agent.id)
        cursor.current = 0
        setEvents([]); setRun(r)
      }
      await api.sendMessage(r.id, t)
      setText('')
      poll(r.id)
    } catch (err) { setError(msg(err)) } finally { setSending(false) }
  }

  const awake = run && !run.ended_at
  const typed = typing && events.find(e => e.id === typing.id)
  const doneTyping = !typed || typing!.shown >= String(typed.data.text ?? '').length
  return (
    <div className="dialogue" role="dialog" aria-label={`Talking to ${agent.name}`}>
      <div className="dlg-side">
        <Portrait agent={agent} />
        <div className="dlg-name">{agent.name}</div>
        <div className={`dlg-state ${run?.status ?? 'stopped'}`}>{awake ? STATUS[run!.status] : 'asleep'}</div>
      </div>
      <div className="dlg-main">
        <div className="dlg-log" ref={log}>
          {!events.some(e => e.kind === 'user' || e.kind === 'text') && <p className="dlg-line agent">Hi, I'm {agent.name}. {agent.description || 'What can I do for you?'}
            {hasModel ? '' : ' (First, give me an AI account to think with: Make it your own.)'}</p>}
          {events.map(e => {
            const s = (k: string) => String(e.data[k] ?? '')
            switch (e.kind) {
              case 'user': return <p key={e.id} className="dlg-line you"><b>You:</b> {s('text')}</p>
              case 'text': {
                const full = s('text'), shown = typing?.id === e.id ? full.slice(0, typing.shown) : full
                return <div key={e.id} className="dlg-line agent"><Md text={shown} />{typing?.id === e.id && doneTyping && <span className="dlg-more">▼</span>}</div>
              }
              case 'tool': return <p key={e.id} className="dlg-act">{s('name').startsWith('mcp__gmail') ? '✉' : '⚙'} uses {toolWords(s('name')).words}…</p>
              case 'tool_result': return e.data.is_error ? <p key={e.id} className="dlg-act bad">…that didn't work.</p> : null
              case 'error': return <p key={e.id} className="err">{s('detail')}</p>
              case 'status': return s('status') === 'stopped' || s('status') === 'error' ? <p key={e.id} className="dlg-act">{s('detail') || s('status')}</p> : null
              default: return null
            }
          })}
          {run?.status === 'starting' && <p className="dlg-act">{agent.name} is waking up…</p>}
          {run?.status === 'busy' && <p className="dlg-act typing">{agent.name} is working<span>.</span><span>.</span><span>.</span></p>}
        </div>
        <Err error={error} />
        <form className="dlg-input" onSubmit={send}>
          <textarea id="dlg-text" value={text} rows={1} placeholder={hasModel ? `Say something to ${agent.name}…` : 'It needs an AI account first: Make it your own'}
            disabled={!hasModel} onChange={e => setText(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(e) } }} />
          <button className="primary" disabled={!hasModel || !text.trim() || sending}>Say</button>
        </form>
        <div className="dlg-actions">
          <button onClick={onHouse}>Enter house</button>
          <button onClick={onSetup}>Make it your own</button>
          {awake && <button onClick={async () => { clearTimeout(timer.current); setRun(await api.stopRun(run!.id)) }}
            title="Let it go back to sleep now (it also sleeps by itself when idle)">End chat</button>}
          <span className="grow" />
          <button onClick={onClose}>Leave</button>
        </div>
      </div>
    </div>
  )
}
