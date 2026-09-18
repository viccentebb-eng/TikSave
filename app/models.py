from typing import Literal

from pydantic import BaseModel, HttpUrl


DownloadMode = Literal["video", "mp3", "audio"]
VideoQuality = Literal["best", "2160", "1440", "1080", "720", "480", "360"]


class InspectRequest(BaseModel):
    url: HttpUrl
    playlist: bool = False


class DownloadRequest(BaseModel):
    url: HttpUrl
    mode: DownloadMode = "video"
    quality: VideoQuality = "best"
    playlist: bool = False
