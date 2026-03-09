// server/index.ts
import 'dotenv/config';
import express from 'express';
import { createServer } from 'http';
import { Server, Socket } from 'socket.io';
import { v4 as uuidv4 } from 'uuid';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { createHash } from 'crypto';
import { readFileSync, writeFileSync, existsSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const IS_DEV = process.env.NODE_ENV !== 'production';

function debugLog(...args: any[]) {
  if (IS_DEV) console.log('[WorldLabs]', ...args);
}

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

app.use(express.json());

// Serve static files from dist
app.use(express.static(join(__dirname, '../dist')));

// ── World Labs API Proxy + Cache ────────────────────────────────────

const WORLDLABS_API = 'https://api.worldlabs.ai/marble/v1';
const CACHE_PATH = join(__dirname, 'worldlabs-cache.json');

interface CacheEntry {
  worldId: string;
  spzUrl: string;
  colliderMeshUrl?: string;
  timestamp: number;
}

function readCache(): Record<string, CacheEntry> {
  if (!existsSync(CACHE_PATH)) return {};
  try {
    return JSON.parse(readFileSync(CACHE_PATH, 'utf-8'));
  } catch {
    return {};
  }
}

function writeCache(cache: Record<string, CacheEntry>): void {
  writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2));
}

function hashKey(imageUrl: string): string {
  return createHash('sha256').update(imageUrl).digest('hex');
}

// Check cache without triggering generation
app.post('/api/worldlabs/check-cache', (req, res) => {
  const { imageUrl } = req.body;
  if (!imageUrl) {
    res.status(400).json({ error: 'imageUrl is required' });
    return;
  }

  const key = hashKey(imageUrl);
  const cache = readCache();

  if (cache[key]) {
    debugLog('Cache HIT for', imageUrl);
    res.json({ cached: true, ...cache[key], status: 'done' });
  } else {
    debugLog('Cache MISS for', imageUrl);
    res.json({ cached: false });
  }
});

