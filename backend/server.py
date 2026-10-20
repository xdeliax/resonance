#!/usr/bin/env python3
"""Loopback-only API used by the local Resonance Vite development app."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote

ROOT = Path(__file__).resolve().parent
ANALYZER = ROOT / "analyze_audio.py"
ALLOWED_ORIGINS = {"http://localhost:5173", "http://127.0.0.1:5173"}
MAX_AUDIO_BYTES = 250 * 1024 * 1024


class Handler(BaseHTTPRequestHandler):
    server_version = "ResonanceLocal/1"

    def do_GET(self) -> None:
        if self.path == "/api/health":
            self._json(200, {"ok": True, "service": "local-audio-analysis"})
        else:
            self._json(404, {"error": "Not found."})

    def do_POST(self) -> None:
        if self.path != "/api/analyze":
            self._json(404, {"error": "Not found."})
            return
        if self.headers.get("Origin") not in ALLOWED_ORIGINS:
            self._json(403, {"error": "Requests must come from the local Resonance development site."})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            self._json(400, {"error": "Invalid audio upload size."})
            return
        if length <= 0 or length > MAX_AUDIO_BYTES:
            self._json(413, {"error": "Choose an audio file smaller than 250 MB."})
            return
        name = unquote(self.headers.get("X-Audio-File-Name", "track.wav")).replace("/", "_").replace("\\", "_")
        suffix = Path(name).suffix[:12] or ".audio"
        data = self.rfile.read(length)
        if len(data) != length:
            self._json(400, {"error": "The audio upload was incomplete."})
            return

        temp_path: Path | None = None
        output_path: Path | None = None
        try:
            with tempfile.NamedTemporaryFile(prefix="resonance-", suffix=suffix, dir=ROOT / "cache", delete=False) as temp:
                temp.write(data)
                temp_path = Path(temp.name)
            output_path = temp_path.with_suffix(".analysis.json")
            completed = subprocess.run(
                [sys.executable, str(ANALYZER), str(temp_path), "-o", str(output_path)],
                cwd=ROOT.parent,
                capture_output=True,
                text=True,
                timeout=60 * 60,
                check=False,
            )
            if completed.returncode != 0:
                detail = completed.stderr.strip().splitlines()
                message = detail[-1] if detail else "Local audio analysis failed."
                self._json(422, {"error": message})
                return
            result = json.loads(output_path.read_text(encoding="utf-8"))
            result["audio"]["fileName"] = name
            self._json(200, result)
        except subprocess.TimeoutExpired:
            self._json(504, {"error": "Audio analysis took too long and was stopped."})
        except Exception as error:
            self._json(500, {"error": f"Local analysis service error: {error}"})
        finally:
            for path in (temp_path, output_path):
                if path:
                    try:
                        path.unlink(missing_ok=True)
                    except OSError:
                        pass

    def _json(self, status: int, data: dict) -> None:
        payload = json.dumps(data).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, format: str, *args) -> None:
        print(f"[resonance-local] {format % args}")


def main() -> None:
    (ROOT / "cache").mkdir(exist_ok=True)
    host = "127.0.0.1"
    port = int(os.environ.get("RESONANCE_ANALYSIS_PORT", "8765"))
    server = ThreadingHTTPServer((host, port), Handler)
    print(f"Resonance local analysis listening at http://{host}:{port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
