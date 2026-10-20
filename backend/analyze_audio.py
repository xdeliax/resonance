#!/usr/bin/env python3
"""Create a cached, local Resonance audio analysis JSON file."""

from __future__ import annotations

import argparse
import hashlib
import json
import logging
import math
import sys
from datetime import datetime, timezone
from importlib.metadata import PackageNotFoundError, version
from pathlib import Path
from typing import Any

SCHEMA_VERSION = 1
ANALYSIS_SETTINGS_VERSION = 1
MODEL_NAME = "Beat This!"
CHECKPOINT = "final0"
FEATURE_SAMPLE_RATE = 22_050
FEATURE_FPS = 20.0
FEATURE_HOP = round(FEATURE_SAMPLE_RATE / FEATURE_FPS)
FEATURE_N_FFT = 2_048


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def installed_version(package: str) -> str:
    try:
        return version(package)
    except PackageNotFoundError:
        return "unknown"


def robust_normalize(values: Any, active_mask: Any | None = None) -> list[float]:
    """Percentile-scale a curve while retaining silence as exact zero."""
    import numpy as np

    array = np.asarray(values, dtype=np.float64)
    finite = np.isfinite(array)
    active = finite & (array > 0)
    if active_mask is not None:
        active &= np.asarray(active_mask, dtype=bool)
    if not np.any(active):
        return [0.0] * int(array.size)

    low, high = np.percentile(array[active], [2.0, 98.0])
    if not math.isfinite(float(high - low)) or high - low <= max(1e-12, abs(float(high)) * 1e-9):
        normalized = np.zeros_like(array)
        normalized[active] = 0.5
    else:
        normalized = np.clip((array - low) / (high - low), 0.0, 1.0)
        normalized[~finite] = 0.0
    normalized[~active] = 0.0
    return [round(float(item), 6) for item in normalized]


def select_device(torch: Any, requested: str) -> str:
    if requested == "cpu":
        return "cpu"
    if requested == "mps":
        if not (hasattr(torch.backends, "mps") and torch.backends.mps.is_available()):
            raise RuntimeError("MPS was requested, but this PyTorch build cannot use Apple MPS.")
        return "mps"
    if hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
        return "mps"
    return "cpu"


def run_beat_tracker(audio_path: Path, requested_device: str) -> tuple[list[float], list[float], str]:
    import torch
    from beat_this.inference import File2Beats

    device = select_device(torch, requested_device)

    def infer(selected_device: str) -> tuple[list[float], list[float]]:
        tracker = File2Beats(checkpoint_path=CHECKPOINT, device=selected_device, dbn=False)
        beats, downbeats = tracker(str(audio_path))
        return ([float(value) for value in beats], [float(value) for value in downbeats])

    try:
        beats, downbeats = infer(device)
        return beats, downbeats, device
    except Exception as error:
        if device != "mps" or requested_device == "mps":
            raise
        logging.warning("MPS inference failed (%s); retrying with CPU.", error)
        beats, downbeats = infer("cpu")
        return beats, downbeats, "cpu"


def analyze_features(audio_path: Path) -> tuple[float, int, int, dict[str, Any]]:
    import librosa
    import numpy as np

    audio, sample_rate = librosa.load(str(audio_path), sr=FEATURE_SAMPLE_RATE, mono=True)
    if audio.size == 0:
        raise ValueError("The selected audio file contains no decodable audio samples.")
    duration = float(audio.size / sample_rate)

    rms = librosa.feature.rms(
        y=audio, frame_length=FEATURE_N_FFT, hop_length=FEATURE_HOP, center=True
    )[0]
    centroid = librosa.feature.spectral_centroid(
        y=audio, sr=sample_rate, n_fft=FEATURE_N_FFT, hop_length=FEATURE_HOP, center=True
    )[0]
    onset = librosa.onset.onset_strength(
        y=audio, sr=sample_rate, n_fft=FEATURE_N_FFT, hop_length=FEATURE_HOP, center=True
    )

    frame_count = min(rms.size, centroid.size, onset.size)
    rms = rms[:frame_count]
    centroid = centroid[:frame_count]
    onset = onset[:frame_count]
    times = librosa.frames_to_time(
        np.arange(frame_count), sr=sample_rate, hop_length=FEATURE_HOP
    )
    active = rms > max(float(np.max(rms)) * 1e-5, 1e-8)
    return duration, sample_rate, FEATURE_HOP, {
        "frameRate": round(sample_rate / FEATURE_HOP, 6),
        "times": [round(float(value), 4) for value in times],
        "rms": robust_normalize(rms, active),
        "brightness": robust_normalize(centroid, active),
        "onsetStrength": robust_normalize(onset, active),
        "normalization": "per-track p2-p98 linear scaling; silent frames remain zero",
    }


