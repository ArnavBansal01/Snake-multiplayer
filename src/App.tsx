import React, { useState, useEffect, useRef, useCallback } from "react";
import {
  Trophy,
  Play,
  RotateCcw,
  Crosshair,
  Zap,
  Shield,
  Skull,
  Terminal,
} from "lucide-react";
import { io } from "socket.io-client";

const socket = io();

// --- Constants & Types ---
const WORLD_SIZE = 3000;
const FOOD_COUNT = 150;
const RECORD_DIST = 4; // Distance between recorded history points
const SEGMENT_SPACING_IDX = 6; // How many history points apart segments are
const FOOD_COLORS = [
  "#facc15",
  "#06b6d4",
  "#f43f5e",
  "#3b82f6",
  "#a855f7",
  "#4ade80",
];
const BOT_RESPAWN_DELAY = 5000;

type Difficulty = "EASY" | "MEDIUM" | "HARD";

interface GameConfig {
  baseSpeed: number; // Replaced moveDelayMs with direct speed
  turnSpeed: number;
  speedInc: number;
  botCount: number;
}

const DIFFICULTY_CONFIG: Record<Difficulty, GameConfig> = {
  // 150 pixels per sec. Smooth, playable.
  EASY: { baseSpeed: 150, turnSpeed: 3.5, speedInc: 0.1, botCount: 4 },

  // 220 pixels per sec. Standard arcade feel.
  MEDIUM: { baseSpeed: 220, turnSpeed: 4.5, speedInc: 0.2, botCount: 6 },

  // 300 pixels per sec. Fast, but actually playable and won't break the snake.
  HARD: { baseSpeed: 300, turnSpeed: 5.5, speedInc: 0.8, botCount: 10 },
};

interface Point {
  x: number;
  y: number;
}

interface Food extends Point {
  color: string;
  size: number;
  value: number;
  isSuper?: boolean;
}

interface Particle extends Point {
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  color: string;
  size: number;
}

interface SnakeEntity {
  head: Point;
  angle: number;
  targetAngle: number;
  history: Point[];
  length: number;
  speed: number;
  dead: boolean;
  respawnTime: number;
  color: string;
  isBot: boolean;
  decisionTimer?: number;
  isBoosting?: boolean;
}

interface KillFeedItem {
  id: number;
  text: string;
  time: number;
}

