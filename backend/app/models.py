"""The tables.

users ─┬─ sessions                 login sessions (only a hash of the cookie is stored)
       ├─ agents ─┬─ agent_files    the agent's markdown: AGENT.md plus any knowledge files
       │          └─ agent_tool_grants ──┐  which tools this agent may use
       ├─ mcp_connections ─ mcp_tools ◄──┘  a user's MCP servers and the tools they expose
       └─ public_shares             what a user put in the public district
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
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now, onupdate=now)

    owner: Mapped[User] = relationship(back_populates="agents")
    files: Mapped[list["AgentFile"]] = relationship(
        back_populates="agent", cascade="all, delete-orphan", order_by="AgentFile.path")
    grants: Mapped[list["AgentToolGrant"]] = relationship(
        back_populates="agent", cascade="all, delete-orphan")


DEFINITION = "AGENT.md"


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


class McpConnection(Base):
    __tablename__ = "mcp_connections"
    __table_args__ = (UniqueConstraint("owner_id", "name"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    owner_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(60))
    transport: Mapped[str] = mapped_column(String(10))       # "http" | "stdio"
    url: Mapped[str | None] = mapped_column(Text)            # http
    command: Mapped[str | None] = mapped_column(Text)        # stdio: runs in the sandbox, later
    auth_header_enc: Mapped[str | None] = mapped_column(Text)  # Fernet-encrypted Authorization value
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
