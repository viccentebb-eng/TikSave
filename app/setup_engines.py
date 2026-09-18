from __future__ import annotations

import argparse
import json
import shutil
import sys

from app import __version__
from app.dezoom import install as install_dezoomify
from app.dezoom import status as dezoom_status
from app.native_image import status as native_image_status


def emit(payload: dict) -> None:
    print(json.dumps(payload, ensure_ascii=False))


def install_command(force: bool) -> int:
    try:
        result = install_dezoomify(force=force)
        emit({"ok": bool(result.get("installed")), "dezoomify": result})
        return 0 if result.get("installed") else 2
    except Exception as exc:
        emit({
            "ok": False,
            "error": f"{type(exc).__name__}: {exc}",
        })
        return 1


def verify_command() -> int:
    payload = {
        "ok": True,
        "version": __version__,
        "ffmpeg": shutil.which("ffmpeg"),
        "native_image": native_image_status(),
        "dezoomify": dezoom_status(force=True),
    }
    emit(payload)
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="TikSave setup helper")
    sub = parser.add_subparsers(dest="command", required=True)

    install_parser = sub.add_parser("install-dezoomify")
    install_parser.add_argument("--force", action="store_true")

    sub.add_parser("verify")

    args = parser.parse_args(argv)

    if args.command == "install-dezoomify":
        return install_command(bool(args.force))
    if args.command == "verify":
        return verify_command()

    return 2


if __name__ == "__main__":
    raise SystemExit(main())
