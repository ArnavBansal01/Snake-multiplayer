import express from "express";
import { createServer as createViteServer } from "vite";
import { createServer } from "http";
import { Server } from "socket.io";
import os from "os";

// --- Shared Constants (must match client) ---
const WORLD_SIZE = 3000;
const FOOD_COUNT = 150;
const RECORD_DIST = 4;
const SEGMENT_SPACING_IDX = 6;
const BASE_SPEED = 300; // HARD difficulty for multiplayer
const TURN_SPEED = 5.5;
const SPEED_INC = 0.8;
const TICK_RATE = 20; // ticks per second
const TICK_MS = 1000 / TICK_RATE;

const FOOD_COLORS = ["#facc15", "#06b6d4", "#f43f5e", "#3b82f6", "#a855f7", "#4ade80"];
const SNAKE_COLORS = [
  { head: "#4ade80", body: "#22c55e", glow: "#4ade8040" },
  { head: "#06b6d4", body: "#0891b2", glow: "#06b6d440" },
  { head: "#f43f5e", body: "#e11d48", glow: "#f43f5e40" },
  { head: "#a855f7", body: "#9333ea", glow: "#a855f740" },
  { head: "#facc15", body: "#eab308", glow: "#facc1540" },
  { head: "#ff8a00", body: "#ea580c", glow: "#ff8a0040" },
];

// --- Types ---
interface Point { x: number; y: number; }
interface Food extends Point {
  color: string;
  size: number;
  value: number;
  isSuper?: boolean;
}
interface SnakeTheme { head: string; body: string; glow: string; }
interface ServerSnake {
  head: Point;
  angle: number;
  targetAngle: number;
  history: Point[];
  length: number;
  speed: number;
  dead: boolean;
  theme: SnakeTheme;
  isBoosting: boolean;
  score: number;
}
interface PlayerRecord {
  snake: ServerSnake;
  playerName: string;
  socketId: string;
}
interface RoomState {
  players: Record<string, PlayerRecord>;
  foods: Food[];
  lastTick: number;
}

// --- Room storage ---
const rooms: Record<string, RoomState> = {};

// --- Helper functions ---
function getLocalIPs(): string[] {
  const interfaces = os.networkInterfaces();
  const ips: string[] = [];
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] || []) {
      if (iface.family === "IPv4" && !iface.internal) {
        ips.push(iface.address);
      }
    }
  }
  return ips;
}

function createSnake(theme: SnakeTheme): ServerSnake {
  const x = Math.random() * (WORLD_SIZE - 400) + 200;
  const y = Math.random() * (WORLD_SIZE - 400) + 200;
  const history: Point[] = [];
  for (let i = 0; i < 200; i++) {
    history.push({ x: x - i * RECORD_DIST, y });
  }
  return {
    head: { x, y },
    angle: Math.random() * Math.PI * 2,
    targetAngle: 0,
    history,
    length: 10,
    speed: BASE_SPEED,
    dead: false,
    theme,
    isBoosting: false,
    score: 0,
  };
}

function spawnFood(count: number, foods: Food[], nearX?: number, nearY?: number, isSuper = false): void {
  for (let i = 0; i < count; i++) {
    let fx: number, fy: number;
    if (nearX !== undefined && nearY !== undefined) {
      const angle = Math.random() * Math.PI * 2;
      const dist = Math.random() * 80;
      fx = Math.max(10, Math.min(WORLD_SIZE - 10, nearX + Math.cos(angle) * dist));
      fy = Math.max(10, Math.min(WORLD_SIZE - 10, nearY + Math.sin(angle) * dist));
    } else {
      fx = Math.random() * (WORLD_SIZE - 100) + 50;
      fy = Math.random() * (WORLD_SIZE - 100) + 50;
    }
    foods.push({
      x: fx,
      y: fy,
      color: isSuper ? "#facc15" : FOOD_COLORS[Math.floor(Math.random() * FOOD_COLORS.length)],
      size: isSuper ? 12 : Math.random() * 4 + 4,
      value: isSuper ? 30 : 10,
      isSuper,
    });
  }
}

function initRoomFoods(room: RoomState): void {
  room.foods = [];
  spawnFood(FOOD_COUNT, room.foods);
}

