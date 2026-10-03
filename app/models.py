from typing import Literal

from pydantic import BaseModel, Field

DownloadMode = Literal["video", "mp3", "audio", "transcript", "cover"]


class InspectRequest(BaseModel):
    url: str


class DownloadRequest(BaseModel):
    url: str
    mode: DownloadMode = "video"
    transcript: bool = False
    cover: bool = False
    notes: bool = False


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
    full_content: bool = False
    render: Literal["auto", "always", "never"] = "auto"
    depth: int = Field(default=0, ge=0, le=2)
    max_pages: int = Field(default=10, ge=1, le=50)


class SettingsUpdate(BaseModel):
    download_dir: str | None = None
    subtitle_langs: list[str] | None = None
    organize_by_site: bool | None = None
    prefer_h264: bool | None = None


class PathsRequest(BaseModel):
    paths: list[str] = Field(default_factory=list, max_length=200)


class PathRequest(BaseModel):
    path: str | None = None
