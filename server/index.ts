import express, { type Request, Response, NextFunction } from "express";
import rateLimit from "express-rate-limit";
import cors from "cors";
import helmet from "helmet";
import compression from "compression";
import { randomUUID } from "crypto";
import { registerRoutes } from "./routes";
import { serveStatic } from "./static";
import { createServer } from "http";
import { ipfsManager } from "./services/ipfs-manager";
import { validateConfig, printStartupReport } from "./services/config-validator";
import { logger } from "./logger";

const app = express();
const httpServer = createServer(app);

declare module "http" {
  interface IncomingMessage {
    rawBody: unknown;
  }
}

// Security headers (CSP, HSTS, X-Frame-Options, etc.)
const isDev = process.env.NODE_ENV !== "production";
app.use(helmet({
  contentSecurityPolicy: isDev ? false : undefined, // Disable CSP in dev (breaks Vite HMR)
}));

// CORS — allow same-origin in production, localhost in development
app.use(cors({
  origin: isDev
    ? [/^http:\/\/localhost:\d+$/, /^http:\/\/127\.0\.0\.1:\d+$/]
    : true, // same-origin in production
  credentials: true,
}));

// Response compression
app.use(compression());

// Request ID middleware
app.use((req: Request, res: Response, next: NextFunction) => {
  const requestId = randomUUID();
  (req as any).id = requestId;
  res.setHeader("X-Request-Id", requestId);
  next();
});

app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  }),
);

app.use(express.urlencoded({ extended: false }));
app.use('/api/upload', express.raw({ limit: '50mb', type: 'application/octet-stream' }));

// Rate limiting — 3 tiers: global API, auth endpoints, upload
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many requests, please try again later" },
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many authentication attempts, please try again later" },
});

const uploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many uploads, please try again later" },
});

app.use("/api/", globalLimiter);
app.use("/api/validator/login", authLimiter);
app.use("/api/validator/validate-session", authLimiter);
app.use("/api/upload/", uploadLimiter);

export function log(message: string, source = "express") {
  logger.info({ source }, message);
}

app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;
  let capturedJsonResponse: Record<string, any> | undefined = undefined;

  const originalResJson = res.json;
  res.json = function (bodyJson, ...args) {
    capturedJsonResponse = bodyJson;
    return originalResJson.apply(res, [bodyJson, ...args]);
  };

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path.startsWith("/api")) {
      let logLine = `${req.method} ${path} ${res.statusCode} in ${duration}ms`;
      if (capturedJsonResponse) {
        logLine += ` :: ${JSON.stringify(capturedJsonResponse)}`;
      }

      log(logLine);
    }
  });

  next();
});

(async () => {
  // Start IPFS daemon automatically (like SPK Network's Docker Compose)
  log("Starting IPFS daemon automatically...", "ipfs");
  ipfsManager.registerShutdownHandlers();
  const started = await ipfsManager.start();
  if (started) {
    process.env.IPFS_API_URL = ipfsManager.getApiUrl();
    log(`IPFS daemon ready - uploads will use local node at ${process.env.IPFS_API_URL}`, "ipfs");
  } else {
    log("IPFS daemon failed to start - falling back to mock", "ipfs");
  }

  // Create database indexes (idempotent)
  const { addIndexes } = await import("./migrations/add-indexes");
  await addIndexes().catch((err) => log(`Index creation warning: ${err.message}`, "migrations"));

  // Seed database on startup
  const { seedDatabase } = await import("./seed");
  await seedDatabase().catch((err) => logger.error({ err }, "Seed failed"));

  await registerRoutes(httpServer, app);

  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";

    res.status(status).json({ message });
    throw err;
  });

  // importantly only setup vite in development and after
  // setting up all the other routes so the catch-all route
  // doesn't interfere with the other routes
  if (process.env.NODE_ENV === "production") {
    serveStatic(app);
  } else {
    const { setupVite } = await import("./vite");
    await setupVite(httpServer, app);
  }

  // ALWAYS serve the app on the port specified in the environment variable PORT
  // Other ports are firewalled. Default to 5000 if not specified.
  // this serves both the API and the client.
  // It is the only port that is not firewalled.
  const port = parseInt(process.env.PORT || "5000", 10);
  httpServer.listen(
    {
      port,
      host: "0.0.0.0",
    },
    () => {
      log(`serving on port ${port}`);

      // Print startup service status report
      const configReport = validateConfig();
      printStartupReport(configReport);
    },
  );

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    log(`${signal} received — shutting down gracefully...`, "shutdown");
    httpServer.close(() => log("HTTP server closed", "shutdown"));
    // Flush pending PoA proof batches before shutdown (prevent lost rewards)
    try {
      const { poaEngine } = await import("./services/poa-engine");
      await poaEngine.flushAllPendingBatches();
      poaEngine.stop();
      log("PoA engine stopped, pending batches flushed", "shutdown");
    } catch (err) { logger.error({ err }, "PoA flush error during shutdown"); }
    try { await ipfsManager.stop(); } catch (err) { logger.error({ err }, "IPFS stop error during shutdown"); }
    const { pool } = await import("./db");
    try { await pool.end(); log("Database pool closed", "shutdown"); } catch (err) { logger.error({ err }, "DB pool close error during shutdown"); }
    setTimeout(() => {
      log("Forced exit after 10s timeout", "shutdown");
      process.exit(1);
    }, 10_000).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
})();
