# Local audio analysis

The analyzer runs locally. Audio files are read from disk, never uploaded. Beat This! downloads its pretrained `final0` checkpoint (about 78 MB) on the first analysis; subsequent runs use the local checkpoint cache. The Beat This! code and published model weights are MIT-licensed. No training is performed.

## Environment

This project uses Python 3.12 and the exact dependency lock in `requirements-lock.txt`.

```sh
python3.12 -m venv backend/.venv
backend/.venv/bin/python -m pip install -r backend/requirements-lock.txt
```

The selected PyTorch build includes Apple MPS support. The analyzer chooses MPS when PyTorch reports it available and retries on CPU if MPS inference fails. It uses CPU directly when MPS is unavailable. Compressed formats such as MP3 or M4A may need FFmpeg installed for local decoding; WAV is the most portable input. On macOS, install FFmpeg with `brew install ffmpeg` if a compressed file fails to decode.

## Analyze from the website

After setting up the Python environment below, start the frontend normally with `npm run dev` from `frontend/`. That command starts the loopback-only local analysis service alongside Vite. In the website, load an audio file, open **Audio Analysis**, and choose **Analyze song locally**. The app automatically receives and attaches the matching analysis. The uploaded bytes are sent only to `127.0.0.1` on this computer; no external server receives the song. Analyses are cached by content hash under `backend/cache/`.

## Optional command-line analysis

```sh
backend/.venv/bin/python backend/analyze_audio.py "/path/to/your-song.wav"
```

The first run writes `backend/cache/<audio-sha256>.json`; identical audio reuses that analysis. The cache is ignored by Git. To also write a copy at a known location for the UI:

```sh
backend/.venv/bin/python backend/analyze_audio.py "/path/to/your-song.wav" -o frontend/public/analysis/your-song.json
```

To recompute, pass `--force`. To choose a device explicitly, pass `--device cpu`, `--device mps`, or leave the default `--device auto`.

The development timeline supports seeking; diagnostic beat/downbeat clicks are optional and off by default.
