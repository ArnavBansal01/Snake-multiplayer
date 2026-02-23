# 🐍 NEON.IO — Cyberpunk Snake Multiplayer

A neon-infused, cyberpunk-themed multiplayer snake game built with React, Canvas, and Socket.IO. Play solo against AI bots or battle friends in real-time multiplayer rooms.

## 🎮 Features

- **Single Player** — Three difficulty modes (Easy, Medium, Hard) with AI bots
- **Multiplayer** — Create/join rooms with a 4-letter code, share via URL
- **Real-time Chat** — In-game chat during multiplayer sessions
- **Speed Boost** — Hold SPACE to boost (at your own risk!)
- **Cyberpunk Aesthetics** — Neon glow effects, CRT vignette, glitch animations

---

## 🚀 Local Development

**Prerequisites:** [Node.js](https://nodejs.org/) v18+

```bash
# Install dependencies
npm install

# Start dev server (with hot reload)
npm run dev
```

The server will print your **local** and **network** URLs so anyone on the same WiFi can join.

---

## 🌐 Deployment

### Vercel (Frontend Only)

> **Note:** Vercel uses serverless functions and does **not** support persistent WebSocket connections. You can deploy the frontend to Vercel, but multiplayer will require a separate WebSocket server.

```bash
# Build the frontend
npm run build

# The output is in the `dist/` folder
```

**Vercel Settings:**

| Setting           | Value          |
|-------------------|----------------|
| Framework Preset  | Vite           |
| Build Command     | `npm run build`|
| Output Directory  | `dist`         |
| Install Command   | `npm install`  |

### Full-Stack (Recommended for Multiplayer)

For the complete multiplayer experience, deploy to a platform that supports long-running processes:

**Railway / Render / Fly.io:**

```bash
# Build frontend assets
npm run build

# Start production server
npm start
```

| Setting           | Value          |
|-------------------|----------------|
| Build Command     | `npm run build`|
| Start Command     | `npm start`    |
| Port              | `3000`         |

Environment variables:
- `PORT` — Server port (default: `3000`)
- `GEMINI_API_KEY` — (Optional) Gemini AI API key

---

## 🎯 Controls

| Action      | Input                   |
|-------------|-------------------------|
| Steer       | Mouse / Touch           |
| Speed Boost | Hold `SPACE`            |
| Pause       | Press `P`               |
| Chat        | Click chat box (multiplayer) |

---

## 📁 Project Structure

```
├── server.ts          # Express + Socket.IO server
├── src/
│   ├── App.tsx        # Game engine + UI (canvas-based)
│   ├── main.tsx       # React entry point
│   └── index.css      # Styles + animations
├── index.html         # HTML shell
├── vite.config.ts     # Vite configuration
└── package.json
```

---

## 📄 License

MIT
