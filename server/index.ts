// server/index.ts
import express from 'express';
import { createServer } from 'http';
import { Server, Socket } from 'socket.io';
import { v4 as uuidv4 } from 'uuid';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Serve static files from dist
app.use(express.static(join(__dirname, '../dist')));

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
});