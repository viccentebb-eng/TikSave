"""Ajustes persistentes de TikSave (~/.tiksave/settings.json)."""
from __future__ import annotations

import json
import os
import threading
from pathlib import Path

from pydantic import BaseModel, Field, field_validator


def app_home() -> Path:
    configured = os.getenv("TIKSAVE_HOME")
    home = Path(configured).expanduser() if configured else Path.home() / ".tiksave"
    home.mkdir(parents=True, exist_ok=True)
    return home


def default_download_dir() -> Path:
    configured = os.getenv("TIKSAVE_DOWNLOAD_DIR")
    if configured:
        return Path(configured).expanduser().resolve()
    return (Path.home() / "Downloads" / "TikSave").resolve()


class Settings(BaseModel):
    download_dir: str = ""
    subtitle_langs: list[str] = Field(default_factory=lambda: ["es", "en"])
    organize_by_site: bool = True
    prefer_h264: bool = False

    @field_validator("subtitle_langs")
    @classmethod
    def _langs(cls, value: list[str]) -> list[str]:
        cleaned = [v.strip() for v in value if v and v.strip()]
        return cleaned[:6] or ["es", "en"]


class SettingsStore:
    def __init__(self, path: Path | None = None) -> None:
        self.path = path or app_home() / "settings.json"
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self._settings = self._load()
        if not self._settings.download_dir:
            self._settings.download_dir = str(default_download_dir())
        elif os.getenv("TIKSAVE_DOWNLOAD_DIR"):
            self._settings.download_dir = str(default_download_dir())
        Path(self._settings.download_dir).mkdir(parents=True, exist_ok=True)

    def _load(self) -> Settings:
        try:
            return Settings(**json.loads(self.path.read_text(encoding="utf-8")))
        except Exception:
            return Settings()

    @property
    def value(self) -> Settings:
        with self._lock:
            return self._settings.model_copy(deep=True)

    @property
    def download_dir(self) -> Path:
        return Path(self.value.download_dir)

    def update(self, changes: dict) -> Settings:
        with self._lock:
            merged = {**self._settings.model_dump(), **{k: v for k, v in changes.items() if v is not None}}
            new = Settings(**merged)
            target = Path(new.download_dir).expanduser()
            target.mkdir(parents=True, exist_ok=True)
            new.download_dir = str(target.resolve())
            self._settings = new
            tmp = self.path.with_suffix(".tmp")
            tmp.write_text(new.model_dump_json(indent=2), encoding="utf-8")
            tmp.replace(self.path)
            return new.model_copy(deep=True)
