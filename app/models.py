from typing import Literal

from pydantic import BaseModel, HttpUrl


DownloadMode = Literal["video", "mp3", "audio"]


class InspectRequest(BaseModel):
    url: HttpUrl


class DownloadRequest(BaseModel):
    url: HttpUrl
    mode: DownloadMode = "video"