// --- Server-side game tick ---
function tickRoom(roomCode: string, io: Server): void {
  const room = rooms[roomCode];
  if (!room) return;

  const now = Date.now();
  const dt = Math.min((now - room.lastTick) / 1000, 0.1);
  room.lastTick = now;

  const playerIds = Object.keys(room.players);
  if (playerIds.length === 0) return;

  const aliveSnakes: { id: string; snake: ServerSnake }[] = [];

  // --- Movement & Physics ---
  for (const pid of playerIds) {
    const pr = room.players[pid];
    const snake = pr.snake;
    if (snake.dead) continue;

    aliveSnakes.push({ id: pid, snake });

    // Steering
    let diff = snake.targetAngle - snake.angle;
    diff = Math.atan2(Math.sin(diff), Math.cos(diff));
    snake.angle += diff * TURN_SPEED * dt;

    // Speed
    const currentSpeed = snake.isBoosting ? snake.speed * 2 : snake.speed;

    // Movement
    snake.head.x += Math.cos(snake.angle) * currentSpeed * dt;
    snake.head.y += Math.sin(snake.angle) * currentSpeed * dt;

    // World bounds → death
    if (snake.head.x < 0 || snake.head.x > WORLD_SIZE ||
        snake.head.y < 0 || snake.head.y > WORLD_SIZE) {
      handleDeath(roomCode, pid, "World Border", io);
      continue;
    }

    // Record history
    const lastRecord = snake.history[0];
    const distSinceLast = Math.hypot(snake.head.x - lastRecord.x, snake.head.y - lastRecord.y);
    if (distSinceLast >= RECORD_DIST) {
      snake.history.unshift({ x: snake.head.x, y: snake.head.y });
      const maxHistory = snake.length * SEGMENT_SPACING_IDX + 20;
      if (snake.history.length > maxHistory) {
        snake.history.length = maxHistory;
      }
    }

    // Food collision
    for (let i = room.foods.length - 1; i >= 0; i--) {
      const f = room.foods[i];
      if (Math.hypot(snake.head.x - f.x, snake.head.y - f.y) < 20 + f.size) {
        // Swap-and-pop removal
        room.foods[i] = room.foods[room.foods.length - 1];
        room.foods.pop();
        snake.score += f.value;
        snake.length += 1;
        snake.speed += SPEED_INC;
        // Respawn a normal food to keep count up
        spawnFood(1, room.foods);
      }
    }
  }

  // --- Snake vs Snake collision ---
  for (const { id: pid, snake } of aliveSnakes) {
    if (snake.dead) continue;
    for (const { id: otherId, snake: other } of aliveSnakes) {
      if (other.dead || pid === otherId) continue;

      for (let i = 0; i < other.length; i++) {
        const idx = i * SEGMENT_SPACING_IDX;
        if (idx < other.history.length) {
          const seg = other.history[idx];
          if (Math.hypot(snake.head.x - seg.x, snake.head.y - seg.y) < 18) {
            const killerName = room.players[otherId]?.playerName || "Unknown";
            handleDeath(roomCode, pid, killerName, io);
            break;
          }
        }
      }
    }
  }

  // --- Broadcast state ---
  const statePayload: Record<string, any> = {};
  for (const pid of Object.keys(room.players)) {
    const pr = room.players[pid];
    statePayload[pid] = {
      snake: pr.snake,
      playerName: pr.playerName,
    };
  }

  io.to(roomCode).emit("room_state", {
    players: statePayload,
    foods: room.foods,
  });
}

function handleDeath(roomCode: string, playerId: string, killedBy: string, io: Server): void {
  const room = rooms[roomCode];
  if (!room) return;
  const pr = room.players[playerId];
  if (!pr || pr.snake.dead) return;

  const snake = pr.snake;
  snake.dead = true;

  // Drop super food along the entire body trail
  for (let i = 0; i < snake.length; i++) {
    const idx = i * SEGMENT_SPACING_IDX;
    if (idx < snake.history.length) {
      const pos = snake.history[idx];
      spawnFood(1, room.foods, pos.x, pos.y, true); // isSuper = true → big golden food
    }
  }

  // Broadcast death event (for client shatter effect)
  io.to(roomCode).emit("player_death", {
    playerId,
    playerName: pr.playerName,
    x: snake.head.x,
    y: snake.head.y,
    color: snake.theme.head,
    bodyColor: snake.theme.body,
    segmentCount: snake.length,
    // Send body positions for multi-point shatter
    bodyPositions: snake.history
      .filter((_, i) => i % SEGMENT_SPACING_IDX === 0)
      .slice(0, snake.length),
  });

  // System chat message
  broadcastSystemMessage(roomCode, `${pr.playerName} was terminated by ${killedBy}`, io);

  // Notify the dead player specifically
  const deadSocket = io.sockets.sockets.get(playerId);
  if (deadSocket) {
    deadSocket.emit("you_died", { score: snake.score, killedBy });
  }
}

function broadcastSystemMessage(roomCode: string, text: string, io: Server): void {
  io.to(roomCode).emit("chat_message", {
    id: Date.now() + Math.random(),
    sender: "SYSTEM",
    text,
    isSystem: true,
  });
}