def valid_times(values: Any, duration: float, label: str) -> list[float]:
    result = [float(value) for value in values if math.isfinite(float(value))]
    # Events at the exact file-end boundary are padding artifacts, not audible beats.
    result = sorted(set(round(value, 6) for value in result if 0 <= value < duration))
    if any(right <= left for left, right in zip(result, result[1:])):
        raise ValueError(f"{label} timestamps are not strictly ordered.")
    return result


def make_analysis(audio_path: Path, digest: str, requested_device: str) -> dict[str, Any]:
    import librosa
    import numpy as np

    duration, sample_rate, hop_length, features = analyze_features(audio_path)
    raw_beats, raw_downbeats, device = run_beat_tracker(audio_path, requested_device)
    beats = valid_times(raw_beats, duration, "Beat")
    downbeats = valid_times(raw_downbeats, duration, "Downbeat")

    # Estimate local tempo directly from each observed interval. No meter or
    # constant-tempo grid is inferred or imposed.
    tempo_estimates = [
        {
            "timeSeconds": round((left + right) / 2, 6),
            "bpm": round(60.0 / (right - left), 3),
        }
        for left, right in zip(beats, beats[1:])
        if right > left
    ]
    return {
        "schemaVersion": SCHEMA_VERSION,
        "audio": {
            "fileName": audio_path.name,
            "sha256": digest,
            "durationSeconds": round(duration, 6),
            "analysisSampleRate": sample_rate,
        },
        "analysis": {
            "createdAt": datetime.now(timezone.utc).isoformat(),
            "settingsVersion": ANALYSIS_SETTINGS_VERSION,
            "model": MODEL_NAME,
            "checkpoint": CHECKPOINT,
            "requestedDevice": requested_device,
            "beatThisVersion": installed_version("beat-this"),
            "device": device,
            "librosaVersion": librosa.__version__,
            "numpyVersion": np.__version__,
            "beatPostprocessor": "Beat This! minimal (no DBN)",
            "featureHopLength": hop_length,
            "featureFftSize": FEATURE_N_FFT,
            "featureSampleRate": FEATURE_SAMPLE_RATE,
            "featureFrameRate": features["frameRate"],
            "normalization": features["normalization"],
        },
        "beats": beats,
        "downbeats": downbeats,
        "tempoEstimates": tempo_estimates,
        "features": {
            "times": features["times"],
            "rms": features["rms"],
            "brightness": features["brightness"],
            "onsetStrength": features["onsetStrength"],
        },
    }


