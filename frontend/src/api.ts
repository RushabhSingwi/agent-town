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

export type City = { me: User | null; public: Share[]; agents: MyAgent[]; connections: Connection[] }

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
  updateAgent: (id: number, patch: Partial<Pick<MyAgent, 'name' | 'description' | 'color' | 'can_use_public'>>) =>
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
}
