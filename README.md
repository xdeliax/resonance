# RESONANCE
Sound given form.

FNMS Independent Technical Project | Delia Ivascu

## Concept
Resonance turns music into living, interactive art. From a minimalist, editorial launch screen, visitors search for a song and enter a fullscreen artwork inspired by its cover and sound. The visuals respond to the music and the visitor’s movements, creating an experience for a laptop or projected exhibition.

## Experience
Type a song into a chat-style search box, select the matching track, and enter its artwork. Song information and cover imagery load automatically; visitors do not upload files. The canvas combines minimal playback controls with camera-based movement tracking, allowing visitors to interact with and reshape the artwork through their gestures.

The initial prototype will feature a curated catalog of 10–20 songs with accompanying artwork, searchable directly from the launch screen. Custom model training may be explored as a future extension.

## AI and graphics
Pretrained MediaPipe models detect body or hand movements. Three.js graphics turn music, cover imagery and movement into flowing visual forms in real time. Model training is an optional, possible addition to this project, later on.

## Research question
How does running movement tracking locally versus on a remote server affect responsiveness, visual smoothness and network usage?

## Architectures
- Local: the laptop handles movement tracking and graphics.
- Remote: a server processes camera frames and returns movement coordinates; graphics remain on the laptop.

Local tracking avoids network delays but uses laptop resources. Remote tracking moves some computation elsewhere but adds communication delay. Build the local version first, then compare both.

## Stack
- React + TypeScript + Vite: launch screen and interface.
- Three.js + GLSL: live graphics.
- Web Audio API: audio analysis for the cleared demo tracks.
- MediaPipe: body or hand tracking.
- Python + FastAPI + WebSocket: remote tracking and communication.

## Evaluation
Compare both versions using the same recorded movement, music and visual settings across repeated runs. Measure response delay, rendering smoothness and network traffic.

