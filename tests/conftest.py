import os
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
_tmp = tempfile.mkdtemp(prefix="tiksave-test-")
os.environ.setdefault("TIKSAVE_HOME", _tmp)
os.environ.setdefault("TIKSAVE_DOWNLOAD_DIR", str(Path(_tmp) / "dl"))
os.environ.setdefault("TIKSAVE_ALLOW_PRIVATE", "1")  # los tests usan un servidor en 127.0.0.1
