from __future__ import annotations

import json
import re
import threading
import time
from difflib import SequenceMatcher
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from mutagen.id3 import APIC, ID3, ID3NoHeaderError, TALB, TIT2, TPE1, TDRC, TCON, TRCK


MUSICBRAINZ_BASE = "https://musicbrainz.org/ws/2"
COVER_ART_BASE = "https://coverartarchive.org"
ITUNES_SEARCH = "https://itunes.apple.com/search"
USER_AGENT = "TikSave/0.4.0 (https://github.com/viccentebb-eng/TikSave)"
MB_LOCK = threading.Lock()
MB_LAST_REQUEST = 0.0

NOISE_RE = re.compile(
    r"\s*[\[(](?:official\s*)?(?:music\s*)?(?:video|audio|lyrics?|lyric\s*video|"
    r"visuali[sz]er|hd|4k|live|remaster(?:ed)?(?:\s*\d{4})?)[^\])]*[\])]",
    re.IGNORECASE,
)
TRAILING_NOISE_RE = re.compile(
    r"\s*[-–—|]\s*(?:official\s*)?(?:music\s*)?(?:video|audio|lyrics?|"
    r"visuali[sz]er|hd|4k|live)\s*$",
    re.IGNORECASE,
)


def _normalize(value: str | None) -> str:
    if not value:
        return ""
    value = value.replace("_", " ")
    value = NOISE_RE.sub("", value)
    value = TRAILING_NOISE_RE.sub("", value)
    value = re.sub(r"\s+", " ", value).strip(" -–—|")
    return value.strip()


def _ratio(a: str | None, b: str | None) -> float:
    a_norm = _normalize(a).casefold()
    b_norm = _normalize(b).casefold()
    if not a_norm or not b_norm:
        return 0.0
    return SequenceMatcher(None, a_norm, b_norm).ratio() * 100.0


def _split_title(title: str, uploader: str | None) -> tuple[str | None, str]:
    cleaned = _normalize(title)
    for separator in (" - ", " – ", " — ", " | "):
        if separator in cleaned:
            left, right = cleaned.split(separator, 1)
            if left.strip() and right.strip():
                return _normalize(left), _normalize(right)

    artist = _normalize(uploader)
    artist = re.sub(
        r"\s*[-–—|]\s*(?:topic|official|vevo|music)\s*$",
        "",
        artist,
        flags=re.IGNORECASE,
    ).strip()
    return (artist or None), cleaned


def candidate_from_info(info: dict[str, Any]) -> tuple[str | None, str]:
    title = _normalize(info.get("track"))
    artist = _normalize(info.get("artist"))

    if title:
        return (artist or _normalize(info.get("uploader")) or None), title

    return _split_title(
        str(info.get("title") or info.get("description") or ""),
        info.get("uploader") or info.get("channel"),
    )


def _musicbrainz_json(path: str, params: dict[str, str]) -> dict[str, Any]:
    global MB_LAST_REQUEST

    query = urlencode(params)
    url = f"{MUSICBRAINZ_BASE}{path}?{query}"

    with MB_LOCK:
        elapsed = time.monotonic() - MB_LAST_REQUEST
        if elapsed < 1.05:
            time.sleep(1.05 - elapsed)

        request = Request(
            url,
            headers={
                "User-Agent": USER_AGENT,
                "Accept": "application/json",
            },
        )

        try:
            with urlopen(request, timeout=12) as response:
                payload = json.loads(response.read().decode("utf-8"))
        finally:
            MB_LAST_REQUEST = time.monotonic()

    return payload


def _artist_credit(recording: dict[str, Any]) -> str:
    parts: list[str] = []
    for item in recording.get("artist-credit") or []:
        if isinstance(item, str):
            parts.append(item)
        elif isinstance(item, dict):
            name = item.get("name") or (item.get("artist") or {}).get("name")
            if name:
                parts.append(str(name))
            if item.get("joinphrase"):
                parts.append(str(item["joinphrase"]))
    return "".join(parts).strip()


def _pick_release(recording: dict[str, Any]) -> dict[str, Any] | None:
    releases = recording.get("releases") or []
    if not releases:
        return None

    def release_key(release: dict[str, Any]) -> tuple[int, str]:
        official = 0 if str(release.get("status") or "").lower() == "official" else 1
        date = str(release.get("date") or "9999")
        return official, date

    return sorted(releases, key=release_key)[0]