app.post('/api/worldlabs/generate', async (req, res) => {
  const { imageUrl, name } = req.body;
  if (!imageUrl) {
    res.status(400).json({ error: 'imageUrl is required' });
    return;
  }

  const key = hashKey(imageUrl);
  const cache = readCache();

  // Return cached result if available
  if (cache[key]) {
    debugLog('Generate → cache HIT, returning immediately');
    res.json({ ...cache[key], fromCache: true, status: 'done' });
    return;
  }

  const apiKey = process.env.WORLDLABS_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: 'WORLDLABS_API_KEY not configured' });
    return;
  }

  try {
    // Build the image_prompt — if imageUrl is a local path (starts with /),
    // read from public/ and send as base64. Otherwise use it as a URI.
    let imagePrompt: Record<string, any>;
    if (imageUrl.startsWith('/')) {
      const localPath = join(__dirname, '../public', imageUrl);
      if (!existsSync(localPath)) {
        res.status(400).json({ error: `Local image not found: ${imageUrl}` });
        return;
      }
      const imageBuffer = readFileSync(localPath);
      const base64 = imageBuffer.toString('base64');
      const ext = imageUrl.split('.').pop() || 'jpg';
      imagePrompt = {
        source: 'data_base64',
        data_base64: base64,
        extension: ext,
      };
      debugLog(`Generate → read local image ${localPath} (${imageBuffer.length} bytes → base64)`);
    } else {
      imagePrompt = {
        source: 'uri',
        uri: imageUrl,
      };
    }

    // WorldsGenerateRequest per API spec
    const requestBody = {
      world_prompt: {
        type: 'image',
        image_prompt: imagePrompt,
      },
      display_name: name || 'Untitled',
      model: 'Marble 0.1-mini',
    };

    debugLog('Generate → POST /worlds:generate', JSON.stringify({
      ...requestBody,
      world_prompt: {
        ...requestBody.world_prompt,
        image_prompt: { ...imagePrompt, data_base64: imagePrompt.data_base64 ? `[${imagePrompt.data_base64.length} chars]` : undefined },
      },
    }));

    const response = await fetch(`${WORLDLABS_API}/worlds:generate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'WLT-Api-Key': apiKey,
      },
      body: JSON.stringify(requestBody),
    });

    const responseText = await response.text();
    debugLog('Generate → response status:', response.status);
    debugLog('Generate → response body:', responseText);

    if (!response.ok) {
      res.status(response.status).json({ error: responseText });
      return;
    }

    // GenerateWorldResponse: { operation_id, done, created_at, ... }
    const data = JSON.parse(responseText);
    const operationId = data.operation_id;
    const startedAt = Date.now();

    debugLog('Generate → operation_id:', operationId);

    res.json({
      operationId,
      status: 'generating',
      startedAt,
      estimatedDurationMs: 60_000, // ~1 minute for Marble 0.1-mini
    });
  } catch (err: any) {
    debugLog('Generate → ERROR:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/worldlabs/status/:operationId', async (req, res) => {
  const apiKey = process.env.WORLDLABS_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: 'WORLDLABS_API_KEY not configured' });
    return;
  }

  debugLog('Status → GET /operations/' + req.params.operationId);

  try {
    const response = await fetch(`${WORLDLABS_API}/operations/${req.params.operationId}`, {
      headers: { 'WLT-Api-Key': apiKey },
    });

    const responseText = await response.text();
    debugLog('Status → response status:', response.status);
    debugLog('Status → response body:', responseText);

    if (!response.ok) {
      res.status(response.status).json({ error: responseText });
      return;
    }

    const data = JSON.parse(responseText);

    if (data.done && data.response) {
      // GetOperationResponse[World] — response is a World object
      const world = data.response;

      // Extract SPZ URL from assets.splats.spz_urls (dict of resolution → URL)
      let spzUrl = '';
      if (world.assets?.splats?.spz_urls) {
        const urls = world.assets.splats.spz_urls;
        // Prefer 'default' key, otherwise take the first available
        spzUrl = urls['default'] || urls[Object.keys(urls)[0]] || '';
      }

      const colliderMeshUrl = world.assets?.mesh?.collider_mesh_url || undefined;

      const result: CacheEntry = {
        worldId: world.world_id || req.params.operationId,
        spzUrl,
        colliderMeshUrl,
        timestamp: Date.now(),
      };

      debugLog('Status → DONE!');
      debugLog('Status → world_id:', result.worldId);
      debugLog('Status → spz_urls:', JSON.stringify(world.assets?.splats?.spz_urls));
      debugLog('Status → selected spzUrl:', result.spzUrl);
      debugLog('Status → colliderMeshUrl:', result.colliderMeshUrl);

      // Cache the result — use the imageUrl hash stored in metadata if available
      const cache = readCache();
      // The metadata from World Labs may contain the world_id; we store under
      // the operationId as a fallback key so the client can cache by imageUrl later
      cache[`op:${req.params.operationId}`] = result;
      writeCache(cache);
      debugLog('Status → cached under operation_id');

      res.json({ ...result, fromCache: false, status: 'done' });
    } else if (data.done && data.error) {
      debugLog('Status → FAILED!', JSON.stringify(data.error));
      res.status(500).json({
        status: 'failed',
        error: data.error.message || 'World generation failed',
      });
    } else {
      debugLog('Status → still generating, progress:', data.metadata?.progress || 'unknown');
      res.json({
        status: 'generating',
        progress: data.metadata?.progress || null,
      });
    }
  } catch (err: any) {
    debugLog('Status → ERROR:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Allow the client to notify the server about what imageUrl maps to a result
app.post('/api/worldlabs/cache', async (req, res) => {
  const { imageUrl, result } = req.body;
  if (!imageUrl || !result) {
    res.status(400).json({ error: 'imageUrl and result are required' });
    return;
  }
  const cache = readCache();
  cache[hashKey(imageUrl)] = { ...result, timestamp: Date.now() };
  writeCache(cache);
  debugLog('Cache → stored result for', imageUrl);
  res.json({ success: true });
});

// Handle all other routes by serving index.html
app.get(/.*/, (req, res) => {
  res.sendFile(join(__dirname, '../dist/index.html'));
});

interface Room {
  id: string;
  ownerId: string;
  users: Map<string, UserState>;
  photos: PhotoState[];
  annotations: Annotation[];
}

interface UserState {
  id: string;
  username: string;
  position: { x: number; y: number; z: number };
  rotation: { x: number; y: number; z: number; w: number };
}

interface PhotoState {
  frameIndex: number;
  photoUrl: string;
  photoId: string;
}

interface Annotation {
  id: string;
  userId: string;
  position: { x: number; y: number; z: number };
  text: string;
  color: string;
  timestamp: number;
}

const rooms = new Map<string, Room>();

// Word list for generating passphrases
const words = [
  'puppy', 'cola', 'ocean', 'tiger', 'moon', 'star', 'cloud', 'river',
  'apple', 'banana', 'cherry', 'dragon', 'eagle', 'falcon', 'guitar',
  'piano', 'rocket', 'sunset', 'thunder', 'violet', 'wizard', 'yellow',
  'anchor', 'breeze', 'coral', 'delta', 'ember', 'frost', 'glacier',
  'harbor', 'island', 'jungle', 'karma', 'lemon', 'maple', 'noble',
  'opal', 'panda', 'quartz', 'ruby', 'silver', 'topaz', 'ultra',
  'velvet', 'walnut', 'xenon', 'yonder', 'zephyr', 'amber', 'blade',
  'crystal', 'dune', 'echo', 'flame', 'gold', 'halo', 'iris', 'jade'
];

// Generate a random 2-word passphrase
function generatePassphrase(): string {
  const word1 = words[Math.floor(Math.random() * words.length)];
  const word2 = words[Math.floor(Math.random() * words.length)];
  return `${word1}-${word2}`;
}

// Generate invite link
function generateInviteLink(roomId: string): string {
  return `${process.env.BASE_URL || 'https://localhost:8081'}?room=${roomId}`;
}

io.on('connection', (socket: Socket) => {
  console.log('User connected:', socket.id);
  let currentRoomId: string | null = null;
  let userId: string = socket.id;

  // Create a new room
  socket.on('createRoom', (data: { username: string }, callback) => {
    const roomId = generatePassphrase();
    const room: Room = {
      id: roomId,
      ownerId: userId,
      users: new Map(),
      photos: [],
      annotations: []
    };

    room.users.set(userId, {
      id: userId,
      username: data.username,
      position: { x: 0, y: 1.6, z: 0 },
      rotation: { x: 0, y: 0, z: 0, w: 1 }
    });

    rooms.set(roomId, room);
    socket.join(roomId);
    currentRoomId = roomId;

    callback({
      success: true,
      roomId,
      inviteLink: generateInviteLink(roomId),
      userId
    });
  });

  // Join existing room
  socket.on('joinRoom', (data: { roomId: string; username: string }, callback) => {
    const room = rooms.get(data.roomId);

    if (!room) {
      callback({ success: false, error: 'Room not found' });
      return;
    }

    room.users.set(userId, {
      id: userId,
      username: data.username,
      position: { x: 0, y: 1.6, z: 0 },
      rotation: { x: 0, y: 0, z: 0, w: 1 }
    });

    socket.join(data.roomId);
    currentRoomId = data.roomId;

    // Notify others
    socket.to(data.roomId).emit('userJoined', {
      userId,
      username: data.username
    });

    callback({
      success: true,
      roomId: data.roomId,
      userId,
      currentUsers: Array.from(room.users.values()),
      photos: room.photos,
      annotations: room.annotations
    });
  });

  // Update user position
  socket.on('updatePosition', (data: {
    position: { x: number; y: number; z: number };
    rotation: { x: number; y: number; z: number; w: number };
  }) => {
    if (!currentRoomId) return;

    const room = rooms.get(currentRoomId);
    if (!room) return;

    const user = room.users.get(userId);
    if (user) {
      user.position = data.position;
      user.rotation = data.rotation;

      socket.to(currentRoomId).emit('userMoved', {
        userId,
        position: data.position,
        rotation: data.rotation
      });
    }
  });

  // Sync photos
  socket.on('updatePhotos', (photos: PhotoState[]) => {
    if (!currentRoomId) return;

    const room = rooms.get(currentRoomId);
    if (room) {
      room.photos = photos;
      socket.to(currentRoomId).emit('photosUpdated', photos);
    }
  });

  // Add annotation
  socket.on('addAnnotation', (annotation: Omit<Annotation, 'id' | 'timestamp'>) => {
    if (!currentRoomId) return;

    const room = rooms.get(currentRoomId);
    if (room) {
      const newAnnotation: Annotation = {
        ...annotation,
        id: uuidv4(),
        timestamp: Date.now()
      };

      room.annotations.push(newAnnotation);
      io.to(currentRoomId).emit('annotationAdded', newAnnotation);
    }
  });

  // Relay voice notes to other users in the room
  socket.on('addVoiceNote', (data: { position: { x: number; y: number; z: number }; audioData: ArrayBuffer }) => {
    if (!currentRoomId) return;
    socket.to(currentRoomId).emit('voiceNoteAdded', data);
  });

  // Handle disconnect
  socket.on('disconnect', () => {
    if (currentRoomId) {
      const room = rooms.get(currentRoomId);
      if (room) {
        room.users.delete(userId);
        io.to(currentRoomId).emit('userLeft', { userId });

        // Clean up empty rooms
        if (room.users.size === 0) {
          rooms.delete(currentRoomId);
        }
      }
    }
  });
});

const PORT = process.env.PORT || 3001;
httpServer.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  if (IS_DEV) console.log('World Labs debug logging ENABLED');
});
