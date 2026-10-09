// Typed calls to the backend. Every request sends the session cookie (same origin).

export type User = { id: number; username: string; email: string }

export type FileStat = { id: number; path: string; lines: number; bytes: number; updated_at: string }
export type FileFull = FileStat & { content: string; share_id?: number | null; agent?: string }

export type AgentSummary = {
  id: number; slug: string; name: string; description: string; color: string; owner: string
  files: FileStat[]; lines: number
}
export type Grant = { connection_id: number; tool_name: string | null }
export type MyAgent = Omit<AgentSummary, 'files'> & {
  files: FileFull[]; grants: Grant[]; share_id: number | null; can_use_public: boolean
  model_credential_id: number | null; model: string
}

export type ApiToken = { id: number; name: string; prefix: string; created_at: string; last_used_at: string | null; expires_at: string | null }
export type Provider = 'anthropic' | 'openai'
export type CredKind = 'api_key' | 'subscription'
export type Credential = {
  id: number; provider: Provider; kind: CredKind; label: string; hint: string; is_default: boolean
  status: 'unverified' | 'valid' | 'invalid' | 'error'; status_detail: string; last_checked_at: string | null
}

export type Status = 'unknown' | 'connected' | 'auth_required' | 'error' | 'needs_sandbox'
export type Connection = {
  id: number; name: string; transport: 'http' | 'stdio'; url: string | null; command: string | null
  has_auth: boolean; status: Status; status_detail: string; server_name: string; server_version: string
  last_checked_at: string | null; tools: { name: string; description: string }[]
  granted_to: { agent_id: number; agent: string; tool_name: string | null }[]
}

export type Share = {
  id: number; kind: 'agent' | 'file'; title: string; note: string; owner: string
  allow_agent_use: boolean; created_at: string
  agent?: Omit<AgentSummary, 'files'> & { files: (FileStat | FileFull)[] }
  file?: FileFull | (FileStat & { agent: string })
}

export type RunStatus = 'starting' | 'ready' | 'busy' | 'stopped' | 'error'
export type Run = {
  id: number; agent_id: number; status: RunStatus; detail: string; provider: string
  created_at: string; last_active_at: string; ended_at: string | null
}
export type RunEvent = {
  id: number; created_at: string
  kind: 'user' | 'text' | 'tool' | 'tool_result' | 'done' | 'status' | 'error'
  data: Record<string, unknown>
}

export type SharedFile = FileStat & { content?: string }

export type ImportFile = { path: string; content: string }
export type ImportPlan = {
  agents: { source: string; name: string; description: string; exists: boolean; files: { source: string; path: string }[] }[]
  shared: { source: string; path: string }[]
  skipped: { path: string; reason: string }[]
  needs_main: boolean; candidates: string[]
}

export type City = { me: User | null; public: Share[]; agents: MyAgent[]; connections: Connection[]; shared_files: SharedFile[] }

export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) { super(message); this.status = status }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'same-origin',
  })
  const data = await res.json().catch(() => null)
  if (!res.ok) {
    const d = data?.detail
    const msg = typeof d === 'string' ? d : Array.isArray(d) ? d.map((e: { msg: string; loc?: string[] }) =>
      `${(e.loc || []).slice(1).join('.')}: ${e.msg}`).join('; ') : `HTTP ${res.status}`
    throw new ApiError(res.status, msg)
  }
  return data as T
}

