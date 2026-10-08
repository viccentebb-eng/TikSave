"""Cola de trabajos con historial persistente."""
from __future__ import annotations

import json
import threading
import time
import uuid
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

TERMINAL = {"done", "error", "cancelled"}
MAX_HISTORY = 200


@dataclass
class Job:
    id: str
    kind: str  # "download" | "capture"
    url: str
    mode: str
    options: dict[str, Any] = field(default_factory=dict)
    status: str = "queued"
    stage: str | None = None
    progress: float = 0.0
    speed: str | None = None
    eta: str | None = None
    title: str | None = None
    uploader: str | None = None
    thumbnail: str | None = None
    files: list[str] = field(default_factory=list)
    filename: str | None = None
    warnings: list[str] = field(default_factory=list)
    error: str | None = None
    created_at: float = field(default_factory=time.time)
    finished_at: float | None = None


class JobCancelled(Exception):
    pass


class JobStore:
    def __init__(self, path: Path | None = None) -> None:
        self._path = path
        if path:
            path.parent.mkdir(parents=True, exist_ok=True)
        self._jobs: dict[str, Job] = {}
        self._cancel: set[str] = set()
        self._lock = threading.RLock()
        self._load()

    def _load(self) -> None:
        if not self._path or not self._path.exists():
            return
        try:
            raw = json.loads(self._path.read_text(encoding="utf-8"))
        except Exception:
            return
        for item in raw:
            try:
                job = Job(**item)
            except TypeError:
                continue
            if job.status not in TERMINAL:
                job.status, job.error = "error", "Interrumpido al cerrar TikSave."
                job.finished_at = job.finished_at or time.time()
            self._jobs[job.id] = job

    def _persist(self) -> None:
        if not self._path:
            return
        jobs = sorted(self._jobs.values(), key=lambda j: j.created_at)[-MAX_HISTORY:]
        try:
            tmp = self._path.with_suffix(".tmp")
            tmp.write_text(json.dumps([asdict(j) for j in jobs], ensure_ascii=False), encoding="utf-8")
            tmp.replace(self._path)
        except OSError:
            pass

    def create(self, kind: str, url: str, mode: str, options: dict[str, Any] | None = None) -> Job:
        job = Job(id=uuid.uuid4().hex, kind=kind, url=url, mode=mode, options=options or {})
        with self._lock:
            self._jobs[job.id] = job
            self._trim()
        return job

    def _trim(self) -> None:
        if len(self._jobs) <= MAX_HISTORY * 2:
            return
        old = [j for j in sorted(self._jobs.values(), key=lambda j: j.created_at) if j.status in TERMINAL]
        for job in old[: len(self._jobs) - MAX_HISTORY]:
            self._jobs.pop(job.id, None)

    def update(self, job_id: str, **changes: Any) -> None:
        with self._lock:
            job = self._jobs.get(job_id)
            if not job:
                return
            for key, value in changes.items():
                setattr(job, key, value)
            if job.status in TERMINAL:
                job.finished_at = job.finished_at or time.time()
                self._persist()

    def get(self, job_id: str) -> dict[str, Any] | None:
        with self._lock:
            job = self._jobs.get(job_id)
            return asdict(job) if job else None

    def list(self, limit: int = 100) -> list[dict[str, Any]]:
        with self._lock:
            jobs = sorted(self._jobs.values(), key=lambda j: j.created_at, reverse=True)[:limit]
            return [asdict(j) for j in jobs]

    def request_cancel(self, job_id: str) -> bool:
        with self._lock:
            job = self._jobs.get(job_id)
            if not job or job.status in TERMINAL:
                return False
            self._cancel.add(job_id)
            if job.status == "queued":
                job.status = "cancelled"
                job.finished_at = time.time()
                self._persist()
            return True

    def check_cancel(self, job_id: str) -> None:
        with self._lock:
            if job_id in self._cancel:
                raise JobCancelled()

    def clear_finished(self) -> int:
        with self._lock:
            ids = [i for i, j in self._jobs.items() if j.status in TERMINAL]
            for i in ids:
                del self._jobs[i]
            self._persist()
            return len(ids)

    def remove(self, job_id: str) -> bool:
        with self._lock:
            job = self._jobs.get(job_id)
            if not job or job.status not in TERMINAL:
                return False
            del self._jobs[job_id]
            self._persist()
            return True
