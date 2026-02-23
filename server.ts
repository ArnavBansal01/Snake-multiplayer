import express from "express";
import { createServer as createViteServer } from "vite";
import { createServer } from "http";
import { Server } from "socket.io";
import os from "os";

const rooms: Record<string, Record<string, any>> = {};

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

async function startServer() {
  const app = express();
  const PORT = parseInt(process.env.PORT || "3000", 10);
  const httpServer = createServer(app);
  
  const io = new Server(httpServer, {
    cors: {
      origin: "*",
    },
    pingTimeout: 60000,
    pingInterval: 25000,
  });

  io.on("connection", (socket) => {
    console.log(`User connected: ${socket.id}`);
    let currentRoom: string | null = null;

    socket.on("join_room", (roomCode) => {
      if (currentRoom) {
        socket.leave(currentRoom);
        if (rooms[currentRoom] && rooms[currentRoom][socket.id]) {
          delete rooms[currentRoom][socket.id];
        }
      }
      
      socket.join(roomCode);
      currentRoom = roomCode;
      
      if (!rooms[roomCode]) {
        rooms[roomCode] = {};
      }
      
      console.log(`User ${socket.id} joined room: ${roomCode}`);
    });

    socket.on("player_update", (data) => {
      if (currentRoom && rooms[currentRoom]) {
        rooms[currentRoom][socket.id] = data;
      }
    });

    socket.on("chat_message", (data) => {
      if (currentRoom) {
        io.to(currentRoom).emit("chat_message", data);
      }
    });

    socket.on("player_death", (data) => {
      if (currentRoom) {
        socket.broadcast.to(currentRoom).emit("player_death", data);
      }
    });

    socket.on("disconnect", () => {
      console.log(`User disconnected: ${socket.id}`);
      if (currentRoom && rooms[currentRoom]) {
        delete rooms[currentRoom][socket.id];
        if (Object.keys(rooms[currentRoom]).length === 0) {
          delete rooms[currentRoom];
        }
      }
    });
  });

  setInterval(() => {
    for (const roomCode in rooms) {
      io.to(roomCode).emit("room_state", rooms[roomCode]);
    }
  }, 50); // 20 ticks per second

  // API routes FIRST
  app.get("/api/health", (req, res) => {
    res.json({ status: "ok" });
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
    console.log(`   ══════════════════════════════════════════\n`);
  });
}

startServer();

