// "Make it your own": right after you add an agent (and any time from its panel). Three plain steps:
// tell it about you, connect the apps it should use, and pick which AI account it thinks with.

import { useEffect, useState } from 'react'
import { api, type City, type Connection, type Credential, type MyAgent } from './api'
import { APPS, connectionFor, suggestedApps, type App } from './connectors'
import { Err, Modal, msg } from './ui'

const GENERIC = ['What should it call you, and what do you do?', 'What are you working on right now?', 'Anything it should always or never do?']
const FILE = 'about-me.md'

/** about-me.md is "## question" then the answer, so it reads well to the agent and to you. */
function parse(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const block of text.split(/^## /m).slice(1)) {
    const [q, ...rest] = block.split('\n')
    out[q.trim()] = rest.join('\n').trim()
  }
  return out
}
const write = (qs: string[], a: Record<string, string>) =>
  '# About me\n\n' + qs.filter(q => a[q]?.trim()).map(q => `## ${q}\n\n${a[q].trim()}\n`).join('\n')

export function SetupModal({ agent, city, reload, onClose, onChat, onAccount, onAdvanced }: {
  agent: MyAgent; city: City; reload: () => Promise<void>; onClose: () => void
  onChat: () => void; onAccount: () => void; onAdvanced: () => void
}) {
  const [step, setStep] = useState(0)
  const [questions, setQuestions] = useState<string[] | null>(null)
  const [market, setMarket] = useState<string[] | undefined>(undefined)
  const [answers, setAnswers] = useState<Record<string, string>>(() => parse(agent.files.find(f => f.path === FILE)?.content ?? ''))
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    api.market().then(m => {
      const e = m.find(x => x.name === agent.name)
      setQuestions(e?.ask?.length ? e.ask : GENERIC); setMarket(e?.tools)
    }).catch(() => setQuestions(GENERIC))           // no market, or an older server: ask the general questions
  }, [agent.name])

  async function saveAbout() {
    const qs = questions ?? GENERIC
    if (!qs.some(q => answers[q]?.trim())) return
    await api.putFile(agent.id, FILE, write(qs, answers))
  }

  async function next() {
    setBusy(true); setError(null)
    try {
      if (step === 0) await saveAbout()
      await reload()
      if (step < 2) setStep(step + 1)
      else onChat()
    } catch (e) { setError(msg(e)) } finally { setBusy(false) }
  }

  const steps = ['About you', 'Apps', 'Its brain']
  return (
    <Modal title={`Make ${agent.name} your own`} onClose={onClose} wide>
      <ol className="setup-steps">{steps.map((s, i) => <li key={s} className={i === step ? 'on' : i < step ? 'done' : ''}>{s}</li>)}</ol>

      {step === 0 && <div className="form">
        <p className="hint">A few answers make it much more useful. They're saved as a note only {agent.name} reads. Skip anything you like.</p>
        {(questions ?? []).map((q, i) => (
          <label key={q}>{q}
            <textarea id={`about-${i}`} rows={q.toLowerCase().includes('paste') ? 4 : 2} value={answers[q] ?? ''}
              onChange={e => setAnswers({ ...answers, [q]: e.target.value })} /></label>))}
      </div>}

      {step === 1 && <>
        <p className="hint">Let {agent.name} use your apps. It only gets the ones you tick, and you can change this any time.</p>
        <AppList city={city} agent={agent} suggested={suggestedApps(agent, market)} reload={reload} onAdvanced={onAdvanced} />
      </>}

      {step === 2 && <Brain agent={agent} reload={reload} onAccount={onAccount} />}

      <Err error={error} />
      <div className="row">
        {step > 0 && <button onClick={() => setStep(step - 1)}>Back</button>}
        <span className="grow" />
        {step < 2 && <button onClick={() => setStep(step + 1)}>Skip</button>}
        <button className="primary" disabled={busy} onClick={next}>{step < 2 ? 'Next' : `Done: say hi to ${agent.name}`}</button>
      </div>
    </Modal>
  )
}

/** Apps you can connect; with an agent, also whether that agent may use each one. */
export function AppList({ city, agent, suggested, reload, onAdvanced }: {
  city: City; agent?: MyAgent; suggested?: App[]; reload: () => Promise<void>; onAdvanced: () => void
}) {
  const [all, setAll] = useState(!suggested?.length)
  const [error, setError] = useState<string | null>(null)
  const top = suggested?.length ? suggested : APPS
  const rest = APPS.filter(a => !top.includes(a))
  const run = async (fn: () => Promise<unknown>) => {
    setError(null)
    try { await fn(); await reload() } catch (e) { setError(msg(e)) }
  }
  return (
    <div className="apps">
      {top.map(a => <AppRow key={a.key} app={a} city={city} agent={agent} run={run} onAdvanced={onAdvanced} />)}
      {rest.length > 0 && (all
        ? rest.map(a => <AppRow key={a.key} app={a} city={city} agent={agent} run={run} onAdvanced={onAdvanced} />)
        : <button className="linklike-btn" onClick={() => setAll(true)}>More apps</button>)}
      <Err error={error} />
      <p className="hint">Using something else? <a href="#" onClick={e => { e.preventDefault(); onAdvanced() }}>Connect any app that speaks MCP</a> (advanced).</p>
    </div>
  )
}

