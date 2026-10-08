from typing import Literal

from pydantic import BaseModel, Field

DownloadMode = Literal["video", "mp3", "audio", "transcript", "cover"]


class InspectRequest(BaseModel):
    url: str


class CookieItem(BaseModel):
    name: str = Field(max_length=500)
    value: str = Field(default="", max_length=8000)
    domain: str = Field(max_length=300)
    path: str = Field(default="/", max_length=500)
    secure: bool = False
    httpOnly: bool = False
    expires: float | None = None


class DownloadRequest(BaseModel):
    url: str
    mode: DownloadMode = "video"
    transcript: bool = False
    cover: bool = False
    notes: bool = False
    start: float | None = Field(default=None, ge=0)
    end: float | None = Field(default=None, gt=0)
    referer: str | None = Field(default=None, max_length=2000)  # pagina donde se vio el video (CDNs lo exigen)
    title: str | None = Field(default=None, max_length=300)  # titulo de la pagina, para nombrar archivos sueltos
    cookies: list[CookieItem] | None = Field(default=None, max_length=600)  # sesion del navegador (solo para este trabajo)


class TrimRequest(BaseModel):
    path: str
    start: float = Field(ge=0)
    end: float = Field(gt=0)
    precise: bool = True


class BatchRequest(BaseModel):
    urls: list[str] = Field(min_length=1, max_length=100)
    mode: DownloadMode = "video"
    transcript: bool = False
    cover: bool = False
    notes: bool = False


class ExpandRequest(BaseModel):
    url: str
    limit: int = Field(default=20, ge=1, le=100)


class CaptureRequest(BaseModel):
    url: str
    markdown: bool = True
    html: bool = False
    screenshot: bool = False
    pdf: bool = False
    docx: bool = False
    epub: bool = False
    images: bool = True
    html_source: str | None = Field(default=None, max_length=40_000_000)  # DOM enviado por la extension
    full_content: bool = False
    render: Literal["auto", "always", "never"] = "auto"
    depth: int = Field(default=0, ge=0, le=8)
    max_pages: int = Field(default=10, ge=1, le=1000)
    files: bool = False
    media: bool = False


class SettingsUpdate(BaseModel):
    download_dir: str | None = None
    subtitle_langs: list[str] | None = None
    organize_by_site: bool | None = None
    prefer_h264: bool | None = None
    allow_other_sites: bool | None = None
    cookies_browser: str | None = None


class PathsRequest(BaseModel):
    paths: list[str] = Field(default_factory=list, max_length=200)


class PathRequest(BaseModel):
    path: str | None = None


class RecordingStart(BaseModel):
    title: str = Field(default="", max_length=300)
    page_url: str = Field(default="", max_length=2000)


class RecordingChunk(BaseModel):
    seq: int = Field(ge=0)
    data: str = Field(max_length=16_000_000)  # base64


class RecordingFinish(BaseModel):
    to_mp4: bool = True