// --- Main Component ---
export default function App() {
  // React State for UI
  const [gameState, setGameState] = useState<
    "MENU" | "PLAYING" | "PAUSED" | "GAME_OVER"
  >("MENU");
  const [menuPhase, setMenuPhase] = useState<"START" | "SINGLE" | "MULTI">(
    "START",
  );
  const [difficulty, setDifficulty] = useState<Difficulty>("MEDIUM");
  const [score, setScore] = useState(0);
  const [highScore, setHighScore] = useState(() => {
    const saved = localStorage.getItem("cyberpunk-snake-io-highscore");
    return saved ? parseInt(saved, 10) : 0;
  });
  const [killFeed, setKillFeed] = useState<KillFeedItem[]>([]);

  // Multiplayer UI State
  const [playerName, setPlayerName] = useState("");
  const [roomCode, setRoomCode] = useState("");
  const [isMultiplayer, setIsMultiplayer] = useState(false);

  // Chat State
  const [chatMessages, setChatMessages] = useState<
    { id: number; sender: string; text: string }[]
  >([]);
  const [chatInput, setChatInput] = useState("");
  const [isChatFocused, setIsChatFocused] = useState(false);

  // Refs for Game Engine
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const requestRef = useRef<number>(null);

  const game = useRef({
    player: {
      head: { x: WORLD_SIZE / 2, y: WORLD_SIZE / 2 },
      angle: 0,
      targetAngle: 0,
      history: [] as Point[],
      length: 10,
      speed: 200,
      dead: false,
      respawnTime: 0,
      color: "#4ade80",
      isBot: false,
      isBoosting: false,
    } as SnakeEntity,
    bots: [] as SnakeEntity[],
    foods: [] as Food[],
    particles: [] as Particle[],
    networkPlayers: {} as Record<string, any>,
    lastNetworkUpdate: 0,
    lastTime: 0,
    config: DIFFICULTY_CONFIG["MEDIUM"],
  });

  const addKillFeed = useCallback((text: string) => {
    setKillFeed((prev) =>
      [
        ...prev,
        { id: Date.now() + Math.random(), text, time: Date.now() },
      ].slice(-5),
    );
  }, []);

  // --- URL & Room Logic ---
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get("room");
    if (code) {
      setRoomCode(code.toUpperCase());
      setMenuPhase("MULTI");
    }
  }, []);

  const generateRoomCode = () => {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    let code = "";
    for (let i = 0; i < 4; i++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
  };

  const handleCreateJoinRoom = () => {
    if (!playerName.trim()) return;

    let code = roomCode;
    if (!code) {
      code = generateRoomCode();
      setRoomCode(code);
    }

    // Update URL without reload
    const url = new URL(window.location.href);
    url.searchParams.set("room", code);
    window.history.pushState({}, "", url);

    socket.emit("join_room", code);

    setIsMultiplayer(true);
    // For multiplayer, we might default to a specific difficulty or sync it
    // For now, let's default to MEDIUM for fairness
    setDifficulty("HARD");
    initGame("HARD");
  };

  const handleSinglePlayerStart = (level: Difficulty) => {
    setDifficulty(level);
    setIsMultiplayer(false);
    initGame(level); // <-- Pass the level directly here!
  };

  // --- Game Engine Functions ---
  const spawnFood = useCallback(
    (count: number = 1, x?: number, y?: number, isSuper: boolean = false) => {
      const newFoods: Food[] = [];
      for (let i = 0; i < count; i++) {
        newFoods.push({
          x: x ?? Math.random() * (WORLD_SIZE - 100) + 50,
          y: y ?? Math.random() * (WORLD_SIZE - 100) + 50,
          color: isSuper
            ? "#facc15"
            : FOOD_COLORS[Math.floor(Math.random() * FOOD_COLORS.length)],
          size: isSuper ? 12 : Math.random() * 4 + 4,
          value: isSuper ? 30 : 10,
          isSuper,
        });
      }
      game.current.foods.push(...newFoods);
    },
    [],
  );

  const createParticles = useCallback(
    (x: number, y: number, color: string, count: number) => {
      for (let i = 0; i < count; i++) {
        const angle = Math.random() * Math.PI * 2;
        const speed = Math.random() * 150 + 50;
        game.current.particles.push({
          x,
          y,
          vx: Math.cos(angle) * speed,
          vy: Math.sin(angle) * speed,
          life: 2,
          maxLife: 2,
          color,
          size: Math.random() * 3 + 2,
        });
      }
    },
    [],
  );

  const createSnake = (
    x: number,
    y: number,
    isBot: boolean,
    config: GameConfig,
  ): SnakeEntity => {
    const initialHistory: Point[] = [];
    for (let i = 0; i < 200; i++) {
      initialHistory.push({ x: x - i * RECORD_DIST, y: y });
    }

    // NO MORE WEIRD MATH. Just use the direct speed!
    return {
      head: { x, y },
      angle: 0,
      targetAngle: 0,
      history: initialHistory,
      length: 10,
      speed: config.baseSpeed,
      dead: false,
      respawnTime: 0,
      color: isBot ? "#3b82f6" : "#4ade80",
      isBot,
      decisionTimer: 0,
      isBoosting: false,
    };
  };

  const initGame = useCallback(
    (selectedDifficulty: Difficulty) => {
      // Use the parameter instead of the React state
      const config = DIFFICULTY_CONFIG[selectedDifficulty];
      const startX = WORLD_SIZE / 2;
      const startY = WORLD_SIZE / 2;

      const player = createSnake(startX, startY, false, config);

      const bots: SnakeEntity[] = [];
      for (let i = 0; i < config.botCount; i++) {
        const bx = Math.random() > 0.5 ? 100 : WORLD_SIZE - 100;
        const by = Math.random() > 0.5 ? 100 : WORLD_SIZE - 100;
        bots.push(createSnake(bx, by, true, config));
      }

      game.current = {
        ...game.current,
        player,
        bots,
        foods: [],
        particles: [],
        lastTime: performance.now(),
        config,
      };

      spawnFood(FOOD_COUNT);
      setScore(0);
      setKillFeed([]);
      setGameState("PLAYING");
    },
    [difficulty, spawnFood],
  );

  const gameOver = useCallback(() => {
    setGameState("GAME_OVER");
    setScore((currentScore) => {
      if (currentScore > highScore) {
        setHighScore(currentScore);
        localStorage.setItem(
          "cyberpunk-snake-io-highscore",
          currentScore.toString(),
        );
      }
      return currentScore;
    });
  }, [highScore]);

  const handleSnakeDeath = useCallback(
    (snake: SnakeEntity, reason: string) => {
      snake.dead = true;

      // Shatter Effect
      const particleCount = snake.length * 5;
      createParticles(snake.head.x, snake.head.y, snake.color, particleCount);

      // Drop Super Food
      for (let i = 0; i < particleCount; i++) {
        if (i % 10 === 0) {
          // Drop super food near death location with some scatter
          const angle = Math.random() * Math.PI * 2;
          const dist = Math.random() * 50;
          spawnFood(
            1,
            snake.head.x + Math.cos(angle) * dist,
            snake.head.y + Math.sin(angle) * dist,
            true,
          );
        }
      }

      if (snake.isBot) {
        snake.respawnTime = performance.now() + BOT_RESPAWN_DELAY;
        addKillFeed(`Enemy player terminated by ${reason}`);
      } else {
        addKillFeed(`Player terminated by ${reason}`);
        if (isMultiplayer) {
          socket.emit("player_death", {
            x: snake.head.x,
            y: snake.head.y,
            color: snake.color,
            particleCount,
            message: `[SYSTEM]: ${playerName} was terminated by ${reason}`,
          });
        }
        gameOver();
      }
    },
    [
      spawnFood,
      addKillFeed,
      gameOver,
      createParticles,
      isMultiplayer,
      playerName,
    ],
  );

  // --- Game Loop ---
  const updateAndDraw = useCallback(
    (time: number) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      const g = game.current;
      const dt = Math.min((time - g.lastTime) / 1000, 0.1);
      g.lastTime = time;

      // Remove old kill feed items
      setKillFeed((prev) =>
        prev.filter((item) => Date.now() - item.time < 3000),
      );

      if (gameState === "PLAYING") {
        const snakes = isMultiplayer ? [g.player] : [g.player, ...g.bots];

        snakes.forEach((snake) => {
          if (snake.dead) {
            if (snake.isBot && time > snake.respawnTime) {
              const bx = Math.random() * (WORLD_SIZE - 200) + 100;
              const by = Math.random() * (WORLD_SIZE - 200) + 100;
              const newBot = createSnake(bx, by, true, g.config);
              Object.assign(snake, newBot);
              addKillFeed("New player respawned");
            }
            return;
          }

          // Speed Boost Logic
          const currentSpeed = snake.isBoosting ? snake.speed * 2 : snake.speed;

          // AI Logic
          if (snake.isBot) {
            snake.decisionTimer = (snake.decisionTimer || 0) - dt;
            if (snake.decisionTimer <= 0) {
              snake.decisionTimer = Math.random() * 0.5 + 0.2;

              if (Math.random() < 0.7 && g.foods.length > 0) {
                let nearest = g.foods[0];
                let minDst = Infinity;
                for (const f of g.foods) {
                  const dst = Math.hypot(
                    snake.head.x - f.x,
                    snake.head.y - f.y,
                  );
                  if (dst < minDst) {
                    minDst = dst;
                    nearest = f;
                  }
                }
                snake.targetAngle = Math.atan2(
                  nearest.y - snake.head.y,
                  nearest.x - snake.head.x,
                );
              } else {
                snake.targetAngle = Math.random() * Math.PI * 2;
              }
            }
          }

          // Movement
          let diff = snake.targetAngle - snake.angle;
          diff = Math.atan2(Math.sin(diff), Math.cos(diff));
          snake.angle += diff * g.config.turnSpeed * dt;

          snake.head.x += Math.cos(snake.angle) * currentSpeed * dt;
          snake.head.y += Math.sin(snake.angle) * currentSpeed * dt;

          // World Bounds Check
          if (
            snake.head.x < 0 ||
            snake.head.x > WORLD_SIZE ||
            snake.head.y < 0 ||
            snake.head.y > WORLD_SIZE
          ) {
            handleSnakeDeath(snake, "World Border");
          }

          // History
          const lastRecord = snake.history[0];
          const distSinceLast = Math.hypot(
            snake.head.x - lastRecord.x,
            snake.head.y - lastRecord.y,
          );
          if (distSinceLast >= RECORD_DIST) {
            snake.history.unshift({ x: snake.head.x, y: snake.head.y });
            const maxHistory = snake.length * SEGMENT_SPACING_IDX + 20;
            if (snake.history.length > maxHistory) {
              snake.history.length = maxHistory;
            }
          }

          // Food Collision
          let scoreGained = 0;
          for (let i = g.foods.length - 1; i >= 0; i--) {
            const f = g.foods[i];
            if (
              Math.hypot(snake.head.x - f.x, snake.head.y - f.y) <
              20 + f.size
            ) {
              g.foods.splice(i, 1);
              scoreGained += f.value;
              snake.length += 1;

              // Reverse speed logic: decrease delay, increase speed
              // We store the current delay in a custom property or just calculate it from speed
              const currentDelay = 10000 / snake.speed;
              const newDelay = Math.max(10, currentDelay - g.config.speedInc);
              snake.speed += g.config.speedInc;
              spawnFood(1);
            }
          }
          if (!snake.isBot && scoreGained > 0) {
            setScore((s) => s + scoreGained);
          }

          // Snake Collision
          const collisionTargets = isMultiplayer
            ? [
                g.player,
                ...Object.keys(g.networkPlayers)
                  .filter((id) => id !== socket.id)
                  .map((id) => g.networkPlayers[id]?.snake)
                  .filter(Boolean),
              ]
            : [g.player, ...g.bots];

          collisionTargets.forEach((otherSnake) => {
            if (otherSnake.dead || snake === otherSnake) return;

            for (let i = 0; i < otherSnake.length; i++) {
              const idx = i * SEGMENT_SPACING_IDX;
              if (idx < otherSnake.history.length) {
                const seg = otherSnake.history[idx];
                if (
                  Math.hypot(snake.head.x - seg.x, snake.head.y - seg.y) < 18
                ) {
                  handleSnakeDeath(
                    snake,
                    otherSnake.isBot ? "Enemy Bot" : "Network Player",
                  );
                  break;
                }
              }
            }
          });
        });

        // Update Particles
        for (let i = g.particles.length - 1; i >= 0; i--) {
          const p = g.particles[i];
          p.x += p.vx * dt;
          p.y += p.vy * dt;
          p.life -= dt;
          if (p.life <= 0) {
            g.particles.splice(i, 1);
          }
        }

        if (isMultiplayer && time - g.lastNetworkUpdate > 50) {
          g.lastNetworkUpdate = time;
          socket.emit("player_update", {
            snake: g.player,
            playerName,
          });
        }
      }

      // --- Rendering ---
      ctx.fillStyle = "#050505";
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      ctx.save();
      const cx = canvas.width / 2;
      const cy = canvas.height / 2;

      ctx.translate(cx - g.player.head.x, cy - g.player.head.y);

      // Grid
      ctx.strokeStyle = "#112233";
      ctx.lineWidth = 2;
      ctx.beginPath();
      const gridSpacing = 100;
      const startX =
        Math.floor((g.player.head.x - cx) / gridSpacing) * gridSpacing;
      const startY =
        Math.floor((g.player.head.y - cy) / gridSpacing) * gridSpacing;
      const endX = startX + canvas.width + gridSpacing * 2;
      const endY = startY + canvas.height + gridSpacing * 2;

      for (
        let x = Math.max(0, startX);
        x <= Math.min(WORLD_SIZE, endX);
        x += gridSpacing
      ) {
        ctx.moveTo(x, Math.max(0, startY));
        ctx.lineTo(x, Math.min(WORLD_SIZE, endY));
      }
      for (
        let y = Math.max(0, startY);
        y <= Math.min(WORLD_SIZE, endY);
        y += gridSpacing
      ) {
        ctx.moveTo(Math.max(0, startX), y);
        ctx.lineTo(Math.min(WORLD_SIZE, endX), y);
      }
      ctx.stroke();

      // Borders
      ctx.strokeStyle = "#ef4444";
      ctx.lineWidth = 10;
      ctx.strokeRect(0, 0, WORLD_SIZE, WORLD_SIZE);
      ctx.strokeStyle = "#ef444440";
      ctx.lineWidth = 30;
      ctx.strokeRect(0, 0, WORLD_SIZE, WORLD_SIZE);

      // Foods
      g.foods.forEach((f) => {
        ctx.fillStyle = f.color;
        ctx.beginPath();
        ctx.arc(f.x, f.y, f.size, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = f.color + "40";
        ctx.beginPath();
        ctx.arc(f.x, f.y, f.size * 2.5, 0, Math.PI * 2);
        ctx.fill();
      });

      // Particles
      g.particles.forEach((p) => {
        ctx.fillStyle = p.color;
        ctx.globalAlpha = p.life / p.maxLife;
        ctx.beginPath();
        ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
        ctx.fill();
        ctx.globalAlpha = 1;
      });

      // Snakes
      const allSnakes = isMultiplayer ? [g.player] : [...g.bots, g.player];

      if (isMultiplayer) {
        for (const socketId in g.networkPlayers) {
          if (socketId !== socket.id) {
            const networkData = g.networkPlayers[socketId];
            if (networkData && networkData.snake) {
              allSnakes.push({
                ...networkData.snake,
                playerName: networkData.playerName,
              });
            }
          }
        }
      }

      allSnakes.forEach((snake) => {
        if (snake.dead) return;

        const bodyColor = snake.isBot ? "#3b82f6" : "#a855f7";
        const headColor = snake.isBot ? "#60a5fa" : "#4ade80";
        const glowColor = snake.isBot ? "#3b82f640" : "#a855f730";

        // Boost Trail
        if (snake.isBoosting) {
          ctx.save();
          ctx.globalAlpha = 0.3;
          for (let i = 1; i < 5; i++) {
            const idx = i * 4;
            if (idx < snake.history.length) {
              const pos = snake.history[idx];
              ctx.fillStyle = headColor;
              ctx.beginPath();
              ctx.arc(pos.x, pos.y, 14, 0, Math.PI * 2);
              ctx.fill();
            }
          }
          ctx.restore();
        }

        // Body
        for (let i = snake.length - 1; i >= 1; i--) {
          const idx = i * SEGMENT_SPACING_IDX;
          if (idx < snake.history.length) {
            const pos = snake.history[idx];
            const isNearTail = i > snake.length - 3;
            const size = isNearTail ? 10 : 14;

            ctx.fillStyle = bodyColor;
            ctx.beginPath();
            ctx.arc(pos.x, pos.y, size, 0, Math.PI * 2);
            ctx.fill();

            ctx.fillStyle = glowColor;
            ctx.beginPath();
            ctx.arc(pos.x, pos.y, size * 1.8, 0, Math.PI * 2);
            ctx.fill();
          }
        }

        // Head
        ctx.fillStyle = headColor;
        ctx.beginPath();
        ctx.arc(snake.head.x, snake.head.y, 16, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = headColor + "40";
        ctx.beginPath();
        ctx.arc(snake.head.x, snake.head.y, 28, 0, Math.PI * 2);
        ctx.fill();

        // Eyes
        ctx.fillStyle = "#ffffff";
        const eyeOffset = 7;
        const eyeAngle = Math.PI / 3.5;
        const ex1 = snake.head.x + Math.cos(snake.angle - eyeAngle) * eyeOffset;
        const ey1 = snake.head.y + Math.sin(snake.angle - eyeAngle) * eyeOffset;
        const ex2 = snake.head.x + Math.cos(snake.angle + eyeAngle) * eyeOffset;
        const ey2 = snake.head.y + Math.sin(snake.angle + eyeAngle) * eyeOffset;

        ctx.beginPath();
        ctx.arc(ex1, ey1, 3.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.arc(ex2, ey2, 3.5, 0, Math.PI * 2);
        ctx.fill();

        // Pupils
        ctx.fillStyle = "#000000";
        const px1 = ex1 + Math.cos(snake.angle) * 1.5;
        const py1 = ey1 + Math.sin(snake.angle) * 1.5;
        const px2 = ex2 + Math.cos(snake.angle) * 1.5;
        const py2 = ey2 + Math.sin(snake.angle) * 1.5;
        ctx.beginPath();
        ctx.arc(px1, py1, 1.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.arc(px2, py2, 1.5, 0, Math.PI * 2);
        ctx.fill();

        // Player Name
        if ((snake as any).playerName) {
          ctx.fillStyle = "#06b6d4";
          ctx.font = "12px monospace";
          ctx.textAlign = "center";
          ctx.fillText(
            (snake as any).playerName,
            snake.head.x,
            snake.head.y - 35,
          );
        }
      });

      ctx.restore();

      requestRef.current = requestAnimationFrame(updateAndDraw);
    },
    [gameState, gameOver, handleSnakeDeath, isMultiplayer, playerName],
  );

  useEffect(() => {
    const handleRoomState = (state: Record<string, any>) => {
      game.current.networkPlayers = state;
    };
    const handleChatMessage = (msg: any) => {
      setChatMessages((prev) => [...prev, msg].slice(-20));
    };
    const handlePlayerDeath = (data: any) => {
      addKillFeed(data.message);
      createParticles(data.x, data.y, data.color, data.particleCount);
    };

    socket.on("room_state", handleRoomState);
    socket.on("chat_message", handleChatMessage);
    socket.on("player_death", handlePlayerDeath);
    return () => {
      socket.off("room_state", handleRoomState);
      socket.off("chat_message", handleChatMessage);
      socket.off("player_death", handlePlayerDeath);
    };
  }, [addKillFeed, createParticles]);

  // --- Event Listeners ---
  useEffect(() => {
    const handleResize = () => {
      if (canvasRef.current) {
        canvasRef.current.width = window.innerWidth;
        canvasRef.current.height = window.innerHeight;
      }
    };
    window.addEventListener("resize", handleResize);
    handleResize();
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  // Anti-Sleep Game Engine
  useEffect(() => {
    let intervalId: ReturnType<typeof setInterval>;

    // Start the normal smooth renderer
    requestRef.current = requestAnimationFrame(updateAndDraw);

    // Watch for tab switching
    const handleVisibilityChange = () => {
      if (document.hidden) {
        // Tab is hidden: Browser killed requestAnimationFrame.
        // Start a backup heartbeat engine at 30fps.
        if (requestRef.current) cancelAnimationFrame(requestRef.current);
        intervalId = setInterval(() => {
          updateAndDraw(performance.now());
        }, 1000 / 30);
      } else {
        // Tab is active: Resume smooth rendering.
        clearInterval(intervalId);
        requestRef.current = requestAnimationFrame(updateAndDraw);
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      if (requestRef.current) cancelAnimationFrame(requestRef.current);
      clearInterval(intervalId);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [updateAndDraw]);

  useEffect(() => {
    const handlePointerMove = (e: MouseEvent | TouchEvent) => {
      if (gameState !== "PLAYING") return;

      let clientX, clientY;
      if ("touches" in e) {
        clientX = e.touches[0].clientX;
        clientY = e.touches[0].clientY;
      } else {
        clientX = e.clientX;
        clientY = e.clientY;
      }

      const cx = window.innerWidth / 2;
      const cy = window.innerHeight / 2;

      game.current.player.targetAngle = Math.atan2(clientY - cy, clientX - cx);
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (isChatFocused) return;
      if (e.code === "Space") {
        game.current.player.isBoosting = true;
      }
      if (e.code === "KeyP") {
        setGameState((prev) => {
          if (prev === "PLAYING") return "PAUSED";
          if (prev === "PAUSED") return "PLAYING";
          return prev;
        });
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      if (isChatFocused) return;
      if (e.code === "Space") {
        game.current.player.isBoosting = false;
      }
    };

    window.addEventListener("mousemove", handlePointerMove);
    window.addEventListener("touchmove", handlePointerMove, { passive: false });
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);

    return () => {
      window.removeEventListener("mousemove", handlePointerMove);
      window.removeEventListener("touchmove", handlePointerMove);
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
    };
  }, [gameState, isChatFocused]);

  // Prevent scrolling on touch
  useEffect(() => {
    const preventDefault = (e: TouchEvent) => {
      if (gameState === "PLAYING") e.preventDefault();
    };
    document.addEventListener("touchmove", preventDefault, { passive: false });
    return () => document.removeEventListener("touchmove", preventDefault);
  }, [gameState]);

  // --- UI Components ---
  return (
    <div className="relative w-full h-screen bg-black overflow-hidden font-mono text-cyan-50 select-none">
      <canvas ref={canvasRef} className="absolute inset-0 block" />

      {/* In-Game HUD */}
      {gameState === "PLAYING" && (
        <>
          <div className="absolute top-0 left-0 w-full p-6 flex justify-between items-start pointer-events-none">
            <div>
              <h1 className="text-xl font-bold text-transparent bg-clip-text bg-gradient-to-r from-green-400 to-cyan-500 drop-shadow-[0_0_8px_rgba(74,222,128,0.5)]">
                NEON.IO
              </h1>
              <div className="text-sm text-cyan-400/80 mt-1 flex items-center gap-2">
                <Crosshair size={14} /> {difficulty}
              </div>
            </div>

            {isMultiplayer && (
              <div className="absolute top-6 left-1/2 -translate-x-1/2 bg-black/60 border border-purple-500/30 px-4 py-1 rounded-full text-xs text-purple-400 tracking-widest flex items-center gap-2 pointer-events-none">
                ROOM:{" "}
                <span className="font-bold text-purple-300">{roomCode}</span>
              </div>
            )}

            <div className="flex gap-6 text-right">
              <div className="flex flex-col items-end">
                <span className="text-xs text-cyan-500/70 uppercase tracking-widest">
                  Score
                </span>
                <span className="text-2xl font-bold text-green-400 drop-shadow-[0_0_8px_rgba(74,222,128,0.5)]">
                  {score}
                </span>
              </div>
              <div className="flex flex-col items-end">
                <span className="text-xs text-purple-400/70 uppercase tracking-widest flex items-center gap-1">
                  <Trophy className="w-3 h-3" /> Best
                </span>
                <span className="text-2xl font-bold text-purple-400 drop-shadow-[0_0_8px_rgba(168,85,247,0.5)]">
                  {highScore}
                </span>
              </div>
              <button
                onClick={() => setGameState("PAUSED")}
                className="ml-4 p-2 bg-gray-900/50 border border-cyan-500/30 rounded-lg text-cyan-400 hover:bg-cyan-500/20 hover:text-cyan-300 transition-all pointer-events-auto"
                title="Pause Game (P)"
              >
                <div className="w-4 h-4 flex justify-between">
                  <div className="w-1.5 h-full bg-current"></div>
                  <div className="w-1.5 h-full bg-current"></div>
                </div>
              </button>
            </div>
          </div>

          {/* Kill Feed */}
          <div className="absolute top-24 right-6 w-64 flex flex-col items-end gap-2 pointer-events-none">
            {killFeed.map((item) => (
              <div
                key={item.id}
                className="bg-black/60 border border-cyan-500/30 px-3 py-1 rounded text-xs text-cyan-400 flex items-center gap-2 animate-in slide-in-from-right fade-in duration-300"
              >
                <Terminal size={12} />
                {item.text}
              </div>
            ))}
          </div>

          <div className="absolute bottom-6 left-1/2 -translate-x-1/2 text-cyan-500/50 text-sm pointer-events-none">
            Hold <span className="text-cyan-400 font-bold">SPACE</span> for
            Speed Boost | Press{" "}
            <span className="text-cyan-400 font-bold">P</span> to Pause
          </div>

          {/* Chat Box */}
          {isMultiplayer && (
            <div className="absolute bottom-6 left-6 w-80 flex flex-col gap-2 pointer-events-auto z-10">
              <div className="bg-black/40 border border-cyan-500/30 rounded-lg p-2 h-40 overflow-y-auto flex flex-col gap-1 text-xs">
                {chatMessages.map((msg) => (
                  <div key={msg.id} className="break-words">
                    <span className="text-cyan-400 font-bold">
                      {msg.sender}:{" "}
                    </span>
                    <span className="text-cyan-50">{msg.text}</span>
                  </div>
                ))}
              </div>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  if (chatInput.trim()) {
                    socket.emit("chat_message", {
                      id: Date.now(),
                      sender: playerName,
                      text: chatInput.trim(),
                    });
                    setChatInput("");
                  }
                }}
              >
                <input
                  type="text"
                  value={chatInput}
                  onChange={(e) => setChatInput(e.target.value)}
                  onFocus={() => setIsChatFocused(true)}
                  onBlur={() => setIsChatFocused(false)}
                  placeholder="Type a message..."
                  className="w-full bg-black/60 border border-cyan-500/50 rounded-lg px-3 py-2 text-sm text-cyan-300 placeholder-cyan-800/50 focus:border-cyan-400 focus:outline-none font-mono"
                  maxLength={100}
                />
              </form>
            </div>
          )}
        </>
      )}

      {/* Pause Overlay */}
      {gameState === "PAUSED" && (
        <div className="absolute inset-0 bg-gray-950/80 backdrop-blur-md flex flex-col items-center justify-center z-20">
          <div className="max-w-md w-full p-8 bg-gray-900/50 border border-cyan-500/30 rounded-2xl shadow-[0_0_40px_rgba(6,182,212,0.15)] text-center">
            <h1 className="text-5xl font-black text-transparent bg-clip-text bg-gradient-to-br from-green-400 via-cyan-400 to-purple-500 mb-8 drop-shadow-[0_0_15px_rgba(6,182,212,0.5)] tracking-tighter">
              GAME PAUSED
            </h1>

            <div className="space-y-4">
              <button
                onClick={() => setGameState("PLAYING")}
                className="w-full py-4 bg-cyan-500/20 border border-cyan-400 text-cyan-300 rounded-xl hover:bg-cyan-500/40 hover:text-cyan-100 transition-all flex items-center justify-center gap-3 uppercase tracking-widest font-bold shadow-[0_0_20px_rgba(6,182,212,0.3)] cursor-pointer"
              >
                <Play className="w-6 h-6" /> Resume
              </button>

              <button
                onClick={() => setGameState("MENU")}
                className="w-full py-4 bg-red-500/20 border border-red-400 text-red-300 rounded-xl hover:bg-red-500/40 hover:text-red-100 transition-all flex items-center justify-center gap-3 uppercase tracking-widest font-bold shadow-[0_0_20px_rgba(239,68,68,0.3)] cursor-pointer"
              >
                <RotateCcw className="w-6 h-6" /> Quit
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Main Menu Overlay */}
      {gameState === "MENU" && (
        <div className="absolute inset-0 bg-gray-950/90 backdrop-blur-md flex flex-col items-center justify-center z-20">
          <div className="max-w-md w-full p-8 bg-gray-900/50 border border-cyan-500/30 rounded-2xl shadow-[0_0_40px_rgba(6,182,212,0.15)] text-center relative overflow-hidden">
            {/* Decorative Grid Background */}
            <div
              className="absolute inset-0 opacity-10 pointer-events-none"
              style={{
                backgroundImage:
                  "linear-gradient(#06b6d4 1px, transparent 1px), linear-gradient(90deg, #06b6d4 1px, transparent 1px)",
                backgroundSize: "20px 20px",
              }}
            />

            <h1 className="text-6xl font-black text-transparent bg-clip-text bg-gradient-to-br from-green-400 via-cyan-400 to-purple-500 mb-2 drop-shadow-[0_0_15px_rgba(6,182,212,0.5)] tracking-tighter relative z-10">
              NEON.IO
            </h1>
            <p className="text-cyan-400/70 mb-8 text-sm uppercase tracking-widest relative z-10">
              Cyberpunk Survival
            </p>

            {menuPhase === "START" && (
              <div className="space-y-4 relative z-10">
                <button
                  onClick={() => setMenuPhase("SINGLE")}
                  className="w-full py-4 bg-cyan-500/10 border border-cyan-500/50 text-cyan-300 rounded-xl hover:bg-cyan-500/30 hover:border-cyan-400 transition-all flex items-center justify-center gap-3 uppercase tracking-widest font-bold shadow-[0_0_15px_rgba(6,182,212,0.2)] group"
                >
                  <Zap className="w-5 h-5 group-hover:scale-110 transition-transform" />{" "}
                  Single Player
                </button>
                <button
                  onClick={() => setMenuPhase("MULTI")}
                  className="w-full py-4 bg-purple-500/10 border border-purple-500/50 text-purple-300 rounded-xl hover:bg-purple-500/30 hover:border-purple-400 transition-all flex items-center justify-center gap-3 uppercase tracking-widest font-bold shadow-[0_0_15px_rgba(168,85,247,0.2)] group"
                >
                  <Crosshair className="w-5 h-5 group-hover:scale-110 transition-transform" />{" "}
                  Multiplayer
                </button>
              </div>
            )}

            {menuPhase === "SINGLE" && (
              <div className="relative z-10 animate-in fade-in slide-in-from-bottom-4 duration-300">
                <h3 className="text-sm text-cyan-500/70 uppercase tracking-widest mb-4">
                  Select Difficulty
                </h3>
                <div className="grid grid-cols-3 gap-3 mb-6">
                  {(["EASY", "MEDIUM", "HARD"] as Difficulty[]).map((level) => (
                    <button
                      key={level}
                      onClick={() => handleSinglePlayerStart(level)}
                      className={`py-4 px-2 rounded-xl border flex flex-col items-center gap-2 transition-all ${
                        difficulty === level
                          ? "bg-cyan-500/20 border-cyan-400 text-cyan-300 shadow-[0_0_15px_rgba(6,182,212,0.4)]"
                          : "bg-gray-950/50 border-gray-800 text-gray-500 hover:border-cyan-500/50 hover:text-cyan-500"
                      }`}
                    >
                      {level === "EASY" && <Shield size={24} />}
                      {level === "MEDIUM" && <Zap size={24} />}
                      {level === "HARD" && <Skull size={24} />}
                      <span className="text-xs font-bold tracking-wider mt-1">
                        {level}
                      </span>
                    </button>
                  ))}
                </div>
                <button
                  onClick={() => setMenuPhase("START")}
                  className="text-gray-500 hover:text-white text-sm uppercase tracking-wider flex items-center justify-center gap-2"
                >
                  <RotateCcw size={14} /> Back
                </button>
              </div>
            )}

            {menuPhase === "MULTI" && (
              <div className="relative z-10 animate-in fade-in slide-in-from-bottom-4 duration-300">
                <div className="space-y-4 mb-6">
                  <div>
                    <label className="block text-xs text-cyan-500/70 uppercase tracking-widest mb-2 text-left">
                      Codename
                    </label>
                    <input
                      type="text"
                      value={playerName}
                      onChange={(e) => setPlayerName(e.target.value)}
                      placeholder="ENTER NAME"
                      className="w-full bg-black/50 border border-cyan-500/30 rounded-lg p-3 text-cyan-300 placeholder-cyan-800/50 focus:border-cyan-400 focus:outline-none font-mono text-center uppercase tracking-wider"
                      maxLength={12}
                    />
                  </div>

                  <div>
                    <label className="block text-xs text-purple-500/70 uppercase tracking-widest mb-2 text-left">
                      Room Code (Optional)
                    </label>
                    <div className="flex gap-2">
                      <input
                        type="text"
                        value={roomCode}
                        onChange={(e) =>
                          setRoomCode(e.target.value.toUpperCase())
                        }
                        placeholder="AUTO-GEN"
                        className="w-full bg-black/50 border border-purple-500/30 rounded-lg p-3 text-purple-300 placeholder-purple-800/50 focus:border-purple-400 focus:outline-none font-mono text-center uppercase tracking-wider"
                        maxLength={4}
                      />
                      <button
                        onClick={() => setRoomCode(generateRoomCode())}
                        className="bg-purple-500/20 border border-purple-500/50 text-purple-300 p-3 rounded-lg hover:bg-purple-500/40"
                        title="Generate New Code"
                      >
                        <RotateCcw size={20} />
                      </button>
                    </div>
                  </div>
                </div>

                <button
                  onClick={handleCreateJoinRoom}
                  disabled={!playerName.trim()}
                  className="w-full py-4 bg-green-500/20 border border-green-400 text-green-400 rounded-xl hover:bg-green-500/40 hover:text-green-300 transition-all flex items-center justify-center gap-3 uppercase tracking-widest font-bold shadow-[0_0_20px_rgba(74,222,128,0.3)] cursor-pointer group disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <Play className="w-6 h-6 group-hover:scale-110 transition-transform" />
                  {roomCode ? "Join Room" : "Create Room"}
                </button>

                <button
                  onClick={() => setMenuPhase("START")}
                  className="mt-4 text-gray-500 hover:text-white text-sm uppercase tracking-wider flex items-center justify-center gap-2"
                >
                  <RotateCcw size={14} /> Back
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Game Over Overlay */}
      {gameState === "GAME_OVER" && (
        <div className="absolute inset-0 bg-red-950/90 backdrop-blur-md flex flex-col items-center justify-center z-20">
          <div className="text-6xl font-black text-red-500 mb-4 drop-shadow-[0_0_25px_rgba(239,68,68,0.8)] tracking-widest uppercase text-center animate-glitch">
            System
            <br />
            Failure
          </div>

          <div className="bg-black/40 border border-red-500/30 p-6 rounded-2xl mb-8 text-center min-w-[250px]">
            <div className="text-red-400/70 text-sm uppercase tracking-widest mb-1">
              Final Score
            </div>
            <div className="text-5xl font-bold text-white drop-shadow-[0_0_10px_rgba(255,255,255,0.5)] mb-4">
              {score}
            </div>

            {score >= highScore && score > 0 && (
              <div className="text-yellow-400 text-sm font-bold tracking-widest uppercase animate-pulse flex items-center justify-center gap-2">
                <Trophy size={16} /> New High Score!
              </div>
            )}
          </div>

          <button
            onClick={() => setGameState("MENU")}
            className="px-8 py-4 bg-red-500/20 border border-red-400 text-red-300 rounded-xl hover:bg-red-500/40 hover:text-white transition-all flex items-center gap-3 uppercase tracking-widest font-bold shadow-[0_0_20px_rgba(239,68,68,0.4)] cursor-pointer"
          >
            <RotateCcw className="w-5 h-5" /> Reboot System
          </button>
        </div>
      )}
    </div>
  );
}
