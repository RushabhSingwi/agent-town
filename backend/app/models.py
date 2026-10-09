"""The tables.

users ─┬─ sessions                 browser logins (only a hash of the cookie is stored)
       ├─ api_tokens               "Authorization: Bearer at_…" for scripts and sandboxes (hashed too)
       ├─ model_credentials        the user's own API key / subscription token, encrypted
       ├─ agents ─┬─ agent_files    the agent's markdown: AGENT.md plus any knowledge files
       │          ├─ agent_team     which of the owner's other agents it may call (its sub-agents)
       │          └─ agent_tool_grants ──┐  which tools this agent may use
       ├─ mcp_connections ─ mcp_tools ◄──┘  a user's MCP servers and the tools they expose
       ├─ oauth_accounts            accounts signed in with OAuth (Google): their tokens, encrypted
       ├─ shared_files              knowledge every one of the user's agents can read (private)
       ├─ public_shares             what a user put in the public district
       └─ runs ─ run_events         an agent running in its own sandbox, and what it said and did
"""

from datetime import datetime, timezone

from sqlalchemy import JSON, Boolean, DateTime, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .db import Base


def now() -> datetime:
    return datetime.now(timezone.utc)


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(primary_key=True)
    email: Mapped[str] = mapped_column(String(320), unique=True, index=True)
    username: Mapped[str] = mapped_column(String(40), unique=True, index=True)
    password_hash: Mapped[str] = mapped_column(String(255))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)

    agents: Mapped[list["Agent"]] = relationship(back_populates="owner", cascade="all, delete-orphan")


class AuthSession(Base):
    __tablename__ = "sessions"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    # sha256 of the cookie value. A leaked database can't be replayed as cookies.
    token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))

    user: Mapped[User] = relationship()


class ApiToken(Base):
    """A long-lived token for programs: the CLI and scripts. (Sandboxes get a run token instead.)
    Shown once at creation; only its sha256 is stored, like sessions."""
    __tablename__ = "api_tokens"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(80))
    token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    prefix: Mapped[str] = mapped_column(String(16))  # first characters, so you can tell tokens apart
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    last_used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    user: Mapped["User"] = relationship()


class ModelCredential(Base):
    """What an agent's model calls are paid with: the user's own, never the platform's.
    provider: anthropic | openai.  kind: api_key | subscription (Claude `setup-token`,
    Codex auth.json). The secret is Fernet-encrypted and never leaves the server through the API."""
    __tablename__ = "model_credentials"

    id: Mapped[int] = mapped_column(primary_key=True)
    owner_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    provider: Mapped[str] = mapped_column(String(20))
    kind: Mapped[str] = mapped_column(String(20))
    label: Mapped[str] = mapped_column(String(80))
    secret_enc: Mapped[str] = mapped_column(Text)
    hint: Mapped[str] = mapped_column(String(12), default="")  # last 4 characters, to recognise it
    is_default: Mapped[bool] = mapped_column(Boolean, default=False)
    # unverified | valid | invalid | error
    status: Mapped[str] = mapped_column(String(20), default="unverified")
    status_detail: Mapped[str] = mapped_column(Text, default="")
    last_checked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


