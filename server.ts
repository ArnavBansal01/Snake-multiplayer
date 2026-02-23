import express from "express";
import { createServer as createViteServer } from "vite";
import { createServer } from "http";
import { Server } from "socket.io";

const rooms: Record<string, Record<string, any>> = {};

async function startServer() {
  const app = express();
  const PORT = 3000;
  const httpServer = createServer(app);
  
  const io = new Server(httpServer, {
    cors: {
      origin: "*",
    }
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
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();

