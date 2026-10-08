"""What the API accepts. Validation lives here so the routers can trust their input."""

from typing import Literal

from pydantic import BaseModel, EmailStr, Field

Slug = Field(pattern=r"^[a-z0-9][a-z0-9_-]{2,29}$")
Color = Field(default=None, pattern=r"^#[0-9a-fA-F]{6}$")
MAX_FILE = 200_000


class SignupIn(BaseModel):
    email: EmailStr
    username: str = Slug
    password: str = Field(min_length=8, max_length=200)


class LoginIn(BaseModel):
    login: str = Field(min_length=1, description="email or username")
    password: str


class FileIn(BaseModel):
    path: str = Field(min_length=1, max_length=200, pattern=r"^[A-Za-z0-9_][A-Za-z0-9_./ -]*\.(md|txt)$")
    content: str = Field(max_length=MAX_FILE)


class AgentIn(BaseModel):
    markdown: str = Field(min_length=1, max_length=MAX_FILE, description="AGENT.md: the agent's definition")
    name: str | None = Field(default=None, max_length=80)
    color: str | None = Color
    files: list[FileIn] = Field(default_factory=list, max_length=50)


class AgentPatch(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=80)
    description: str | None = Field(default=None, max_length=2000)
    color: str | None = Color
    can_use_public: bool | None = None


class GrantIn(BaseModel):
    connection_id: int
    tool_name: str | None = None  # None: every tool on the connection


class GrantsIn(BaseModel):
    grants: list[GrantIn] = Field(max_length=500)


class McpIn(BaseModel):
    name: str = Field(min_length=1, max_length=60)
    transport: Literal["http", "stdio"] = "http"
    url: str | None = Field(default=None, max_length=2000)
    command: str | None = Field(default=None, max_length=2000)
    auth_header: str | None = Field(default=None, max_length=4000,
                                    description='e.g. "Bearer sk-…". Stored encrypted, never returned')


class McpPatch(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=60)
    url: str | None = Field(default=None, max_length=2000)
    command: str | None = Field(default=None, max_length=2000)
    auth_header: str | None = Field(default=None, max_length=4000, description='"" removes it')


class ShareIn(BaseModel):
    kind: Literal["agent", "file"]
    agent_id: int | None = None
    file_id: int | None = None
    title: str | None = Field(default=None, max_length=120)
    note: str = Field(default="", max_length=2000)
    allow_agent_use: bool = True


class SharePatch(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=120)
    note: str | None = Field(default=None, max_length=2000)
    allow_agent_use: bool | None = None