def find_musicbrainz_match(info: dict[str, Any]) -> dict[str, Any] | None:
    artist_hint, title_hint = candidate_from_info(info)
    if not title_hint:
        return None

    query_parts = [f'recording:"{title_hint.replace(chr(34), "")}"']
    if artist_hint:
        query_parts.append(f'artist:"{artist_hint.replace(chr(34), "")}"')

    search = _musicbrainz_json(
        "/recording/",
        {
            "query": " AND ".join(query_parts),
            "fmt": "json",
            "limit": "5",
        },
    )

    best: tuple[float, dict[str, Any]] | None = None

    for recording in search.get("recordings") or []:
        title_score = _ratio(title_hint, recording.get("title"))
        artist_name = _artist_credit(recording)
        artist_score = _ratio(artist_hint, artist_name) if artist_hint else 80.0
        mb_score = float(recording.get("score") or 0)

        confidence = (title_score * 0.45) + (artist_score * 0.30) + (mb_score * 0.25)

        if best is None or confidence > best[0]:
            best = (confidence, recording)

    if best is None or best[0] < 78:
        return None

    recording = best[1]
    recording_id = recording.get("id")
    if not recording_id:
        return None

    detail = _musicbrainz_json(
        f"/recording/{recording_id}",
        {
            "inc": "artist-credits+releases+release-groups",
            "fmt": "json",
        },
    )

    artist = _artist_credit(detail) or _artist_credit(recording) or artist_hint
    release = _pick_release(detail)
    album = release.get("title") if release else None
    date = release.get("date") if release else None
    release_id = release.get("id") if release else None
    release_group_id = None

    if release:
        release_group = release.get("release-group") or {}
        release_group_id = release_group.get("id")

    return {
        "recording_id": recording_id,
        "confidence": round(best[0], 1),
        "title": detail.get("title") or recording.get("title") or title_hint,
        "artist": artist or artist_hint,
        "album": album,
        "date": date,
        "release_id": release_id,
        "release_group_id": release_group_id,
    }


def _itunes_match(match: dict[str, Any]) -> dict[str, Any] | None:
    artist = _normalize(str(match.get("artist") or ""))
    title = _normalize(str(match.get("title") or ""))
    album = _normalize(str(match.get("album") or ""))

    if not artist or not title:
        return None

    term = " ".join(part for part in (artist, title, album) if part)
    url = f"{ITUNES_SEARCH}?{urlencode({'term': term, 'entity': 'song', 'limit': '10'})}"
    request = Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/json"})

    try:
        with urlopen(request, timeout=12) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except (HTTPError, URLError, TimeoutError, ValueError):
        return None

    best: tuple[float, dict[str, Any]] | None = None

    for item in payload.get("results") or []:
        title_score = _ratio(title, item.get("trackName"))
        artist_score = _ratio(artist, item.get("artistName"))
        album_score = _ratio(album, item.get("collectionName")) if album else 80.0
        confidence = (title_score * 0.5) + (artist_score * 0.35) + (album_score * 0.15)

        if best is None or confidence > best[0]:
            best = (confidence, item)

    if best is None or best[0] < 78:
        return None

    item = best[1]
    artwork = item.get("artworkUrl100") or item.get("artworkUrl60")
    if artwork:
        artwork = re.sub(r"\d+x\d+bb", "800x800bb", artwork)

    return {
        "confidence": round(best[0], 1),
        "title": item.get("trackName"),
        "artist": item.get("artistName"),
        "album": item.get("collectionName"),
        "date": str(item.get("releaseDate") or "")[:10] or None,
        "track_number": item.get("trackNumber"),
        "genre": item.get("primaryGenreName"),
        "artwork": artwork,
    }


def _download_image(url: str | None) -> tuple[bytes, str] | None:
    if not url:
        return None
    request = Request(url, headers={"User-Agent": USER_AGENT})
    try:
        with urlopen(request, timeout=15) as response:
            data = response.read()
            mime = response.headers.get_content_type() or "image/jpeg"
            if data:
                return data, mime
    except (HTTPError, URLError, TimeoutError):
        return None
    return None


