// Account: the model credentials your agents run on, and API tokens for programs.

import { useCallback, useEffect, useState } from 'react'
import { api, type ApiToken, type CredKind, type Credential, type Provider } from './api'
import { Err, Modal, msg } from './ui'

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString() : 'never')

const HOW: Record<Provider, Record<CredKind, { label: string; how: string; placeholder: string }>> = {
  anthropic: {
    api_key: { label: 'Anthropic API key', how: 'console.anthropic.com → API keys. Billed to your Anthropic account.', placeholder: 'sk-ant-api03-…' },
    subscription: { label: 'Claude subscription', how: 'Run `claude setup-token` in a terminal and paste the token it prints.', placeholder: 'sk-ant-oat01-…' },
  },
  openai: {
    api_key: { label: 'OpenAI API key', how: 'platform.openai.com → API keys. Billed to your OpenAI account.', placeholder: 'sk-…' },
    subscription: { label: 'ChatGPT subscription (Codex)', how: 'Run `codex login`, then paste the contents of ~/.codex/auth.json.', placeholder: '{ "tokens": … }' },
  },
}

function Models() {
  const [data, setData] = useState<{ allow_subscription_tokens: boolean; credentials: Credential[] } | null>(null)
  const [provider, setProvider] = useState<Provider>('anthropic')
  const [kind, setKind] = useState<CredKind>('api_key')
  const [secret, setSecret] = useState('')
  const [label, setLabel] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const load = useCallback(async () => setData(await api.credentials()), [])
  useEffect(() => { load() }, [load])
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true); setError(null)
    try { await fn(); await load() } catch (e) { setError(msg(e)) } finally { setBusy(false) }
  }
  const h = HOW[provider][kind]
  return (
    <div>
      <p className="hint">Agents run on <b>your</b> model account, never the platform's. Keys are encrypted on the server and never shown again.</p>
      {data && data.credentials.length > 0 && <ul className="list">
        {data.credentials.map(c => (
          <li key={c.id} className="nohover">
            <span className={`dot ${c.status === 'valid' ? 'connected' : c.status === 'unverified' ? 'needs_sandbox' : 'error'}`} />
            <span className="grow"><b>{c.label}</b> {c.hint && <span className="mono">…{c.hint}</span>}
              {c.is_default && <span className="mini">default</span>}
              <div className="meta wrap">{c.status_detail}</div></span>
            {!c.is_default && <button className="tiny" onClick={() => run(() => api.setDefaultCredential(c.id))}>make default</button>}
            <button className="tiny" disabled={busy} onClick={() => run(() => api.checkCredential(c.id))}>check</button>
            <button className="tiny" onClick={() => confirm(`Remove ${c.label}?`) && run(() => api.deleteCredential(c.id))}>✕</button>
          </li>))}
      </ul>}
      <form className="form boxed" onSubmit={e => { e.preventDefault(); run(async () => { await api.addCredential({ provider, kind, secret, label: label || undefined }); setSecret(''); setLabel('') }) }}>
        <div className="seg">
          <button type="button" className={provider === 'anthropic' ? 'on' : ''} onClick={() => setProvider('anthropic')}>Anthropic (Claude)</button>
          <button type="button" className={provider === 'openai' ? 'on' : ''} onClick={() => setProvider('openai')}>OpenAI (Codex)</button>
        </div>
        <div className="seg">
          <button type="button" className={kind === 'api_key' ? 'on' : ''} onClick={() => setKind('api_key')}>API key</button>
          <button type="button" className={kind === 'subscription' ? 'on' : ''} onClick={() => setKind('subscription')}>Subscription</button>
        </div>
        {kind === 'subscription' && !data?.allow_subscription_tokens
          ? <p className="note-box">Subscriptions are off on this server; use an API key.</p>
          : <>
            {kind === 'subscription' && <p className="note-box">Your token runs only your own agents, in their own sandboxes, and is
              never shown again. Using a subscription outside the provider's own apps is governed by your plan's terms
              with {provider === 'anthropic' ? 'Anthropic' : 'OpenAI'}; check them, since the account is yours.</p>}
            <label>{h.label} <span className="hint">{h.how}</span>
              {kind === 'subscription' && provider === 'openai'
                ? <textarea value={secret} onChange={e => setSecret(e.target.value)} rows={4} placeholder={h.placeholder} />
                : <input type="password" value={secret} onChange={e => setSecret(e.target.value)} placeholder={h.placeholder} autoComplete="off" />}</label>
            <label>Label <span className="hint">optional</span><input value={label} onChange={e => setLabel(e.target.value)} placeholder={h.label} /></label>
            <button className="primary" disabled={busy || !secret}>{busy ? 'Checking…' : 'Add'}</button>
          </>}
      </form>
      <Err error={error} />
    </div>
  )
}

