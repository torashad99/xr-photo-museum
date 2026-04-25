# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development Commands

```bash
# Vite dev server (HTTPS via mkcert, port 8081, proxies /socket.io to :3001)
npm run dev

# Socket.IO + Express backend (port 3001, hot-reloads via tsx --watch)
npm run server

# Lock server to a single named room (link mode, "demo" could be anything)
LINK_ROOM=demo npm run server        # env var
npm run server -- -link demo         # explicit flag

# Production build + serve (serves dist/ and Socket.IO on same origin)
npm run build
npm run start
```

Both `dev` and `server` must run simultaneously for multiplayer. There are no tests or linting configured.

## Architecture

**XR multiplayer photo gallery** built with Meta's IWSDK (`@iwsdk/core` 0.3.0) + Three.js (`super-three` 0.181, aliased as `three`) + Socket.IO + SparkJS Gaussian Splats. Node ≥ 20.19.

### Client (`src/`)

- **`index.ts`** — `PhotoMuseumApp` class (~1500 lines). Initializes `World`, wires up multiplayer callbacks, hooks per-frame logic by wrapping `world.update()`. Monkey-patches `navigator.xr.requestSession`/`offerSession` to inject `'microphone'` into `optionalFeatures` before `World.create()`. Manages 18 photo frame slots (slot 0 = legacy hardcoded, 1–17 = generalized splat pipeline).
- **`components/`**:
  - `MuseumRoom`, `PhotoFrame`, `SlotPlusMarker` — gallery scene + frame slots with `+` add buttons
  - `Annotation`, `VoiceNote`, `Drawing` — user-created content (text, audio, 3D strokes)
  - `CreativeInputSystem` — per-frame XR input: left hand = voice recording, right hand = 3D drawing
  - `InputHelpers` — shared XR input utilities
  - `PortalFrame`, `PortalUI` — parallax-shader portal frame + "Enter World" button per slot
  - `GaussianSplatWorld`, `BoundaryGuard` — splat scene + free-fly thumbstick controls + "Go Back to Gallery" boundary
  - `PhotoPicker`, `SplatAdjustPanel`, `TrashConfirmDialog` — UI panels (UIKit)
  - `FlatModeOverlay` — mobile/desktop fallback (Minecraft PE-style: drag-look + on-screen up/down buttons)
- **`services/`**:
  - `MultiplayerService` — Socket.IO client wrapper with callback-based event system
  - `GoogleAuthService`, `GooglePhotosService` — Google Photos OAuth + Picker API
  - `LocalPhotoPicker` — local file upload via `/api/upload`
  - `WorldLabsService` — polls `/api/worldlabs/*` server endpoints (proxy to World Labs Marble API)

### Server (`server/index.ts`, ~750 lines)

Express + Socket.IO. In production also serves `dist/` and `public/uploads/`.

**HTTP endpoints:**
- `POST /api/upload` — local image upload (25 MB limit) → returns URL under `/uploads/`
- `POST /api/worldlabs/check-cache`, `/generate`, `/cache`, `/cache/delete` and `GET /status/:operationId` — World Labs Marble splat generation proxy. Cached by image-URL hash in `server/worldlabs-cache.json`
- `GET /api/link-room` — returns the locked room name when `LINK_ROOM` is set (file marker at `.link-room`)
- `GET /*` — SPA fallback to `index.html`

**Socket.IO:** rooms identified by two-word passphrases (e.g., `tiger-moon`). Relays user positions, photos, annotations, drawings, voice notes, and per-slot `PortalWorldRecord`s. Invite links use `?room=<passphrase>` query param.

## Vite Config (`vite.config.ts`)

- HTTPS via `vite-plugin-mkcert`, port 8081
- Proxies `/socket.io` → `http://localhost:3001`
- IWSDK plugins: `@iwsdk/vite-plugin-dev`, `vite-plugin-gltf-optimizer`, `vite-plugin-uikitml`
- **Three.js dedup plugin** (custom) + `resolve.alias` + `resolve.dedupe` — REQUIRED so SparkJS sees the same Three.js instance that IWSDK bundles internally. Without dedup: shader error `"Can not resolve #include <splatDefines>"`.

## Key IWSDK Constraints

- **Render loop**: `World.create()` sets up `renderer.setAnimationLoop()`. In WebXR this uses `XRSession.requestAnimationFrame`. Never create a separate `requestAnimationFrame` loop — it stops firing during XR sessions on Quest Browser. Hook custom logic by wrapping `world.update()` or registering an ECS System via `createSystem()`.
- **XR input**: Access via `world.input.gamepads.{left,right}` (controllers) and `world.input.visualAdapters.hand.{left,right}` (hand tracking). Use `InputComponent` enum from `@iwsdk/xr-input` (peer dep, bundled with `@iwsdk/core`, not in `package.json`).
- **Emulator (IWER)**: Only activates on localhost (`activation: "localhost"`). Real Quest Browser uses native WebXR.
- **`window.prompt()`/`alert()`/`confirm()`**: Unreliable in Quest Browser VR mode. Avoid them — use UIKit panels (`PhotoPicker`, `TrashConfirmDialog`, etc.) instead.
- **Sprites vs Meshes for labels**: Use `THREE.Mesh` (PlaneGeometry) with Y-axis-only rotation for text labels, not `THREE.Sprite` (full spherical billboarding tilts with head).
- **Microphone feature**: `XRFeatureOptions` doesn't include microphone — must monkey-patch `navigator.xr` before `World.create()` (already done in `src/index.ts`).
- **SpeechRecognition**: Quest Browser's is unreliable with `continuous: true`; use single-shot + manual restart in `onend`.

## SparkJS / Gaussian Splat Integration

- `@sparkjsdev/spark` v2.0.0-preview installed from GitHub (NOT npm registry)
- `SparkRenderer` must be initialized with `world.renderer` and added to scene
- **Camera clone patch** is REQUIRED: IWSDK camera has UIKitDocument children that crash SparkJS LoD `driveLod()`. Override `cam.clone()` to return a plain `PerspectiveCamera` with only projection/transform data. (Implemented in `GaussianSplatWorld`.)
- Reference: `github.com/V4C38/sensai-webxr-worldmodels`

## Flat Mode (Mobile/Desktop Fallback)

When WebXR is unavailable (`navigator.xr` missing or session denied), `FlatModeOverlay` activates:
- Screen-drag look at 0.003 rad/pixel (yaw + pitch on the camera)
- Up/down on-screen buttons for vertical movement in splat world
- Default camera height in splat world: 0.5 m (Minecraft PE feel)

## Compact Instructions
Before any /compact or when context exceeds 80%, summarize the current task status, key decisions, and any 'gotchas' into a progress.md file or project memory.

## Do not use Git Worktrees. Keep in one branch.