export const api = {
  city: () => call<City>('GET', '/api/city'),
  signup: (email: string, username: string, password: string) =>
    call<User>('POST', '/api/auth/signup', { email, username, password }),
  login: (login: string, password: string) => call<User>('POST', '/api/auth/login', { login, password }),
  logout: () => call('POST', '/api/auth/logout'),

  createAgent: (markdown: string, name: string | null, files: { path: string; content: string }[]) =>
    call<MyAgent>('POST', '/api/agents', { markdown, name: name || null, files }),
  updateAgent: (id: number, patch: Partial<Pick<MyAgent, 'name' | 'description' | 'color' | 'can_use_public' | 'model' | 'model_credential_id'>>) =>
    call<MyAgent>('PATCH', `/api/agents/${id}`, patch),
  deleteAgent: (id: number) => call('DELETE', `/api/agents/${id}`),
  putFile: (id: number, path: string, content: string) => call<MyAgent>('PUT', `/api/agents/${id}/files`, { path, content }),
  deleteFile: (id: number, fileId: number) => call<MyAgent>('DELETE', `/api/agents/${id}/files/${fileId}`),
  setGrants: (id: number, grants: Grant[]) => call<MyAgent>('PUT', `/api/agents/${id}/grants`, { grants }),
  manifest: (id: number) => call<unknown>('GET', `/api/agents/${id}/manifest`),

  addConnection: (body: { name: string; transport: 'http' | 'stdio'; url?: string; command?: string; auth_header?: string }) =>
    call<Connection>('POST', '/api/mcp', body),
  updateConnection: (id: number, patch: { auth_header?: string; url?: string; command?: string; name?: string }) =>
    call<Connection>('PATCH', `/api/mcp/${id}`, patch),
  checkConnection: (id: number) => call<Connection>('POST', `/api/mcp/${id}/check`),
  deleteConnection: (id: number) => call('DELETE', `/api/mcp/${id}`),

  share: (body: { kind: 'agent' | 'file'; agent_id?: number; file_id?: number; note?: string; allow_agent_use?: boolean }) =>
    call<Share>('POST', '/api/public', body),
  updateShare: (id: number, patch: { note?: string; allow_agent_use?: boolean; title?: string }) =>
    call<Share>('PATCH', `/api/public/${id}`, patch),
  unshare: (id: number) => call('DELETE', `/api/public/${id}`),
  getShare: (id: number) => call<Share>('GET', `/api/public/${id}`),

  sharedFile: (id: number) => call<SharedFile & { content: string }>('GET', `/api/files/${id}`),
  putSharedFile: (path: string, content: string) => call<SharedFile>('PUT', '/api/files', { path, content }),
  deleteSharedFile: (id: number) => call('DELETE', `/api/files/${id}`),
  previewImport: (files: ImportFile[], main?: string) => call<ImportPlan>('POST', '/api/import/preview', { files, main }),
  doImport: (body: { files: ImportFile[]; agents: { source: string; name: string; files: string[] }[]; shared: string[] }) =>
    call<{ created: MyAgent[]; updated: MyAgent[]; shared: number }>('POST', '/api/import', body),

  activeRun: (agentId: number) => call<Run | null>('GET', `/api/agents/${agentId}/runs/active`),
  startRun: (agentId: number) => call<Run>('POST', `/api/agents/${agentId}/runs`),
  runEvents: (id: number, after: number) => call<{ run: Run; events: RunEvent[] }>('GET', `/api/runs/${id}/events?after=${after}`),
  sendMessage: (id: number, text: string) => call<RunEvent>('POST', `/api/runs/${id}/messages`, { text }),
  stopRun: (id: number) => call<Run>('DELETE', `/api/runs/${id}`),

  tokens: () => call<ApiToken[]>('GET', '/api/account/tokens'),
  createToken: (name: string, expires_days: number | null) =>
    call<ApiToken & { token: string }>('POST', '/api/account/tokens', { name, expires_days }),
  revokeToken: (id: number) => call('DELETE', `/api/account/tokens/${id}`),
  credentials: () => call<{ allow_subscription_tokens: boolean; credentials: Credential[] }>('GET', '/api/account/credentials'),
  addCredential: (body: { provider: Provider; kind: CredKind; label?: string; secret: string }) =>
    call<Credential>('POST', '/api/account/credentials', body),
  checkCredential: (id: number) => call<Credential>('POST', `/api/account/credentials/${id}/check`),
  setDefaultCredential: (id: number) => call<Credential>('PATCH', `/api/account/credentials/${id}`, { is_default: true }),
  deleteCredential: (id: number) => call('DELETE', `/api/account/credentials/${id}`),
}