// --- Main Server ---
async function startServer() {
  const app = express();
  const PORT = parseInt(process.env.PORT || "3000", 10);
  const httpServer = createServer(app);

  const io = new Server(httpServer, {
    cors: { origin: "*" },
    pingTimeout: 60000,
    pingInterval: 25000,
  });

  io.on("connection", (socket) => {
    console.log(`User connected: ${socket.id}`);
    let currentRoom: string | null = null;

    socket.on("join_room", (data: { roomCode: string; playerName: string; theme?: SnakeTheme }) => {
      const { roomCode, playerName, theme } = data;

      // Leave old room
      if (currentRoom) {
        leaveRoom(currentRoom, socket.id, io);
      }

      socket.join(roomCode);
      currentRoom = roomCode;

      // Create room if needed
      if (!rooms[roomCode]) {
        rooms[roomCode] = {
          players: {},
          foods: [],
          lastTick: Date.now(),
        };
        initRoomFoods(rooms[roomCode]);
      }

      // Create player snake
      const snakeTheme = theme || SNAKE_COLORS[Math.floor(Math.random() * SNAKE_COLORS.length)];
      rooms[roomCode].players[socket.id] = {
        snake: createSnake(snakeTheme),
        playerName: playerName || "Anon",
        socketId: socket.id,
      };

      console.log(`User ${socket.id} (${playerName}) joined room: ${roomCode}`);
      broadcastSystemMessage(roomCode, `${playerName} joined the arena`, io);
    });

    // Client sends input only (not full snake state)
    socket.on("player_input", (data: { targetAngle: number; isBoosting: boolean }) => {
      if (!currentRoom || !rooms[currentRoom]) return;
      const pr = rooms[currentRoom].players[socket.id];
      if (!pr || pr.snake.dead) return;
      pr.snake.targetAngle = data.targetAngle;
      pr.snake.isBoosting = data.isBoosting;
    });

    // Player requests respawn
    socket.on("respawn", (data?: { theme?: SnakeTheme }) => {
      if (!currentRoom || !rooms[currentRoom]) return;
      const pr = rooms[currentRoom].players[socket.id];
      if (!pr) return;

      const snakeTheme = data?.theme || pr.snake.theme;
      pr.snake = createSnake(snakeTheme);
      broadcastSystemMessage(currentRoom, `${pr.playerName} respawned`, io);
    });

    // Chat messages
    socket.on("chat_message", (data: { text: string }) => {
      if (!currentRoom || !rooms[currentRoom]) return;
      const pr = rooms[currentRoom].players[socket.id];
      if (!pr) return;

      io.to(currentRoom).emit("chat_message", {
        id: Date.now() + Math.random(),
        sender: pr.playerName,
        text: data.text,
        isSystem: false,
      });
    });

    socket.on("disconnect", () => {
      console.log(`User disconnected: ${socket.id}`);
      if (currentRoom) {
        leaveRoom(currentRoom, socket.id, io);
      }
    });
  });

  function leaveRoom(roomCode: string, socketId: string, io: Server): void {
    const room = rooms[roomCode];
    if (!room) return;

    const pr = room.players[socketId];
    if (pr) {
      // Drop food trail from body if alive
      if (!pr.snake.dead) {
        for (let i = 0; i < pr.snake.length; i++) {
          const idx = i * SEGMENT_SPACING_IDX;
          if (idx < pr.snake.history.length) {
            const pos = pr.snake.history[idx];
            spawnFood(1, room.foods, pos.x, pos.y, true);
          }
        }

        // Broadcast death for shatter effect
        io.to(roomCode).emit("player_death", {
          playerId: socketId,
          playerName: pr.playerName,
          x: pr.snake.head.x,
          y: pr.snake.head.y,
          color: pr.snake.theme.head,
          bodyColor: pr.snake.theme.body,
          segmentCount: pr.snake.length,
          bodyPositions: pr.snake.history
            .filter((_, i) => i % SEGMENT_SPACING_IDX === 0)
            .slice(0, pr.snake.length),
        });
      }

      broadcastSystemMessage(roomCode, `${pr.playerName} disconnected`, io);
      delete room.players[socketId];
    }

    // Clean up empty rooms
    if (Object.keys(room.players).length === 0) {
      delete rooms[roomCode];
      console.log(`Room ${roomCode} destroyed (empty)`);
    }
  }

  // --- Server game loop ---
  setInterval(() => {
    for (const roomCode in rooms) {
      tickRoom(roomCode, io);
    }
  }, TICK_MS);

  // API routes
  app.get("/api/health", (req, res) => {
    res.json({
      status: "ok",
      rooms: Object.keys(rooms).length,
      players: Object.values(rooms).reduce((sum, r) => sum + Object.keys(r.players).length, 0),
    });
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static("dist"));
  }

  httpServer.listen(PORT, "0.0.0.0", () => {
    console.log(`\n🐍 ══════════════════════════════════════════`);
    console.log(`   NEON.IO — Cyberpunk Snake Multiplayer`);
    console.log(`   ══════════════════════════════════════════`);
    console.log(`   Local:   http://localhost:${PORT}`);
    const ips = getLocalIPs();
    ips.forEach(ip => {
      console.log(`   Network: http://${ip}:${PORT}`);
    });
    console.log(`   Tick Rate: ${TICK_RATE} fps`);
    console.log(`   ══════════════════════════════════════════\n`);
  });
}

startServer();
