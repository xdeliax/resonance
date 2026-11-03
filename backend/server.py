#!/usr/bin/env python3
"""Loopback-only API used by the local Resonance Vite development app."""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Lock
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, unquote, urlencode, urlsplit
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parent
ANALYZER = ROOT / "analyze_audio.py"
ALLOWED_ORIGINS = {"http://localhost:5173", "http://127.0.0.1:5173"}
MAX_AUDIO_BYTES = 250 * 1024 * 1024
MAX_LIBRARY_AUDIO_BYTES = 40 * 1024 * 1024
AUDIUS_API = "https://api.audius.co/v1"
AUDIUS_APP = "ResonanceVisualStudy"
TRACK_ID = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
# Handpicked house and Afro house tracks with distinct artwork. Featured
# metadata is refreshed from Audius; stream availability can change separately.
FEATURED_TRACK_IDS = (
    "WNKrwql",  # Move (Siente Nefzak Remix) — Nefzak
    "XVR3dKa",  # Unfold Your Heart (Kamilo Sanclemente Remix) — Pandhora
    "NlX69qN",  # Love — Danny Quest & Wolsh
    "V43vZ4a",  # Dune Ritual - Calor — Chakra Records
    "y232E",    # That's House Music — Arnold & Lane
    "rbxyzNQ",  # BELLA — RDJMB
)
FEATURED_DISPLAY = {
    "WNKrwql": ("Move (Siente Nefzak Remix)", "Adam Port, Stryv, Keinemusik, Orso, Malachiii · Nefzak"),
    "XVR3dKa": ("Unfold Your Heart (Kamilo Sanclemente Remix)", "Pandhora & Cahelo"),
    "NlX69qN": ("Love", "Danny Quest & Wolsh"),
    "V43vZ4a": ("Calor | حار", "Dune Ritual"),
    "y232E": ("That's House Music", "Arnold & Lane"),
    "rbxyzNQ": ("BELLA", "RDJMB"),
}
FEATURED_CACHE_SECONDS = 15 * 60
_featured_cache: tuple[float, list[dict]] | None = None
_featured_lock = Lock()


def audius_request(path: str, params: dict[str, str] | None = None):
    query = urlencode({**(params or {}), "app_name": AUDIUS_APP})
    return urlopen(Request(f"{AUDIUS_API}{path}?{query}", headers={
        "User-Agent": "Resonance/0.1 (+local visual study)",
        "Accept": "application/json, audio/mpeg, */*",
    }), timeout=25)


def audius_track(track_id: str) -> dict:
    with audius_request(f"/tracks/{track_id}") as response:
        return json.load(response)["data"]


def track_summary(track: dict, *, require_artwork: bool = False) -> dict | None:
    track_id = str(track.get("id", ""))
    if not TRACK_ID.fullmatch(track_id):
        return None
    if not (track.get("access") or {}).get("stream", track.get("is_streamable", False)):
        return None
    artwork = (track.get("artwork") or {}).get("480x480")
    if require_artwork and (not isinstance(artwork, str) or not artwork.startswith("https://")):
        return None
    return {
        "id": track_id,
        "title": track.get("title") or "Untitled",
        "artist": (track.get("user") or {}).get("name") or "Unknown artist",
        "artwork": artwork,
        "duration": track.get("duration", 0),
    }


def featured_tracks() -> list[dict]:
    global _featured_cache
    with _featured_lock:
        if _featured_cache and time.monotonic() - _featured_cache[0] < FEATURED_CACHE_SECONDS:
            return _featured_cache[1]
        found: dict[str, dict] = {}
        with ThreadPoolExecutor(max_workers=len(FEATURED_TRACK_IDS)) as pool:
            futures = {pool.submit(audius_track, track_id): track_id for track_id in FEATURED_TRACK_IDS}
            for future in as_completed(futures):
                track_id = futures[future]
                try:
                    summary = track_summary(future.result(), require_artwork=True)
                    if summary:
                        summary["title"], summary["artist"] = FEATURED_DISPLAY[track_id]
                        # Audius rotates artwork hosts, and some returned hosts
                        # do not serve the image. Use the verified content mirror
                        # for this curated gallery and its canvas cover profile.
                        artwork_path = urlsplit(summary["artwork"]).path
                        if artwork_path.startswith("/content/"):
                            summary["artwork"] = f"https://v.monophonic.digital{artwork_path}"
                        found[track_id] = summary
                except (HTTPError, URLError, TimeoutError, KeyError, ValueError) as error:
                    print(f"[resonance-local] featured track {track_id} unavailable: {error}")
        ordered = [found[track_id] for track_id in FEATURED_TRACK_IDS if track_id in found]
        if ordered:
            _featured_cache = (time.monotonic(), ordered)
        return ordered


class Handler(BaseHTTPRequestHandler):
    server_version = "ResonanceLocal/1"

    def do_GET(self) -> None:
        url = urlsplit(self.path)
        if url.path == "/api/health":
            self._json(200, {"ok": True, "service": "local-audio-analysis"})
            return
        params = parse_qs(url.query)
        try:
            if url.path == "/api/library/featured":
                tracks = featured_tracks()
                if not tracks:
                    self._json(502, {"error": "The featured Audius tracks are unavailable right now."})
                    return
                self._json(200, {"tracks": tracks})
                return
            if url.path == "/api/library/search":
                query = params.get("q", [""])[0].strip()[:100]
                if len(query) < 2:
                    self._json(200, {"tracks": []})
                    return
                with audius_request("/tracks/search", {"query": query, "limit": "14"}) as response:
                    tracks = json.load(response).get("data", [])
                self._json(200, {"tracks": [summary for track in tracks if (summary := track_summary(track))]})
                return
            if url.path == "/api/library/audio":
                track_id = params.get("id", [""])[0]
                if not TRACK_ID.fullmatch(track_id):
                    self._json(400, {"error": "Invalid track ID."})
                    return
                track = audius_track(track_id)
                if not (track.get("access") or {}).get("stream", track.get("is_streamable", False)):
                    self._json(403, {"error": "This track is not available for streaming."})
                    return
                try:
                    with audius_request(f"/tracks/{track_id}/stream") as response:
                        data = response.read(MAX_LIBRARY_AUDIO_BYTES + 1)
                except HTTPError as error:
                    if error.code == 404:
                        self._json(424, {"error": "This upload's audio stream is unavailable. You can load a local audio file for this cover."})
                        return
                    raise
                if len(data) > MAX_LIBRARY_AUDIO_BYTES:
                    self._json(413, {"error": "This track is too large for local analysis (40 MB limit)."})
                    return
                self.send_response(200)
                self.send_header("Content-Type", "audio/mpeg")
                self.send_header("Content-Length", str(len(data)))
                self.send_header("Cache-Control", "no-store")
                self.send_header("X-Content-Type-Options", "nosniff")
                self.end_headers()
                self.wfile.write(data)
                return
        except (HTTPError, URLError, TimeoutError, KeyError, ValueError) as error:
            self._json(502, {"error": f"Audius is unavailable for this request: {error}"})
            return
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