function AppRow({ app, city, agent, run, onAdvanced }: {
  app: App; city: City; agent?: MyAgent; run: (fn: () => Promise<unknown>) => Promise<void>; onAdvanced: () => void
}) {
  const [token, setToken] = useState('')
  const [open, setOpen] = useState(false)
  const conn: Connection | undefined = connectionFor(app, city.connections)
  const granted = !!(agent && conn && agent.grants.some(g => g.connection_id === conn.id))
  const toggle = () => agent && conn && run(() => api.setGrants(agent.id, granted
    ? agent.grants.filter(g => g.connection_id !== conn.id)
    : [...agent.grants.filter(g => g.connection_id !== conn.id), { connection_id: conn.id, tool_name: null }]))

  let action
  if (conn) {
    const ok = conn.status === 'connected' || conn.status === 'needs_sandbox'
    action = agent
      ? <label className="check"><input type="checkbox" checked={granted} onChange={toggle} /> Let it use {app.name}</label>
      : <span className={`meta ${ok ? 'ok' : 'warn'}`}>{ok ? 'Connected' : conn.status_detail || 'Needs attention'}</span>
  } else if (app.how === 'token') {
    action = <button className="primary" onClick={() => setOpen(!open)}>Connect</button>
  } else if (app.how === 'custom') {
    action = <button onClick={onAdvanced}>Connect…</button>
  } else {
    action = <span className="meta soon">Coming soon</span>
  }

  return (
    <div className={`app-row${app.how === 'soon' && !conn ? ' muted' : ''}`}>
      <span className="app-icon" aria-hidden="true">{app.icon}</span>
      <div className="grow"><b>{app.name}</b><div className="meta wrap">Lets it {app.does}.{app.how === 'soon' && !conn && ' One-click sign-in is on its way.'}</div></div>
      {action}
      {open && !conn && <div className="app-connect">
        <p className="hint">{app.tokenHelp} <a href={app.tokenLink} target="_blank" rel="noreferrer">Open {app.name}</a></p>
        <div className="row tight">
          <input className="note" type="password" autoComplete="off" placeholder={`Paste your ${app.name} token`} value={token} onChange={e => setToken(e.target.value)} />
          <button className="primary" disabled={!token} onClick={() => run(async () => {
            const c = await api.addConnection({ name: app.key, transport: 'http', url: app.url, auth_header: `Bearer ${token.trim()}` })
            if (c.status !== 'connected') throw new Error(`${app.name} didn't accept that: ${c.status_detail}`)
            if (agent) await api.setGrants(agent.id, [...agent.grants, { connection_id: c.id, tool_name: null }])
            setToken(''); setOpen(false)
          })}>Connect</button>
        </div>
        <p className="hint">Stored encrypted and never shown again.</p>
      </div>}
    </div>
  )
}

function Brain({ agent, reload, onAccount }: { agent: MyAgent; reload: () => Promise<void>; onAccount: () => void }) {
  const [creds, setCreds] = useState<Credential[] | null>(null)
  useEffect(() => { api.credentials().then(d => setCreds(d.credentials), () => setCreds([])) }, [])
  if (creds === null) return <p className="hint">Checking your accounts…</p>
  if (!creds.length) return (
    <div className="brain">
      <p><b>{agent.name} needs an AI account to think with.</b> Use your own Claude or ChatGPT account (a subscription or an
        API key). It's only ever used for your agents, and it's stored encrypted.</p>
      <button className="primary" onClick={onAccount}>Add your Claude or ChatGPT account</button>
    </div>)
  const current = creds.find(c => c.id === agent.model_credential_id) ?? creds.find(c => c.is_default)
  return (
    <div className="brain">
      <p>{agent.name} will think with <b>{current?.label}</b>.</p>
      {creds.length > 1 && <label>Use a different one
        <select value={agent.model_credential_id ?? 0}
          onChange={async e => { await api.updateAgent(agent.id, { model_credential_id: Number(e.target.value) }); await reload() }}>
          <option value={0}>Your default ({creds.find(c => c.is_default)?.label})</option>
          {creds.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
        </select></label>}
      <p className="hint">That's it. Say hi, or walk up to {agent.name} on the map any time.</p>
    </div>)
}