class Agent(Base):
    __tablename__ = "agents"
    __table_args__ = (UniqueConstraint("owner_id", "slug"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    owner_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    slug: Mapped[str] = mapped_column(String(60))
    name: Mapped[str] = mapped_column(String(80))
    description: Mapped[str] = mapped_column(Text, default="")
    color: Mapped[str] = mapped_column(String(7), default="#8a6fd1")
    # May this agent read what other people shared in the public district?
    can_use_public: Mapped[bool] = mapped_column(Boolean, default=True)
    # Which of the owner's model credentials it runs on (None: the owner's default) and which model.
    model_credential_id: Mapped[int | None] = mapped_column(
        ForeignKey("model_credentials.id", ondelete="SET NULL"))
    model: Mapped[str] = mapped_column(String(100), default="")
    # How hard it thinks before answering: low … max ("" = the model's own default). See manifest.EFFORTS.
    thinking: Mapped[str] = mapped_column(String(10), default="")
    # What its building looks like on the map: studio, forge, library… ("" = picked from its description)
    building: Mapped[str] = mapped_column(String(20), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now, onupdate=now)

    owner: Mapped[User] = relationship(back_populates="agents")
    files: Mapped[list["AgentFile"]] = relationship(
        back_populates="agent", cascade="all, delete-orphan", order_by="AgentFile.path")
    grants: Mapped[list["AgentToolGrant"]] = relationship(
        back_populates="agent", cascade="all, delete-orphan")
    team: Mapped[list["Agent"]] = relationship(
        secondary="agent_team", primaryjoin="Agent.id == AgentTeam.lead_id", secondaryjoin="Agent.id == AgentTeam.member_id",
        order_by="Agent.name")


DEFINITION = "AGENT.md"


class AgentTeam(Base):
    """A lead agent may call a member agent, like Claude Code's sub-agents: both are the same
    owner's, and the member keeps only its own files and tools."""
    __tablename__ = "agent_team"

    lead_id: Mapped[int] = mapped_column(ForeignKey("agents.id", ondelete="CASCADE"), primary_key=True)
    member_id: Mapped[int] = mapped_column(ForeignKey("agents.id", ondelete="CASCADE"), primary_key=True)


class AgentFile(Base):
    __tablename__ = "agent_files"
    __table_args__ = (UniqueConstraint("agent_id", "path"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    agent_id: Mapped[int] = mapped_column(ForeignKey("agents.id", ondelete="CASCADE"), index=True)
    path: Mapped[str] = mapped_column(String(200))
    content: Mapped[str] = mapped_column(Text)
    lines: Mapped[int] = mapped_column(Integer)
    bytes: Mapped[int] = mapped_column(Integer)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now, onupdate=now)

    agent: Mapped[Agent] = relationship(back_populates="files")

    def set_content(self, content: str) -> None:
        self.content = content
        self.lines = content.count("\n") + (0 if content.endswith("\n") or not content else 1)
        self.bytes = len(content.encode())


class SharedFile(Base):
    """A file all of its owner's agents can read: a playbook or "about us" that several agents
    use, kept once instead of copied into each. Private, like the agents themselves.
    In a run it's written at its own path, next to the agent's own files (which win on a clash)."""
    __tablename__ = "shared_files"
    __table_args__ = (UniqueConstraint("owner_id", "path"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    owner_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    path: Mapped[str] = mapped_column(String(200))
    content: Mapped[str] = mapped_column(Text)
    lines: Mapped[int] = mapped_column(Integer)
    bytes: Mapped[int] = mapped_column(Integer)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now, onupdate=now)

    set_content = AgentFile.set_content


class OAuthAccount(Base):
    """An account someone signed into with OAuth, like Composio's "connected account": which provider,
    which of their accounts, which scopes they allowed, and the tokens (encrypted). Agent Town hosts
    the tools for it itself, so the tokens never go into a sandbox.
    status: connected | expired (refreshing failed: they need to sign in again)"""
    __tablename__ = "oauth_accounts"
    __table_args__ = (UniqueConstraint("owner_id", "provider", "subject"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    owner_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    provider: Mapped[str] = mapped_column(String(20))          # google
    subject: Mapped[str] = mapped_column(String(255))          # the provider's id for the account
    email: Mapped[str] = mapped_column(String(320), default="")
    scopes: Mapped[str] = mapped_column(Text, default="")      # space-separated, as granted
    refresh_token_enc: Mapped[str] = mapped_column(Text, default="")
    access_token_enc: Mapped[str] = mapped_column(Text, default="")
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    status: Mapped[str] = mapped_column(String(20), default="connected")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


class McpConnection(Base):
    __tablename__ = "mcp_connections"
    __table_args__ = (UniqueConstraint("owner_id", "name"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    owner_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(60))
    transport: Mapped[str] = mapped_column(String(10))       # "http" | "stdio" | "hosted"
    url: Mapped[str | None] = mapped_column(Text)            # http
    command: Mapped[str | None] = mapped_column(Text)        # stdio: runs in the sandbox, later
    auth_header_enc: Mapped[str | None] = mapped_column(Text)  # Fernet-encrypted Authorization value
    # transport "hosted": tools Agent Town serves itself (Gmail, Calendar) for this signed-in account
    oauth_account_id: Mapped[int | None] = mapped_column(ForeignKey("oauth_accounts.id", ondelete="CASCADE"))
    app: Mapped[str] = mapped_column(String(30), default="")  # hosted: gmail | calendar
    # unknown | connected | auth_required | error | needs_sandbox
    status: Mapped[str] = mapped_column(String(20), default="unknown")
    status_detail: Mapped[str] = mapped_column(Text, default="")
    server_name: Mapped[str] = mapped_column(String(200), default="")
    server_version: Mapped[str] = mapped_column(String(80), default="")
    last_checked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)

    tools: Mapped[list["McpTool"]] = relationship(
        back_populates="connection", cascade="all, delete-orphan", order_by="McpTool.name")


class McpTool(Base):
    __tablename__ = "mcp_tools"
    __table_args__ = (UniqueConstraint("connection_id", "name"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    connection_id: Mapped[int] = mapped_column(ForeignKey("mcp_connections.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(200))
    description: Mapped[str] = mapped_column(Text, default="")
    input_schema: Mapped[dict] = mapped_column(JSON, default=dict)

    connection: Mapped[McpConnection] = relationship(back_populates="tools")


class AgentToolGrant(Base):
    """Agent may use a connection's tools: all of them (tool_name NULL) or one by name."""
    __tablename__ = "agent_tool_grants"
    __table_args__ = (UniqueConstraint("agent_id", "connection_id", "tool_name"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    agent_id: Mapped[int] = mapped_column(ForeignKey("agents.id", ondelete="CASCADE"), index=True)
    connection_id: Mapped[int] = mapped_column(ForeignKey("mcp_connections.id", ondelete="CASCADE"), index=True)
    tool_name: Mapped[str | None] = mapped_column(String(200))

    agent: Mapped[Agent] = relationship(back_populates="grants")
    connection: Mapped[McpConnection] = relationship()


class PublicShare(Base):
    """Something a user put in the public district: a whole agent, or one of its files.
    Everyone can see it; other people's agents can use it if allow_agent_use."""
    __tablename__ = "public_shares"

    id: Mapped[int] = mapped_column(primary_key=True)
    owner_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    kind: Mapped[str] = mapped_column(String(10))   # "agent" | "file"
    agent_id: Mapped[int | None] = mapped_column(ForeignKey("agents.id", ondelete="CASCADE"))
    file_id: Mapped[int | None] = mapped_column(ForeignKey("agent_files.id", ondelete="CASCADE"))
    title: Mapped[str] = mapped_column(String(120))
    note: Mapped[str] = mapped_column(Text, default="")  # what it's for / how to use it
    allow_agent_use: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)

    owner: Mapped[User] = relationship()
    agent: Mapped[Agent | None] = relationship()
    file: Mapped[AgentFile | None] = relationship()


class Run(Base):
    """One sandbox for one agent: started when its owner opens a chat, stopped when they close it
    or it goes idle. Many turns (messages) happen in one run.

    status: starting -> ready <-> busy -> stopped | error.
    The sandbox authenticates with a run token ("rt_…"): only its sha256 is stored, it works only
    for this run, and only until the run ends."""
    __tablename__ = "runs"

    id: Mapped[int] = mapped_column(primary_key=True)
    agent_id: Mapped[int] = mapped_column(ForeignKey("agents.id", ondelete="CASCADE"), index=True)
    owner_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    credential_id: Mapped[int | None] = mapped_column(ForeignKey("model_credentials.id", ondelete="SET NULL"))
    status: Mapped[str] = mapped_column(String(20), default="starting")
    detail: Mapped[str] = mapped_column(Text, default="")
    provider: Mapped[str] = mapped_column(String(20))         # local | modal
    sandbox_id: Mapped[str] = mapped_column(String(200), default="")
    token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    last_active_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)  # owner's last message
    last_seen_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)    # sandbox's last poll
    ended_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    agent: Mapped[Agent] = relationship()


class RunEvent(Base):
    """Everything in a run's conversation, in order (id is the cursor). kind:
    user | text | tool | tool_result | done | status | error. The sandbox posts all but `user`."""
    __tablename__ = "run_events"

    id: Mapped[int] = mapped_column(primary_key=True)
    run_id: Mapped[int] = mapped_column(ForeignKey("runs.id", ondelete="CASCADE"), index=True)
    kind: Mapped[str] = mapped_column(String(20))
    data: Mapped[dict] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
