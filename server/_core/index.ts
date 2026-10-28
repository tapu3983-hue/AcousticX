import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import express from "express";
import { createServer } from "http";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { registerOAuthRoutes } from "./oauth";
import { publicPlatformScript } from "./publicConfig";
import { appRouter } from "../routers";
import { createContext } from "./context";
import { serveStatic, setupVite } from "./vite";

const isBundled = import.meta.dirname.endsWith("dist") || fs.existsSync(path.resolve(import.meta.dirname, "public"));
process.env.NODE_ENV = process.env.NODE_ENV || (isBundled ? "production" : "development");

function getLocalIpAddresses() {
  const interfaces = os.networkInterfaces();
  const addresses: string[] = [];
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] || []) {
      if (iface.family === "IPv4" && !iface.internal) {
        addresses.push(iface.address);
      }
    }
  }
  return addresses;
}

interface TransmissionRecord {
  id: string;
  text: string;
  sender: string;
  timestamp: number;
  carrierLow?: number;
  carrierHigh?: number;
  type: "text" | "voice";
  status: "transmitted" | "received" | "failed";
}

interface ActiveTransmission extends TransmissionRecord {
  expiresAt: number;
  durationMs: number;
}

const messageHistory: TransmissionRecord[] = [];
let activeTransmission: ActiveTransmission | null = null;
type SyncClient = { id: string; res: express.Response };
const syncClients: SyncClient[] = [];

function broadcastToClients(event: Record<string, unknown>) {
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const client of syncClients) {
    try {
      client.res.write(payload);
    } catch {
      /* ignore disconnected */
    }
  }
}

// Keep-alive heartbeat every 15s to prevent ngrok / proxy drop
setInterval(() => {
  for (const client of syncClients) {
    try {
      client.res.write(": keep-alive\n\n");
    } catch {
      /* ignore */
    }
  }
}, 15000);

async function startServer() {
  const app = express();
  const server = createServer(app);
  // Configure body parser with larger size limit for file uploads
  app.use(express.json({ limit: "50mb" }));
  app.use(express.urlencoded({ limit: "50mb", extended: true }));
  app.get("/api/health", (_req, res) => res.json({ status: "ok" }));

  const port = Number(process.env.PORT || "3000");

  app.get("/api/network-info", (_req, res) => {
    const ips = getLocalIpAddresses();
    res.json({ ips, port });
  });

  app.get("/api/messages", (_req, res) => {
    res.json({ messages: messageHistory.slice(-25) });
  });

  app.get("/api/active-transmission", (_req, res) => {
    const active = activeTransmission && Date.now() < activeTransmission.expiresAt ? activeTransmission : null;
    res.json({ activeTransmission: active });
  });

  app.post("/api/transmit", (req, res) => {
    const {
      text,
      sender = "Device A",
      carrierLow = 1600,
      carrierHigh = 2200,
      type = "text",
      durationMs = 3500,
    } = req.body;
    if (!text || typeof text !== "string") {
      res.status(400).json({ error: "Text is required" });
      return;
    }

    const record: TransmissionRecord = {
      id: Math.random().toString(36).substring(2, 10),
      text: text.trim(),
      sender,
      timestamp: Date.now(),
      carrierLow,
      carrierHigh,
      type,
      status: "transmitted",
    };

    activeTransmission = {
      ...record,
      durationMs: Number(durationMs) || 3500,
      expiresAt: Date.now() + Math.max(Number(durationMs) + 12000, 25000),
    };

    messageHistory.push(record);
    if (messageHistory.length > 100) messageHistory.shift();

    broadcastToClients({
      type: "TRANSMIT_START",
      record,
      activeTransmission,
    });

    res.json({ success: true, record });
  });

  // Transmitter signals that speaker finished playing audio
  app.post("/api/transmit-end", (req, res) => {
    const { id } = req.body;
    broadcastToClients({
      type: "TRANSMIT_AUDIO_ENDED",
      id,
      timestamp: Date.now(),
    });
    res.json({ success: true });
  });

  // Receiver microphone detects physical acoustic carrier signal in the room
  app.post("/api/acoustic-signal", (req, res) => {
    const { detectedFreq, snrDb, decodedBits } = req.body;
    const now = Date.now();

    // If we have an active or recent transmission within 25 seconds:
    if (activeTransmission && now < activeTransmission.expiresAt) {
      activeTransmission.status = "received";
      const match = messageHistory.find((m) => m.id === activeTransmission?.id);
      if (match) match.status = "received";

      broadcastToClients({
        type: "ACOUSTIC_VERIFIED",
        id: activeTransmission.id,
        text: activeTransmission.text,
        sender: activeTransmission.sender,
        detectedFreq,
        snrDb,
        decodedBits,
        timestamp: now,
      });

      res.json({ success: true, verified: true, text: activeTransmission.text });
      return;
    }

    res.json({ success: true, verified: false });
  });

  // Live voice streaming endpoint: as speaker talks, stream live transcription
  app.post("/api/voice-stream", (req, res) => {
    const { text, isFinal, sender = "Device A" } = req.body;
    broadcastToClients({
      type: "VOICE_STREAM",
      text,
      isFinal: !!isFinal,
      sender,
      timestamp: Date.now(),
    });
    res.json({ success: true });
  });

  // Receiver confirmation
  app.post("/api/receive-confirm", (req, res) => {
    const { id, text } = req.body;
    const match = messageHistory.find((m) => m.id === id || m.text === text);
    if (match) {
      match.status = "received";
    }
    if (activeTransmission && (activeTransmission.id === id || activeTransmission.text === text)) {
      activeTransmission.status = "received";
    }

    broadcastToClients({
      type: "TRANSMIT_CONFIRMED",
      id,
      text,
      timestamp: Date.now(),
    });

    res.json({ success: true });
  });

  app.get("/api/sync/events", (req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();

    const id = Math.random().toString(36).substring(2);
    syncClients.push({ id, res });

    // Send initial handshake with current count and recent messages
    res.write(
      `data: ${JSON.stringify({
        type: "HANDSHAKE",
        peerCount: syncClients.length,
        messages: messageHistory.slice(-10),
      })}\n\n`
    );

    broadcastToClients({
      type: "PEER_UPDATE",
      peerCount: syncClients.length,
    });

    req.on("close", () => {
      const idx = syncClients.findIndex((c) => c.id === id);
      if (idx !== -1) syncClients.splice(idx, 1);
      broadcastToClients({
        type: "PEER_UPDATE",
        peerCount: syncClients.length,
      });
    });
  });

  app.post("/api/sync/broadcast", (req, res) => {
    broadcastToClients(req.body);
    res.json({ success: true, clientCount: syncClients.length });
  });

  app.get("/api/platform/config.js", (_req, res) => {
    res.set("Cache-Control", "no-store").type("application/javascript").send(publicPlatformScript());
  });
  registerOAuthRoutes(app);
  // tRPC API
  app.use(
    "/api/trpc",
    createExpressMiddleware({
      router: appRouter,
      createContext,
    })
  );
  // development mode uses Vite, production mode uses static files
  if (process.env.NODE_ENV === "development") {
    await setupVite(app, server);
  } else {
    serveStatic(app);
  }

  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid PORT");
  server.on("error", error => { console.error("Server failed:", error.message); process.exit(1); });
  server.listen(port, "0.0.0.0", () => console.log(`Server listening on port ${port}`));
}

startServer().catch(error => { console.error(error); process.exit(1); });
