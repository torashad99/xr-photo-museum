# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development Commands

```bash
# Start Vite dev server (HTTPS, port 8081, proxies /socket.io to backend)
npm run dev

# Start Socket.IO backend server (port 3001, hot-reloads via tsx --watch)
npm run server

# Both must run simultaneously for multiplayer features to work

# Production build
npm run build

# Production server (serves dist/ + Socket.IO)
npm run start
```

There are no tests or linting configured in this project.

## Architecture

**XR multiplayer photo gallery** built with Meta's IWSDK (Immersive Web SDK) + Three.js (`super-three`) + Socket.IO.

### Client (`src/`)

- **`index.ts`** — `PhotoMuseumApp` class. Initializes `World`, wires up multiplayer callbacks, hooks per-frame logic by wrapping `world.update()`. Monkey-patches `navigator.xr` to inject `'microphone'` into `optionalFeatures` before `World.create()`.
- **`components/`** — Scene building blocks (MuseumRoom, PhotoFrame, Annotation, VoiceNote, Drawing, CreativeInputSystem). CreativeInputSystem reads XR controller/hand input each frame: left hand = voice recording, right hand = 3D drawing.
- **`services/`** — MultiplayerService (Socket.IO client wrapper with callback-based event system), GoogleAuth + PhotosService (Google Photos OAuth).

### Server (`server/index.ts`)

Express + Socket.IO. Manages rooms (passphrase-based IDs), relays user positions, photos, annotations, drawings, and voice notes. In production, also serves `dist/`.

### Key IWSDK Constraints

- **Render loop**: `World.create()` sets up `renderer.setAnimationLoop()`. In WebXR this uses `XRSession.requestAnimationFrame`. Never create a separate `requestAnimationFrame` loop — it stops firing during XR sessions on Quest Browser. Hook custom logic by wrapping `world.update()`.
- **XR input**: Access via `world.input.gamepads.{left,right}` (controllers) and `world.input.visualAdapters.hand.{left,right}` (hand tracking). Use `InputComponent` enum from `@iwsdk/xr-input`.
- **Emulator (IWER)**: Only activates on localhost (`activation: "localhost"`). Real Quest Browser uses native WebXR.
- **`window.prompt()`/`alert()`/`confirm()`**: Unreliable in Quest Browser VR mode. Avoid them.
- **Sprites vs Meshes for labels**: Use `THREE.Mesh` (PlaneGeometry) with Y-axis-only rotation for text labels, not `THREE.Sprite` (which does full spherical billboarding and tilts with head).

### Networking

Vite dev server proxies `/socket.io` to `localhost:3001`. The Socket.IO client connects with default `io()` (same origin). Room IDs are two-word passphrases (e.g., `tiger-moon`). Invite links use `?room=<passphrase>` query param.

### Compact Instructions
Before any /compact or when context exceeds 80%, summarize the current task status, key decisions, and any 'gotchas' into a progress.md file or project memory.

### Do not use Git Worktrees. Keep in one branch.