def _download_cover(match: dict[str, Any]) -> tuple[bytes, str] | None:
    candidates: list[str] = []

    if match.get("release_id"):
        candidates.append(f"{COVER_ART_BASE}/release/{match['release_id']}/front-500")

    if match.get("release_group_id"):
        candidates.append(
            f"{COVER_ART_BASE}/release-group/{match['release_group_id']}/front-500"
        )

    for url in candidates:
        request = Request(url, headers={"User-Agent": USER_AGENT})
        try:
            with urlopen(request, timeout=15) as response:
                data = response.read()
                content_type = response.headers.get_content_type() or "image/jpeg"
                if data:
                    return data, content_type
        except (HTTPError, URLError, TimeoutError):
            continue

    itunes = _itunes_match(match)
    if itunes and itunes.get("artwork"):
        cover = _download_image(str(itunes["artwork"]))
        if cover:
            return cover

    return None


def _safe_filename(value: str) -> str:
    value = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "", value)
    value = re.sub(r"\s+", " ", value).strip(" .")
    return value[:180] or "track"


def _unique_target(path: Path) -> Path:
    if not path.exists():
        return path

    stem = path.stem
    suffix = path.suffix

    for index in range(2, 1000):
        candidate = path.with_name(f"{stem} ({index}){suffix}")
        if not candidate.exists():
            return candidate

    return path


def apply_music_metadata(mp3_path: Path, info: dict[str, Any]) -> dict[str, Any]:
    if not mp3_path.exists():
        return {
            "matched": False,
            "path": str(mp3_path),
            "note": "El MP3 no se encontró para etiquetarlo.",
        }

    try:
        match = find_musicbrainz_match(info)
    except Exception as exc:
        return {
            "matched": False,
            "path": str(mp3_path),
            "note": f"MusicBrainz no respondió: {exc}",
        }

    if not match:
        return {
            "matched": False,
            "path": str(mp3_path),
            "note": "No hubo una coincidencia musical suficientemente confiable.",
        }

    try:
        try:
            tags = ID3(mp3_path)
        except ID3NoHeaderError:
            tags = ID3()

        tags.delall("TIT2")
        tags.delall("TPE1")
        tags.delall("TALB")
        tags.delall("TDRC")
        tags.delall("APIC")

        if match.get("title"):
            tags.add(TIT2(encoding=3, text=str(match["title"])))
        if match.get("artist"):
            tags.add(TPE1(encoding=3, text=str(match["artist"])))
        if match.get("album"):
            tags.add(TALB(encoding=3, text=str(match["album"])))
        itunes = _itunes_match(match)

        if match.get("date"):
            tags.add(TDRC(encoding=3, text=str(match["date"])))
        elif itunes and itunes.get("date"):
            tags.add(TDRC(encoding=3, text=str(itunes["date"])))

        if itunes and itunes.get("track_number"):
            tags.add(TRCK(encoding=3, text=str(itunes["track_number"])))
        if itunes and itunes.get("genre"):
            tags.add(TCON(encoding=3, text=str(itunes["genre"])))

        cover = _download_cover(match)
        if cover:
            image_data, mime = cover
            tags.add(
                APIC(
                    encoding=3,
                    mime=mime,
                    type=3,
                    desc="Cover",
                    data=image_data,
                )
            )

        tags.save(mp3_path, v2_version=3)

        artist = str(match.get("artist") or "Artista")
        title = str(match.get("title") or mp3_path.stem)
        target = mp3_path.with_name(_safe_filename(f"{artist} - {title}") + ".mp3")

        if target.resolve() != mp3_path.resolve():
            target = _unique_target(target)
            mp3_path.rename(target)
        else:
            target = mp3_path

        return {
            "matched": True,
            "path": str(target),
            "title": match.get("title"),
            "artist": match.get("artist"),
            "album": match.get("album"),
            "date": match.get("date"),
            "confidence": match.get("confidence"),
            "cover": bool(cover),
            "source": "MusicBrainz + Cover Art Archive/iTunes",
        }

    except Exception as exc:
        return {
            "matched": False,
            "path": str(mp3_path),
            "note": f"No se pudieron escribir los metadatos: {exc}",
        }
