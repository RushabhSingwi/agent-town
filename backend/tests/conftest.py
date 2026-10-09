import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import sessionmaker

from app.db import Base, get_db, make_engine
from app.main import app


@pytest.fixture(autouse=True)
def test_settings(monkeypatch):
    """Tests must not depend on a developer's backend/.env (which may say modal, or a tunnel URL)."""
    from app.config import settings
    for k, v in {"sandbox_provider": "local", "public_url": "http://127.0.0.1:8000",
                 "allow_subscription_tokens": True, "allow_private_mcp_hosts": False}.items():
        monkeypatch.setattr(settings(), k, v)


@pytest.fixture
def db_session(tmp_path):
    engine = make_engine(f"sqlite:///{tmp_path / 'test.db'}")
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)

    def override():
        s = Session()
        try:
            yield s
        finally:
            s.close()

    app.dependency_overrides[get_db] = override
    yield Session
    app.dependency_overrides.clear()


@pytest.fixture
def client(db_session):
    return TestClient(app)


@pytest.fixture
def make_user(db_session):
    """A fresh signed-in client per user, so cookies don't mix."""
    def make(username: str) -> TestClient:
        c = TestClient(app)
        r = c.post("/api/auth/signup", json={"email": f"{username}@example.com", "username": username,
                                             "password": "correct horse battery"})
        assert r.status_code == 200, r.text
        return c
    return make


AGENT_MD = """---
name: reel-writer
description: Scripts short videos.
---

# Reel writer

Write hooks and shot lists.
"""
