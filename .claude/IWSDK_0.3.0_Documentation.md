# IWSDK 0.3.0 - Complete Documentation

**Last Updated:** 2026-03-11

This is a comprehensive guide to the Immersive Web SDK (IWSDK) version 0.3.0, Meta's complete WebXR development framework built on Three.js.

---

## Table of Contents

1. [Overview](#overview)
2. [Entity Component System (ECS)](#entity-component-system-ecs)
3. [Spatial UI](#spatial-ui)
4. [Project Setup](#project-setup)
5. [Three.js Basics](#threejs-basics)
6. [Working in 3D](#working-in-3d)
7. [Custom Systems](#custom-systems)
8. [External Assets](#external-assets)

---

## Overview

### What is IWSDK?

The Immersive Web SDK makes building immersive web experiences as approachable as traditional web development. It's a complete collection of frameworks and tools that eliminates the steep learning curve and months of setup traditionally required for WebXR development.

### Breaking Down Barriers

Historically, creating immersive web experiences meant wrestling with complex 3D math, building interaction systems from scratch, and navigating fragmented WebXR APIs. IWSDK changes this by providing a complete foundation that handles the complexity for you.

### Three Core Pillars

#### Modern Architecture
- Built on Three.js (most popular JavaScript 3D library)
- High-performance Entity-Component-System (ECS) pattern
- Scales from simple prototypes to complex applications

#### Developer-First Workflow
- One-command setup (get running in under a minute)
- Visual scene composition with Meta Spatial Editor
- HTML-syntax spatial UI authoring
- Automated asset optimization
- Built-in emulation (develop without VR equipment)

#### Production-Ready Systems
- Grab interactions
- Locomotion systems
- Spatial audio
- Physics integration
- Scene understanding
- These systems work seamlessly together

### What You Get

- **ECS Runtime** — High-performance Entity-Component-System pattern built on Three.js
- **XR Input** — Controller and hand tracking with automatic input visualization
- **Locomotion** — Teleport, slide, and turn systems with comfort features
- **Grab Interactions** — One-hand, two-hand, and distance grabbing out of the box
- **Spatial Audio** — 3D positional audio with automatic distance and directional effects
- **Physics** — Havok physics engine running in web workers for smooth performance
- **Scene Understanding** — Automatic AR plane/mesh detection with persistent anchoring
- **Spatial UI** — UIKit integration with HTML-like authoring for 3D interfaces
- **Asset Pipeline** — Automatic optimization and smart dependency management
- **Developer Tools** — Emulation runtime, visual editors, and debugging utilities

### Same Code, Two Experiences

Your IWSDK applications run immersively in VR/AR headsets and automatically provide mouse-and-keyboard emulation on desktop browsers. No browser extensions or special setup required.

---

## Entity Component System (ECS)

### The ECS Mental Model

IWSDK's ECS is powered by the elics runtime with WebXR, Three.js, and convenient helpers layered on top.

**Core Principles:**
- **Data over inheritance**: Components are small, flat data definitions (no behavior). Attach them to Entities.
- **Behavior is in Systems**: Systems query for entities with specific components, then update them each frame.
- **Composition wins**: Build features by composing components on entities, not by subclassing.
- **Columnar memory**: Each component field stored in a packed array for cache-friendly iteration.

### How IWSDK Extends ECS

- **World** coordinates Three.js rendering, WebXR session, input rig, asset loading, and the ECS scheduler
- **Entities** can carry `object3D` and a synced `Transform` when created via `createTransformEntity()`
- **Systems** run with XR-aware priorities (input/locomotion first, visuals after) before the renderer draws
- **Built-in components/systems** for Transform, Visibility, Input, UI, Audio, Levels, etc.

### Key Concepts Overview

**Core Architecture:**

- **World**: Coordinator between ECS data, Three.js rendering, WebXR session, and assets. Owns the render loop and system priorities.
- **Entity**: Lightweight container that can hold components, be created/destroyed, parented (scene vs level), and optionally carry a 3D `object3D`.
- **Component**: Typed, packed data schemas with no behavior. Think database columns — each field stored in efficient arrays.
- **System**: Pure behavior that processes entities via queries. Runs each frame in priority order.

**Advanced Concepts:**

- **Queries**: Live, efficient sets of entities that update automatically as components change. Support complex filtering with value predicates.
- **Lifecycle**: Understand when things happen — world boot sequence, system initialization, per-frame execution order, and cleanup.
- **Patterns & Tips**: Proven composition patterns, performance optimizations, and debugging techniques.

### Quick Start: A Complete Feature (~40 lines)

Implement a simple "Regeneration" feature: if an entity has `Health`, replenish it gradually.

```typescript
import {
  World,
  Types,
  createComponent,
  createSystem,
  Entity,
} from '@iwsdk/core';

// 1) Data
export const Health = createComponent('Health', {
  current: { type: Types.Float32, default: 100 },
  max: { type: Types.Float32, default: 100 },
});

// 2) Behavior
export class HealthRegenSystem extends createSystem(
  { withHealth: { required: [Health] } },
  { regenPerSecond: { type: Types.Float32, default: 5 } },
) {
  init() {
    this.config.regenPerSecond.subscribe((v) => console.log('Regen now', v));
  }
  update(dt: number) {
    for (const e of this.queries.withHealth.entities) {
      const cur = e.getValue(Health, 'current')!;
      const max = e.getValue(Health, 'max')!;
      if (cur < max)
        e.setValue(
          Health,
          'current',
          Math.min(max, cur + dt * this.config.regenPerSecond.peek()),
        );
    }
  }
}

// 3) Running in a world
const container = document.getElementById('scene') as HTMLDivElement;
const world = await World.create(container);
world.registerComponent(Health);
world.registerSystem(HealthRegenSystem);

const player = world.createTransformEntity();
player.addComponent(Health, { current: 25, max: 100 });
```

### Data Flow Each Frame

```
Input → Core logic systems → Feature systems → UI/Render systems → Renderer
        (higher priority ↖ earlier; more negative = earlier)
```

### Memory Model (Columnar Storage)

```
Health.current: [100, 25, 80, ...]
Health.max:     [100, 100, 150, ...]
               entity 0  1    2
```

### ECS vs OOP

- Add features by adding components, not by subclassing deep hierarchies
- Multiple orthogonal features coexist on the same entity without inheritance diamonds

### Creating Entities

Entities are created from the world. In IWSDK they can also carry a Three.js object (`object3D`) and a built-in `Transform` component:

```typescript
// Persistent entity (parented under the scene) with an Object3D
const hud = world.createTransformEntity();

// Level-scoped entity (parented under active level) with an existing object
import { Object3D } from '@iwsdk/core';
const mesh = new Object3D();
const gltfEntity = world.createTransformEntity(mesh);
```

Add/remove components at any time:

```typescript
gltfEntity.addComponent(Health, { current: 50, max: 150 });
gltfEntity.removeComponent(Health);
```

Get or set component values inside systems:

```typescript
const hp = e.getValue(Health, 'current');
e.setValue(Health, 'current', hp! - 10);
```

### Components: Typed Schemas (No Behavior)

Components declare fields using `Types.*`, defaults, and optional enums:

```typescript
import { Types, createComponent } from '@iwsdk/core';

export const DamageOverTime = createComponent('DamageOverTime', {
  dps: { type: Types.Float32, default: 10 },
  duration: { type: Types.Float32, default: 3 },
});
```

### Systems: Queries + Lifecycle + Config Signals

Use `createSystem(queries, schema)` to define:

- `queries`: Named sets with `required` (and optionally `excluded`) components
- `schema`: System config options; each key becomes a reactive `Signal` at `this.config.<key>`

```typescript
export class DamageSystem extends createSystem(
  {
    ticking: { required: [Health, DamageOverTime] },
  },
  {
    tickRate: { type: Types.Float32, default: 10 },
  },
) {
  private timeAcc = 0;

  init() {
    this.queries.ticking.subscribe('qualify', (e) =>
      console.log('Damage starts', e.index),
    );
  }

  update(dt: number) {
    this.timeAcc += dt;
    const step = 1 / this.config.tickRate.peek();
    while (this.timeAcc >= step) {
      this.timeAcc -= step;
      for (const e of this.queries.ticking.entities) {
        const dps = e.getValue(DamageOverTime, 'dps')!;
        const cur = e.getValue(Health, 'current')!;
        e.setValue(Health, 'current', Math.max(0, cur - dps * step));
      }
    }
  }
}
```

**Common Lifecycle Hooks:**

- `init()` — Set up event handlers, one-time wiring, load assets
- `update(delta, time)` — Per-frame logic; prefer iterating `this.queries.<name>.entities`
- `destroy()` — Clean up handlers and disposables

### Queries: Thinking in Sets

Queries are declarative filters defined once; the ECS keeps their membership up-to-date:

```typescript
export class HUDSystem extends createSystem({
  panels: { required: [PanelUI], excluded: [ScreenSpace] },
}) {
  init() {
    this.queries.panels.subscribe('qualify', (e) =>
      console.log('panel ready', e.index),
    );
  }
}
```

Filter by values using predicates:

```typescript
import { lt, isin } from '@iwsdk/core';

export class DangerHUD extends createSystem({
  lowHealth: { required: [Health], where: [lt(Health, 'current', 30)] },
  status: {
    required: [Status],
    where: [isin(Status, 'phase', ['combat', 'boss'])],
  },
}) {
  /* … */
}
```

### Config and Signals: Runtime Tuning

System config values are reactive signals. Update them on the fly:

```typescript
const damage = world.registerSystem(DamageSystem);
damage.config.tickRate.value = 20;
```

If you need a reactive vector view from a component field, use `getVectorView`:

```typescript
const v = e.getVectorView(Transform, 'position'); // Float32Array view
v[0] += 1; // move +X
```

### World: The Runtime Container

```typescript
import { World, SessionMode } from '@iwsdk/core';

const container = document.getElementById('scene') as HTMLDivElement;
const world = await World.create(container, {
  xr: { sessionMode: SessionMode.ImmersiveVR },
  features: { enableLocomotion: true, enableGrabbing: true },
  level: '/glxf/Composition.glxf',
});
```

**Useful World Helpers:**

- `createTransformEntity(object?, parentOrOptions?)` — Create an entity plus `object3D`
- `getActiveRoot()` / `getPersistentRoot()` — Use for attaching Three.js nodes
- `loadLevel(url)` — Request a GLXF level; LevelSystem performs the work

---

## Spatial UI

### Why Spatial UI Is Tricky

Building usable, high-performance UI inside a 3D/WebXR app is deceptively hard.

**Two Traditional Approaches:**

1. **HTML → canvas → texture**
   - Pros: Familiar authoring, existing web tooling, great accessibility
   - Cons: Expensive rendering, tricky animation, input forwarding difficult

2. **Native 3D UI (meshes, SDF text, custom layout)**
   - Pros: Excellent runtime performance, flexible animations
   - Cons: Higher learning curve, custom authoring model, more boilerplate

### IWSDK's Approach: Best of Both Worlds

IWSDK combines strengths of both camps:

- **UIKit (Camp 2 execution, web-standard layout)**
  - Native 3D UI runtime with MSDF text and batched/instanced panels
  - Uses Yoga (Flexbox) for predictable, web-aligned layout semantics

- **UIKitML (Familiar authoring)**
  - HTML/CSS-like DSL
  - Parser turns `.uikitml` into compact JSON format
  - Interpreter builds UIKit component trees at runtime

- **Vite Plugin (Zero-friction compilation)**
  - Watches `ui/*.uikitml` files in dev
  - Compiles to `public/ui/*.json`
  - Runs once in production builds

- **SDK Runtime (Seamless consumption)**
  - Core UI systems fetch JSON, interpret into live UIKit components
  - Pointer events connected for ray/grab/hand input
  - Components surfaced through `UIKitDocument` with DOM-like APIs

### Why This Matters for XR

- **Performance budgets**: XR requires sustained frame rates (72–120 Hz), often in stereo
- **Readability and scale**: UI must remain crisp at various distances and angles
- **Input parity**: Controllers and hands interact via rays and near-touch
- **Sorting and transparency**: UI is often translucent and stacked
- **Authoring vs runtime**: Developers want HTML/CSS; engines want batched meshes

### When to Use Spatial UI in IWSDK

- Spatial panels in world space with XR pointers and grabs
- Heads-up or HUD-style overlays
- UI that needs to animate smoothly at XR frame rates

### Choosing an Approach

**Prefer Spatial UI when:**
- Panels exist in world space, can be grabbed, or are part of 3D interactions
- Need fine-grained animation, shader effects, or deep scene integration
- Want deterministic sizing in meters and crisp text at any distance

**Prefer DOM overlays when:**
- Only need 2D menus outside XR
- Development velocity matters more than in-XR fidelity
- Accessibility/SEO or web widgets are primary concerns

**Hybrid:** Use DOM overlays for non-XR flows and Spatial UI once VR/AR starts

### Common Pitfalls & Anti-Patterns

- Avoid updating canvas textures every frame for large UIs — performance will tank
- Don't put gameplay logic inside visual `update()` calls; use pointer events and ECS systems
- Don't hard-code pixel sizes for world-space panels; use meters via `UIKitDocument.setTargetDimensions()`

---

## Project Setup

### Prerequisites

- Node.js version 20.19.0 or higher
- Modern web browser (Chrome, Edge, Firefox, or Safari)
- Basic familiarity with command line/terminal
- Basic JavaScript/TypeScript knowledge
- Optional: WebXR-compatible headset for testing

### Creating Your First Project

```bash
npm create @iwsdk@latest
```

This interactive generator guides you through setup.

### Setup Questions

#### Project Name
Used for your project folder and `package.json`.

#### Language Choice
- **TypeScript** (Recommended): Type safety, better IDE support, catches errors early
- **JavaScript**: Simpler setup, good for quick prototypes

#### Experience Type
- **Virtual Reality**: Fully immersive virtual environment
- **Augmented Reality**: Overlays digital content on real world

#### WebXR Features

Each feature has three options: No, Optional, Required

**For VR:**
- Enable Hand Tracking?
- Enable WebXR Layers?

**For AR (additional):**
- Enable Hand Tracking?
- Enable Anchors?
- Enable Hit Test?
- Enable Plane Detection?
- Enable Mesh Detection?
- Enable WebXR Layers?

#### Core Features

**Locomotion (VR only):**
- Allows users to move around in virtual world
- Choose Yes to include teleport, smooth movement, turning
- Can run on Worker for better performance

**Scene Understanding (AR only):**
- Helps AR app understand the real world
- Yes: Surfaces, objects, spatial anchors
- No: Basic AR

**Grabbing (both):**
- Allows users to pick up and manipulate objects
- Includes one-handed, two-handed, distance grabbing

**Physics Simulation:**
- Realistic object behavior (gravity, collisions)
- Default: No (adds complexity)

#### Meta Spatial Editor Integration
- Choose **No** to start simple (learn through code)
- Explore later for visual scene composition

#### Development Setup

**Git Repository:**
- Recommended: **Yes** for version control

**Install Dependencies:**
- Recommended: **Yes** to auto-run `npm install`

### Project Structure Overview

```
my-iwsdk-app/
├── src/
│   ├── index.ts         # Application entry point
│   ├── robot.ts         # Example component and system
│   └── panel.ts         # UI interaction system
├── ui/
│   └── welcome.uikitml  # Spatial UI markup
├── public/
│   ├── audio/           # Audio files
│   ├── gltf/            # 3D models and textures
│   ├── textures/        # Standalone textures
│   └── ui/              # Compiled UI (auto-generated)
├── package.json
├── tsconfig.json
├── vite.config.ts
└── index.html
```

### Key Files Explained

- **`src/index.ts`**: Where your application starts. Creates ECS world, loads assets, spawns entities, registers systems.
- **`src/robot.ts` & `src/panel.ts`**: Example custom components and systems showing interactive behaviors.
- **`ui/welcome.uikitml`**: Spatial UI markup compiled to JSON for the 3D interface panel.
- **`public/gltf/`**: Organized 3D models with textures in subfolders.
- **`public/audio/`**: Audio files for sound effects and spatial audio.
- **`vite.config.ts`**: Build configuration with IWSDK-specific plugins.

---

## Three.js Basics

### The Mental Model: Two Connected Worlds

**ECS World (Data):**
```
Entity 12
├─ Transform { pos: [1,2,3] }
├─ Health { current: 75 }
└─ Mesh { geometry: 'box' }
```

**Three.js World (Visuals):**
```
Object3D
├─ position: Vector3(1,2,3)
└─ Mesh
    ├─ BoxGeometry
    └─ MeshStandardMaterial
```

**Key Insight:** ECS stores the **data** (what things are), Three.js handles the **rendering** (how things look). IWSDK automatically syncs them.

### What IWSDK Manages vs What You Control

**IWSDK Handles Automatically:**
- `WebGLRenderer` creation and WebXR setup
- `Scene` and `PerspectiveCamera` initialization
- Render loop (`renderer.setAnimationLoop`)
- Transform synchronization between ECS ↔ Three.js
- Default lighting and PMREM
- Input raycasting and XR session management

**You Focus On:**
- Creating entities with `world.createTransformEntity()`
- Attaching meshes, geometries, and materials to `entity.object3D`
- Writing ECS systems to animate and control behavior
- Understanding 3D math for rotations, positioning, and scaling

### Coordinate System & Units

IWSDK uses Three.js's **right-handed coordinate system**:

- **+X**: Right
- **+Y**: Up
- **+Z**: Forward (toward viewer)
- **Units**: Meters (aligned with WebXR's physical scale)

```
        +Y (up)
         |
         |
         |
    ---- 0 ---- +X (right)
        /
       /
    +Z (forward)
```

### Core Three.js Concepts

Every 3D object is composed of four essential parts:

1. **Geometry**: The shape/structure (cube, sphere, plane)
2. **Material**: Surface properties (color, texture, lighting)
3. **Mesh**: Combination of geometry + material
4. **Object3D**: Base class providing position, rotation, scale

---

## Working in 3D

### Three.js Fundamentals

#### Geometry: Defining Shape

**BoxGeometry** - For cubes and rectangular shapes:
```javascript
new BoxGeometry(1, 1, 1);           // Perfect cube
new BoxGeometry(2, 0.5, 1);         // Rectangular box
```

**SphereGeometry** - For balls and rounded objects:
```javascript
new SphereGeometry(1, 32, 32);      // Simple sphere
new SphereGeometry(1, 16, 16);      // Lower detail
```

**CylinderGeometry** - For tubes, cans, and cones:
```javascript
new CylinderGeometry(1, 1, 2, 32);  // Cylinder
new CylinderGeometry(0, 1, 2, 32);  // Cone
```

**PlaneGeometry** - For flat surfaces:
```javascript
new PlaneGeometry(2, 2);            // Square plane
new PlaneGeometry(4, 2);            // Rectangular plane
```

#### Material

**MeshBasicMaterial** - Flat colors, no lighting:
```javascript
new MeshBasicMaterial({ color: 0xff0000 });
new MeshBasicMaterial({ color: 'red' });
new MeshBasicMaterial({ color: '#ff0000' });
```

**MeshStandardMaterial** - Realistic lighting:
```javascript
new MeshStandardMaterial({
  color: 0x0066cc,
  roughness: 0.5,      // 0 = mirror, 1 = rough
  metalness: 0.2,      // 0 = non-metal, 1 = metal
});
```

#### Mesh

Combines geometry and material:
```javascript
import { Mesh } from 'three';

const cube = new Mesh(cubeGeometry, redMaterial);
const sphere = new Mesh(sphereGeometry, blueMaterial);
```

### Creating Objects in IWSDK

The most straightforward way is to create a Three.js mesh, then create a transform entity from it:

```javascript
import { World, Mesh, BoxGeometry, MeshStandardMaterial } from '@iwsdk/core';

// Create the Three.js mesh
const mesh = new Mesh(
  new BoxGeometry(1, 1, 1),
  new MeshStandardMaterial({ color: 0xff6666 }),
);

// Position the mesh
mesh.position.set(0, 1, -2);

// Create a transform entity from the mesh
const entity = world.createTransformEntity(mesh);
```

### Positioning, Rotating, and Scaling Objects

**Before creating entity:**
```javascript
mesh.position.set(2, 0, -3);        // 2 right, 0 up, 3 away
mesh.rotation.y = Math.PI / 2;      // 90 degrees around Y-axis
mesh.scale.set(2, 2, 2);            // Double size
```

**After creating entity:**
```javascript
entity.object3D.position.x = 1;     // Move 1 unit right
entity.object3D.position.y = 2;     // Move 2 units up
entity.object3D.position.z = -5;    // Move 5 units away

// Quaternion for precise rotation
entity.object3D.quaternion.setFromEuler(new Euler(0, Math.PI, 0));

// Scale individual axes
entity.object3D.scale.set(1, 0.5, 1);  // Half height
```

### Rotation: Degrees to Radians

Three.js uses radians. Conversion: `radians = degrees * (Math.PI / 180)`

**Common conversions:**
- 90° = π/2
- 180° = π
- 270° = 3π/2
- 360° = 2π

### Building Your First Scene

Example: Add primitive objects to your scene:

```javascript
import {
  Mesh,
  BoxGeometry,
  SphereGeometry,
  PlaneGeometry,
  MeshStandardMaterial,
} from '@iwsdk/core';

World.create(/* ... */).then((world) => {
  // Red cube
  const cubeGeometry = new BoxGeometry(1, 1, 1);
  const redMaterial = new MeshStandardMaterial({ color: 0xff3333 });
  const cube = new Mesh(cubeGeometry, redMaterial);
  cube.position.set(-1, 0, -2);
  const cubeEntity = world.createTransformEntity(cube);

  // Green sphere
  const sphereGeometry = new SphereGeometry(0.5, 32, 32);
  const greenMaterial = new MeshStandardMaterial({ color: 0x33ff33 });
  const sphere = new Mesh(sphereGeometry, greenMaterial);
  sphere.position.set(1, 0, -2);
  const sphereEntity = world.createTransformEntity(sphere);

  // Blue floor plane
  const floorGeometry = new PlaneGeometry(4, 4);
  const blueMaterial = new MeshStandardMaterial({ color: 0x3333ff });
  const floor = new Mesh(floorGeometry, blueMaterial);
  floor.position.set(0, -1, -2);
  floor.rotation.x = -Math.PI / 2;  // Rotate to horizontal
  const floorEntity = world.createTransformEntity(floor);
});
```

---

## Custom Systems

### Creating a Component

Components are data containers using `createComponent`:

#### Component Schema Types

| Type | Description |
|------|-------------|
| `Types.Int8`, `Types.Int16` | Integer numbers |
| `Types.Float32`, `Types.Float64` | Floating point numbers |
| `Types.Boolean` | true/false values |
| `Types.String` | Text strings |
| `Types.Vec2` | 2D vectors [x, y] |
| `Types.Vec3` | 3D vectors [x, y, z] |
| `Types.Vec4` | 4D vectors [x, y, z, w] |
| `Types.Color` | RGBA colors [r, g, b, a] |
| `Types.Entity` | References to other entities |
| `Types.Object` | Any JavaScript object |
| `Types.Enum` | String values from defined set |

#### Component Examples

**Tag Component** (no data, just tags entities):
```typescript
import { createComponent } from '@iwsdk/core';

export const Robot = createComponent('Robot', {});
```

**Data Component** (stores information):
```typescript
import { createComponent, Types } from '@iwsdk/core';

export const Health = createComponent('Health', {
  current: { type: Types.Float32, default: 100 },
  max: { type: Types.Float32, default: 100 },
  regenerating: { type: Types.Boolean, default: false },
});

export const Position = createComponent('Position', {
  velocity: { type: Types.Vec3, default: [0, 0, 0] },
  target: { type: Types.Vec3, default: [0, 0, 0] },
});
```

### Creating a System

Systems contain logic that operates on entities with specific components:

#### System Structure

```typescript
import { createSystem, eq, Types } from '@iwsdk/core';

export class MySystem extends createSystem(
  {
    // Regular query
    myQuery: { required: [ComponentA, ComponentB] },

    // Query with exclusion
    specialQuery: { required: [ComponentA], excluded: [ComponentC] },

    // Query with value predicate
    configQuery: {
      required: [PanelUI, PanelDocument],
      where: [eq(PanelUI, 'config', '/ui/welcome.json')],
    },
  },
  {
    // Optional config schema
    speed: { type: Types.Float32, default: 1.0 },
    enabled: { type: Types.Boolean, default: true },
  },
) {
  // System implementation
}
```

#### Accessing Queries and Config

```typescript
// Access entities in update() or init()
this.queries.myQuery.entities.forEach((entity) => {
  // Process each entity
});

// React to entities entering/leaving queries
this.queries.welcomePanel.subscribe('qualify', (entity) => {
  // Called when entity newly matches query
});

this.queries.welcomePanel.subscribe('disqualify', (entity) => {
  // Called when entity stops matching query
});

// Access config values
const currentSpeed = this.config.speed.value;
const isEnabled = this.config.enabled.value;

// React to config changes
this.config.speed.subscribe((value) => {
  console.log('Speed changed to:', value);
});
```

#### System Lifecycle Methods

**`init()`** - Called once when the system is registered:
```typescript
init() {
  // Initialize reusable objects
  this.tempVector = new Vector3();

  // Set up reactive subscriptions
  this.queries.myQuery.subscribe('qualify', (entity) => {
    // Called when an entity newly matches
  });
}
```

**`update(delta: number, time: number)`** - Called every frame:
```typescript
update(delta, time) {
  // delta: Time since last frame (in seconds)
  // time: Total elapsed time since start (in seconds)

  this.queries.myQuery.entities.forEach((entity) => {
    const position = entity.getComponent(Position);
    position.velocity[0] *= delta;  // Frame-rate independent
  });
}
```

**`destroy()`** - Called when the system is unregistered:
```typescript
destroy() {
  // Clean up resources, remove listeners, etc.
  this.tempVector = null;
}
```

#### System Properties

- `this.queries`: Access to defined queries and their entities
- `this.config`: Access to system configuration values
- `this.world`: Reference to the ECS world
- `this.player`: Reference to XR player/camera rig
- `this.camera`: Reference to the camera
- `isPaused`: Whether the system is currently paused

### Registering with World

```typescript
// Register components first
world
  .registerComponent(Robot)
  .registerComponent(Health)
  .registerComponent(Position);

// Then register systems
world.registerSystem(RobotSystem).registerSystem(HealthSystem, {
  priority: -1,               // Lower numbers run first
  configData: { speed: 2.0 }, // Override defaults
});
```

### System Priorities

Systems run in priority order each frame. Lower numbers run first. Values smaller than 0 are reserved for IWSDK systems. Generally choose numbers larger than 0 for custom systems.

### The Robot Example

Complete implementation showing ECS patterns:

```typescript
import {
  AudioUtils,
  createComponent,
  createSystem,
  Pressed,
  Vector3,
} from '@iwsdk/core';

// 1. Tag component
export const Robot = createComponent('Robot', {});

// 2. System with two queries
export class RobotSystem extends createSystem({
  robot: { required: [Robot] },           // All robots
  robotClicked: { required: [Robot, Pressed] }, // Clicked robots
}) {
  private lookAtTarget;
  private vec3;

  // 3. init() - called when system is registered
  init() {
    this.lookAtTarget = new Vector3();
    this.vec3 = new Vector3();

    // Subscribe to click events
    this.queries.robotClicked.subscribe('qualify', (entity) => {
      AudioUtils.play(entity);
    });
  }

  // 4. update() - called every frame
  update() {
    this.queries.robot.entities.forEach((entity) => {
      // Get player head position
      this.player.head.getWorldPosition(this.lookAtTarget);

      // Get robot's position
      const spinnerObject = entity.object3D;
      spinnerObject.getWorldPosition(this.vec3);

      // Keep robots level
      this.lookAtTarget.y = this.vec3.y;

      // Face the player
      spinnerObject.lookAt(this.lookAtTarget);
    });
  }
}
```

**Key Patterns Demonstrated:**
- Performance optimization: Reusable Vector3 objects in `init()`
- Direct Three.js access: `entity.object3D` bridges ECS and rendering
- Event-driven behavior: `subscribe('qualify', ...)` for reactive audio
- Frame-rate independent motion

---

## External Assets

### Why External Assets Matter

External assets transform your experience from basic shapes to rich, detailed environments:

- **3D Models**: Detailed objects from Blender, Maya, asset stores
- **Textures**: Images providing surface detail and material properties
- **Audio**: Sound effects and ambient audio for immersion
- **HDR Images**: Environment maps for realistic lighting and reflections

### IWSDK's Asset Manager

AssetManager handles loading, caching, and optimization:

- **Preloading**: Load assets during initialization
- **Caching**: Avoid reloading the same asset multiple times
- **Loading Priorities**: Control whether assets are critical or background
- **Static Access**: Simple API to retrieve loaded assets anywhere

#### Asset Loading Priorities

**Critical**: Load before application starts - blocks `World.create()` until loaded
- Use for assets essential to core experience (main characters, UI, core environment)

**Background**: Load early but don't block initialization
- Use for assets needed but not critical (decorative objects, optional audio)
- Starts loading after critical assets finish
- Cached and ready when needed; avoids runtime stutters

**Runtime loading**: For user-specific or conditional content
- Load on-demand using `AssetManager.loadGLTF()` or similar

### Setting Up Asset Loading

#### Asset Manifest Structure

```javascript
import { AssetManifest, AssetType, World } from '@iwsdk/core';

const assets: AssetManifest = {
  robot: {
    url: '/gltf/robot/robot.gltf',
    type: AssetType.GLTF,
    priority: 'critical',
  },
  webxr: {
    url: '/textures/webxr.png',
    type: AssetType.Texture,
    priority: 'critical',
  },
  chimeSound: {
    url: '/audio/chime.mp3',
    type: AssetType.Audio,
    priority: 'background',
  },
};

World.create(document.getElementById('scene-container'), {
  assets,
  // ... other options
}).then((world) => {
  // Assets are now loaded and available
});
```

#### Supported Asset Types

- `AssetType.GLTF`: 3D models (GLB or GLTF format)
- `AssetType.Texture`: Images (JPG, PNG, WebP)
- `AssetType.HDRTexture`: HDR environment maps
- `AssetType.Audio`: Audio files (MP3, WAV, OGG)

#### Asset Organization

Place assets in `public/` directory:

- `/gltf/` for 3D models
- `/textures/` for images
- `/audio/` for sound files
- `/hdr/` for environment maps

### Loading and Using GLTF Models

GLTF (GL Transmission Format) is the standard format for 3D models in WebXR.

#### Basic GLTF Loading

```javascript
import { AssetManager } from '@iwsdk/core';

// In your asset manifest
const assets = {
  myRobot: {
    url: '/gltf/robot.glb',
    type: AssetType.GLTF,
    priority: 'critical',
  },
};

// After World.create()
World.create(/* ... */).then((world) => {
  const { scene: robotMesh } = AssetManager.getGLTF('myRobot');

  robotMesh.position.set(0, 1, -3);
  robotMesh.scale.setScalar(0.5);

  const robotEntity = world.createTransformEntity(robotMesh);
});
```

#### Why GLTF?

GLTF is the official 3D format for IWSDK because:

- **Web-optimized**: Efficient loading and parsing in browsers
- **Compact**: Binary GLB format reduces file sizes significantly
- **Complete**: Supports geometry, materials, textures, animations, lighting
- **Industry standard**: Backed by Khronos Group, supported by all major tools
- **WebXR ready**: Perfect for immersive experiences

**Converting Other Formats:**

If working with FBX, OBJ, or 3DS Max files, use Blender (free and open-source):
1. Import your model into Blender
2. Export as GLTF or GLB

#### GLTF Optimization

- Use GLB format for smaller file sizes
- Optimize geometry in 3D software (remove unnecessary vertices, combine meshes)
- Keep polygon counts reasonable for game-ready models

### Working with Textures

Textures add surface detail to 3D objects.

#### Basic Texture Loading

```javascript
import {
  MeshBasicMaterial,
  PlaneGeometry,
  Mesh,
  SRGBColorSpace,
} from '@iwsdk/core';

// In your asset manifest
const assets = {
  webxr: {
    url: '/textures/webxr.png',
    type: AssetType.Texture,
    priority: 'critical',
  },
};

// After World.create()
World.create(/* ... */).then((world) => {
  const webxrTexture = AssetManager.getTexture('webxr');

  // Set proper color space
  webxrTexture.colorSpace = SRGBColorSpace;

  // Create material using texture
  const logoMaterial = new MeshBasicMaterial({
    map: webxrTexture,
    transparent: true,
  });

  // Create plane for texture
  const logoGeometry = new PlaneGeometry(1.13, 0.32);
  const logoPlane = new Mesh(logoGeometry, logoMaterial);
  logoPlane.position.set(0, 1.8, -1.9);

  const logoEntity = world.createTransformEntity(logoPlane);
});
```

#### Texture Optimization

- Choose the right format: JPG for photos, PNG for transparency
- Use power-of-2 dimensions: 512×512, 1024×1024, 2048×2048
- Keep file sizes reasonable to impact loading and performance

#### Asset Availability

Use `if` checks when accessing assets with 'background' priority (might still be loading). Critical assets are guaranteed to be available.

### Runtime Asset Loading

Load assets dynamically after app starts:

```javascript
AssetManager.loadGLTF('/gltf/dynamic-object.glb', 'dynamicModel')
  .then(() => {
    const { scene: dynamicMesh } = AssetManager.getGLTF('dynamicModel');
    dynamicMesh.position.set(0, 2, -3);
    const entity = world.createTransformEntity(dynamicMesh);
  })
  .catch((error) => {
    console.error('Failed to load dynamic asset:', error);
  });
```

---

## Development Commands

```bash
# Start Vite dev server (HTTPS, port 8081, proxies /socket.io to backend)
npm run dev

# Start Socket.IO backend server (port 3001, hot-reloads via tsx --watch)
npm run server

# Both must run simultaneously for multiplayer features

# Production build
npm run build

# Production server (serves dist/ + Socket.IO)
npm run start
```

---

## Key Resources

- **Main Documentation**: https://iwsdk.dev/
- **Meta Developers**: https://developers.meta.com/horizon/documentation/web/iwsdk-overview/
- **GitHub Repository**: https://github.com/facebook/immersive-web-sdk
- **Create Project**: `npm create @iwsdk@latest`

---

**Documentation Version**: IWSDK 0.3.0
**Last Updated**: March 11, 2026
