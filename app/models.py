from typing import Literal

from pydantic import BaseModel, HttpUrl


DownloadMode = Literal["video", "mp3", "audio", "subtitles"]
VideoQuality = Literal["best", "2160", "1440", "1080", "720", "480", "360"]
SubtitleFormat = Literal["srt", "vtt", "txt", "ass"]


class InspectRequest(BaseModel):
    url: HttpUrl
    playlist: bool = False


class DownloadRequest(BaseModel):
    url: HttpUrl
    mode: DownloadMode = "video"
    quality: VideoQuality = "best"
    playlist: bool = False
    selected_items: list[int] | None = None
    music_metadata: bool = False
    subtitle_format: SubtitleFormat = "srt"
    subtitle_languages: list[str] | None = None
    clip_start: float | None = None
    clip_end: float | None = None
    precise_clip: bool = False


class BrowserMediaRequest(BaseModel):
    page_url: HttpUrl
    media_url: HttpUrl | None = None
    mode: Literal["video", "mp3", "audio"] = "video"
    quality: VideoQuality = "best"
    clip_start: float | None = None
    clip_end: float | None = None
    precise_clip: bool = False


class DezoomRequest(BaseModel):
    source_url: HttpUrl
    page_url: HttpUrl | None = None
    output_format: Literal["jpg", "png", "webp"] = "jpg"


class MaxUrlResolveRequest(BaseModel):
    url: HttpUrl


class ImageBatchDownloadRequest(BaseModel):
    urls: list[HttpUrl]
    page_url: HttpUrl | None = None


class NativeImageRequest(BaseModel):
    url: HttpUrl
    page_url: HttpUrl | None = None