function Tokens() {
  const [tokens, setTokens] = useState<ApiToken[]>([])
  const [name, setName] = useState('')
  const [days, setDays] = useState('90')
  const [fresh, setFresh] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const load = useCallback(async () => setTokens(await api.tokens()), [])
  useEffect(() => { load() }, [load])
  const origin = window.location.origin
  return (
    <div>
      <p className="hint">For scripts, a CLI, or a sandbox: send <code>Authorization: Bearer at_…</code>. A token acts as you on your
        own town only. It can't create tokens or read your keys. Only its hash is stored, so copy it now.</p>
      {fresh && <div className="note-box">
        <b>Your new token</b> (shown once):
        <pre className="json">{fresh}</pre>
        <pre className="json">{`curl -H "Authorization: Bearer ${fresh}" ${origin}/api/city`}</pre>
        <button onClick={() => { navigator.clipboard?.writeText(fresh); }}>Copy token</button> <button onClick={() => setFresh(null)}>Done</button>
      </div>}
      {tokens.length > 0 && <ul className="list">{tokens.map(t => (
        <li key={t.id} className="nohover">
          <span className="grow"><b>{t.name}</b> <span className="mono">{t.prefix}…</span>
            <div className="meta">created {when(t.created_at)} · last used {when(t.last_used_at)} · expires {t.expires_at ? when(t.expires_at) : 'never'}</div></span>
          <button className="tiny" onClick={async () => { if (confirm(`Revoke ${t.name}? Anything using it stops working.`)) { await api.revokeToken(t.id); load() } }}>revoke</button>
        </li>))}</ul>}
      <form className="row" onSubmit={async e => {
        e.preventDefault(); setError(null)
        try { const t = await api.createToken(name, days === 'never' ? null : Number(days)); setFresh(t.token); setName(''); load() } catch (err) { setError(msg(err)) }
      }}>
        <input className="note" value={name} onChange={e => setName(e.target.value)} placeholder="Token name, e.g. laptop CLI" required />
        <select value={days} onChange={e => setDays(e.target.value)}>
          <option value="30">30 days</option><option value="90">90 days</option><option value="365">1 year</option><option value="never">never expires</option>
        </select>
        <button className="primary">Create token</button>
      </form>
      <Err error={error} />
    </div>
  )
}

export function AccountModal({ username, onClose, onDeleted }: { username: string; onClose: () => void; onDeleted: () => void }) {
  const [tab, setTab] = useState<'models' | 'tokens' | 'account'>('models')
  return (
    <Modal title={`@${username}`} onClose={onClose} wide>
      <div className="seg tabs">
        <button className={tab === 'models' ? 'on' : ''} onClick={() => setTab('models')}>AI accounts</button>
        <button className={tab === 'tokens' ? 'on' : ''} onClick={() => setTab('tokens')}>API tokens</button>
        <button className={tab === 'account' ? 'on' : ''} onClick={() => setTab('account')}>Account</button>
      </div>
      {tab === 'models' ? <Models /> : tab === 'tokens' ? <Tokens /> : <DeleteAccount username={username} onDeleted={onDeleted} />}
    </Modal>
  )
}

function DeleteAccount({ username, onDeleted }: { username: string; onDeleted: () => void }) {
  const [open, setOpen] = useState(false)
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  return (
    <div className="danger-zone">
      <h3>Delete your account</h3>
      <p>This deletes <b>@{username}</b> and everything in it, for good: your agents and their files, your chats,
        your shared files, your AI accounts and app connections, your API tokens, and anything you shared publicly.
        Running agents are stopped. It can't be undone.</p>
      {!open
        ? <button className="danger" onClick={() => setOpen(true)}>Delete my account…</button>
        : <form className="row" onSubmit={async e => {
            e.preventDefault(); setBusy(true); setError(null)
            try { await api.deleteAccount(password); onDeleted() } catch (err) { setError(msg(err)) } finally { setBusy(false) }
          }}>
          <input id="delete-password" className="note" type="password" autoComplete="current-password" autoFocus
            placeholder="Type your password to confirm" value={password} onChange={e => setPassword(e.target.value)} />
          <button className="danger" disabled={!password || busy}>{busy ? 'Deleting…' : 'Delete everything'}</button>
          <button type="button" onClick={() => { setOpen(false); setPassword('') }}>Cancel</button>
        </form>}
      <Err error={error} />
    </div>
  )
}
