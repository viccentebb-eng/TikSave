from app.textutils import build_notes, subtitles_to_text

SRT = """1
00:00:00,000 --> 00:00:02,000
Hola a todos

2
00:00:02,000 --> 00:00:04,000
Hola a todos

3
00:00:04,000 --> 00:00:06,500
<i>esto es</i> una prueba
"""
VTT = """WEBVTT
Kind: captions

00:00:00.000 --> 00:00:02.000 align:start
Primera &amp; linea

00:00:02.000 --> 00:00:03.000
segunda
"""


def test_srt_dedupes_and_strips():
    assert subtitles_to_text(SRT) == "Hola a todos esto es una prueba"


def test_vtt():
    assert subtitles_to_text(VTT) == "Primera & linea segunda"


def test_notes_with_and_without_transcript():
    info = {"title": 'Un "titulo"', "description": "Hola #IA #Claude", "uploader": "x", "upload_date": "20240102",
            "duration": 75, "view_count": 10, "webpage_url": "https://www.tiktok.com/@x/video/1"}
    md = build_notes(info, "TikTok", "texto largo", "subtitulos (es)")
    assert md.startswith("---") and 'title: "Un \\"titulo\\""' in md
    assert "published: 2024-01-02" in md and "duration: 1:15" in md and "tags: [Claude, IA]" in md
    assert "texto largo" in md
    assert "No hay subtitulos" in build_notes(info, "TikTok", None)
