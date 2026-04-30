# Photo to World - Immersive WebXR Photo Museum

An immersive multiplayer WebXR photo gallery built with Meta's [IWSDK](https://iwsdk.dev/), [Three.js](https://threejs.org/), [SparkJS](https://sparkjs.dev/), and Socket.io, with Gaussian Splats powered by [World Labs](https://worldlabs.ai/). Explore galleries with friends in VR, upload photos, and transform them into interactive Gaussian Splat worlds.

**Landing Page:** https://papaya-longma-d02e97.netlify.app/

---

## Features

### 🖼️ Gallery System
- **18 customizable photo frame slots** — add, remove, and arrange photos in your virtual gallery
- **Multiplayer synchronization** — see frame changes across all connected users in real-time
- **Portal frames** — click "Enter World" to transform 2D photos into immersive 3D Gaussian Splat environments

### 📸 Photo Sources
- **Google Photos integration** — OAuth login and browse your Google Photos library
- **Local file upload** — drag-and-drop or select images from your device (25 MB limit)
- **Gaussian Splat generation** — World Labs Marble API converts photos into interactive 3D splats

### 🎨 Creative Tools
- **Annotations** — add text labels and comments to photos
- **3D Drawing** — draw freehand strokes in 3D space using hand tracking or controllers
- **Voice Notes** — record audio annotations (requires microphone access in XR)

### 🌍 Multiplayer
- **Shared rooms** — two-word passphrase system (e.g., `tiger-moon`) for easy invites
- **Real-time updates** — user positions, annotations, drawings, and voice notes sync across players
- **Link mode** — lock the server to a single room for persistent shared experiences

### 🥽 Platform Support
- **Meta Quest 3/3S** — full WebXR support with controllers and hand tracking
- **PC VR** — compatible with SteamVR and other WebXR-capable headsets
- **Mobile/Desktop fallback** — Minecraft PE-style flat mode with screen-drag look controls

---

## Requirements

- **Node.js** ≥ 24.11.1
- **npm** (comes with Node.js)
- **SSL/TLS** (localhost certificate via mkcert, auto-generated during first run)
- **Optional**: Meta Quest device or VR-capable browser for XR features

---

## Local Deployment

### 1. Install Dependencies

```bash
npm install
```

### 2. Run Development Environment

Open **two terminal windows** and start the **backend first**, then the frontend:

**Terminal 1 — Backend (Socket.IO + Express) [START THIS FIRST]**
```bash
npm run server
```
- Server on `http://localhost:3001`
- Hot-reloads via `tsx --watch`
- Handles photo uploads, World Labs API proxy, and multiplayer rooms
- Wait for "Server running on port 3001" message before starting frontend

**Terminal 2 — Frontend (Vite dev server) [START AFTER BACKEND]**
```bash
npm run dev
```
- HTTPS server on `https://localhost:8081`
- Hot module reloading enabled
- Proxies `/socket.io` to `http://localhost:3001`

> **Note**: If you see `ECONNRESET` or connection errors, try stopping both processes (Ctrl+C) and running them again in order.

### 3. Open in Browser

Navigate to **`https://localhost:8081`** in a WebXR-capable browser:
- **Meta Quest Browser** — native WebXR support
- **Chrome/Edge on desktop** — with emulator (IWER)
- **Mobile browsers** — fallback to flat mode (screen-drag controls)

### 4. Request an XR Session

Click the "Enter XR" button in the UI to start a VR session. On Quest, this will launch the immersive experience.

---

## Production Build

### Build for Deployment

```bash
npm run build
```

Generates optimized bundles in `dist/`.

### Serve Production Build Locally

```bash
npm run start
```

- Serves both static files (`dist/`) and Socket.IO on `http://localhost:3000`
- Ready for deployment to any Node.js hosting platform

---

## Advanced Configuration

### Lock to a Single Room (Link Mode)

Use `LINK_ROOM` environment variable to restrict the server to one passphrase:

```bash
# Via environment variable
LINK_ROOM=demo npm run server

# Via command-line flag
npm run server -- -link demo
```

Creates a `.link-room` marker file and always serves the same room across sessions.

---

## Architecture Overview

### Frontend (`src/`)
- **`index.ts`** — Main app, IWSDK world initialization, multiplayer sync
- **`components/`** — MuseumRoom, PhotoFrame, Annotation, Drawing, CreativeInputSystem, PortalFrame, GaussianSplatWorld
- **`services/`** — MultiplayerService (Socket.IO), GoogleAuthService, WorldLabsService

### Backend (`server/`)
- **Express + Socket.IO** — Multiplayer room management and real-time sync
- **World Labs proxy** — Converts photos to Gaussian Splats
- **Upload handler** — Local image storage under `/uploads/`

### Tech Stack
- **Framework**: Meta IWSDK (0.3.0) + Three.js (super-three 0.181)
- **Build**: Vite + TypeScript
- **Backend**: Express.js + Socket.IO
- **3D Rendering**: SparkJS (Gaussian Splat viewer)
- **UI**: UIKit (bundled with IWSDK)

---

## Troubleshooting

### "Can not resolve #include <splatDefines>" Error
The Three.js instance is duplicated. Make sure both dev and server are running, and Vite's Three.js dedup plugin is active.

### WebXR Session Not Starting
- Ensure HTTPS is enabled (mkcert certificate on localhost)
- Check browser console for permission errors
- On mobile/desktop, verify WebXR support or use flat mode

### Photos Not Appearing
- Confirm backend is running (`npm run server`)
- Check upload file size (25 MB limit)
- Verify Google Photos OAuth credentials are valid

### Multiplayer Not Syncing
- Both users must be in the same room (same passphrase)
- Check browser console for Socket.IO connection errors
- Ensure firewall allows WebSocket connections on port 3001

---

## Deployment

The app is production-ready and can be deployed to:
- **Vercel** — frontend + serverless functions for backend
- **Heroku/Railway** — Node.js hosting with Socket.IO support
- **AWS/Google Cloud** — custom Node.js server deployment

Example production environment variables:
```env
GOOGLE_CLIENT_ID=your-client-id
GOOGLE_CLIENT_SECRET=your-client-secret
WORLD_LABS_API_KEY=your-api-key
NODE_ENV=production
```

---

Developed by Mohammed Rashad, using Meta IWSDK, Three.js, SparkJS, and Socket.IO. Gaussian Splats powered by World Labs.