def validate_analysis(data: dict[str, Any]) -> None:
    duration = float(data["audio"]["durationSeconds"])
    if data.get("schemaVersion") != SCHEMA_VERSION:
        raise ValueError("Unexpected analysis schema version.")
    for key in ("beats", "downbeats"):
        values = data[key]
        if values != sorted(set(values)) or any(not math.isfinite(t) or t < 0 or t > duration for t in values):
            raise ValueError(f"{key} must be ordered and within the track duration.")
    tempo = data["tempoEstimates"]
    tempo_times = [item["timeSeconds"] for item in tempo]
    if (
        tempo_times != sorted(set(tempo_times))
        or any(not 0 <= item["timeSeconds"] <= duration or not math.isfinite(item["bpm"]) or item["bpm"] <= 0 for item in tempo)
    ):
        raise ValueError("Tempo estimates must be ordered, positive, and within the track duration.")
    curves = data["features"]
    times = curves["times"]
    if times != sorted(set(times)) or any(t < 0 or t > duration for t in times):
        raise ValueError("Feature timestamps must be ordered and within the track duration.")
    for key in ("rms", "brightness", "onsetStrength"):
        if len(curves[key]) != len(times) or any(not 0 <= value <= 1 for value in curves[key]):
            raise ValueError(f"Feature curve {key} is malformed.")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("audio", type=Path, help="Local audio file to analyze; never uploaded.")
    parser.add_argument("-o", "--output", type=Path, help="Optional copy destination for the JSON analysis.")
    parser.add_argument("--device", choices=("auto", "mps", "cpu"), default="auto")
    parser.add_argument("--force", action="store_true", help="Recompute even if a matching cached analysis exists.")
    args = parser.parse_args()

    audio_path = args.audio.expanduser().resolve()
    if not audio_path.is_file():
        parser.error(f"audio file does not exist: {audio_path}")
    digest = sha256_file(audio_path)
    import torch

    preferred_device = select_device(torch, args.device)
    cache_path = Path(__file__).resolve().parent / "cache" / f"{digest}.json"
    cache_path.parent.mkdir(parents=True, exist_ok=True)

    cached: dict[str, Any] | None = None
    if cache_path.exists() and not args.force:
        try:
            candidate = json.loads(cache_path.read_text(encoding="utf-8"))
            cache_analysis = candidate.get("analysis", {})
            if (
                candidate.get("schemaVersion") == SCHEMA_VERSION
                and candidate.get("audio", {}).get("sha256") == digest
                and cache_analysis.get("model") == MODEL_NAME
                and cache_analysis.get("checkpoint") == CHECKPOINT
                and cache_analysis.get("settingsVersion") == ANALYSIS_SETTINGS_VERSION
                and cache_analysis.get("beatThisVersion") == installed_version("beat-this")
                and cache_analysis.get("librosaVersion") == installed_version("librosa")
                and cache_analysis.get("numpyVersion") == installed_version("numpy")
                and cache_analysis.get("requestedDevice") == args.device
                and cache_analysis.get("device") == preferred_device
                and cache_analysis.get("featureSampleRate") == FEATURE_SAMPLE_RATE
                and cache_analysis.get("featureHopLength") == FEATURE_HOP
                and cache_analysis.get("featureFftSize") == FEATURE_N_FFT
            ):
                validate_analysis(candidate)
                cached = candidate
        except (OSError, ValueError, TypeError, KeyError, json.JSONDecodeError):
            cached = None

    if cached is not None:
        data = cached
        print(f"Using cached analysis: {cache_path}")
    else:
        data = make_analysis(audio_path, digest, args.device)
        validate_analysis(data)
        cache_path.write_text(json.dumps(data, separators=(",", ":")), encoding="utf-8")

    destination = args.output.expanduser().resolve() if args.output else cache_path
    if destination != cache_path:
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_text(json.dumps(data, indent=2), encoding="utf-8")
    print(f"Saved: {destination}")
    print(
        f"{len(data['beats'])} beats, {len(data['downbeats'])} downbeats, "
        f"duration {data['audio']['durationSeconds']:.2f}s, "
        f"device {data['analysis']['device']}"
    )
    return 0


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")
    try:
        raise SystemExit(main())
    except (ImportError, ModuleNotFoundError) as error:
        print(
            f"Missing analysis dependency: {error}. Activate backend/.venv and install backend/requirements.txt.",
            file=sys.stderr,
        )
        raise SystemExit(2)
    except Exception as error:
        print(f"Audio analysis failed: {error}", file=sys.stderr)
        raise SystemExit(1)
