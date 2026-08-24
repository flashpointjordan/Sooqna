import * as path from "node:path";
import cors from "cors";
import express from "express";
import helmet from "helmet";
import morgan from "morgan";
import rateLimit from "express-rate-limit";
import { env } from "./config/env";
import { openApiSpec } from "./config/swagger";
import { apiRouter } from "./routes";
import { errorHandler } from "./middleware/errorHandler";
import { notFoundHandler } from "./middleware/notFound";
import swaggerUi from "swagger-ui-express";
import { shouldExposeApiDocs } from "./routes/securityPolicy";
import { createRateLimitHandler } from "./middleware/rateLimitHandler";

export const app = express();

if (env.trustProxy !== false) {
  app.set("trust proxy", env.trustProxy);
}

app.use(
  helmet({
    crossOriginResourcePolicy: { policy: "cross-origin" },
  })
);
app.use(
  cors({
    origin(origin, callback) {
      if (!origin) {
        callback(null, true);
        return;
      }
      if (env.corsOrigins.includes(origin)) {
        callback(null, true);
        return;
      }
      callback(new Error("Origin is not allowed by CORS."));
    },
    credentials: true,
  })
);
app.use(express.json({ limit: "1mb" }));
app.use(morgan(env.nodeEnv === "production" ? "combined" : "dev"));

// General API limiter — 500 req / 15 min
app.use(
  "/api",
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 500,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, code: "RATE_LIMITED", message: "Too many requests. Please try again later." },
    handler: createRateLimitHandler("general", { success: false, code: "RATE_LIMITED", message: "Too many requests. Please try again later." }),
  })
);

// Auth limiter — 20 req / 15 min per IP (brute-force protection)
app.use(
  "/api/auth",
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, code: "RATE_LIMITED", message: "Too many auth requests. Please try again later." },
    handler: createRateLimitHandler("auth", { success: false, code: "RATE_LIMITED", message: "Too many auth requests. Please try again later." }),
  })
);

// Abuse protection for write-heavy/sensitive routes
app.use(
  "/api/reports",
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 40,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, code: "RATE_LIMITED", message: "Too many report requests." },
    handler: createRateLimitHandler("reports", { success: false, code: "RATE_LIMITED", message: "Too many report requests." }),
  })
);

app.use(
  "/api/messages",
  rateLimit({
    windowMs: 5 * 60 * 1000,
    max: 120,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, code: "RATE_LIMITED", message: "Too many messaging requests." },
    handler: createRateLimitHandler("messages", { success: false, code: "RATE_LIMITED", message: "Too many messaging requests." }),
  })
);

app.use(
  "/api/favorites",
  rateLimit({
    windowMs: 5 * 60 * 1000,
    max: 120,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, code: "RATE_LIMITED", message: "Too many favorites requests." },
    handler: createRateLimitHandler("favorites", { success: false, code: "RATE_LIMITED", message: "Too many favorites requests." }),
  })
);

app.use(
  "/api/listings",
  rateLimit({
    windowMs: 5 * 60 * 1000,
    max: 240,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, code: "RATE_LIMITED", message: "طلبات كثيرة. انتظر قليلاً ثم حاول مرة أخرى." },
    handler: createRateLimitHandler("listings-read", { success: false, code: "RATE_LIMITED", message: "طلبات كثيرة. انتظر قليلاً ثم حاول مرة أخرى." }),
  })
);

app.use(
  ["/api/listings", "/api/uploads"],
  rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req) => req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS",
    message: { success: false, code: "RATE_LIMITED", message: "طلبات كثيرة. انتظر قليلاً ثم حاول مرة أخرى." },
    handler: createRateLimitHandler("listings-write", { success: false, code: "RATE_LIMITED", message: "طلبات كثيرة. انتظر قليلاً ثم حاول مرة أخرى." }),
  })
);

app.use(
  "/api/admin",
  rateLimit({
    windowMs: 5 * 60 * 1000,
    max: 120,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, code: "RATE_LIMITED", message: "Too many admin requests." },
    handler: createRateLimitHandler("admin", { success: false, code: "RATE_LIMITED", message: "Too many admin requests." }),
  })
);

app.use(
  "/api/contact",
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 15,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, error: "Too many contact requests." },
    handler: createRateLimitHandler("contact", { success: false, error: "Too many contact requests." }),
  })
);

app.use(
  "/uploads",
  express.static(path.resolve(process.cwd(), "uploads"), {
    dotfiles: "deny",
    index: false,
    setHeaders(res) {
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Cache-Control", "public, max-age=86400");
    },
  })
);
if (shouldExposeApiDocs(env.nodeEnv)) {
  app.use("/api/docs", swaggerUi.serve, swaggerUi.setup(openApiSpec));
}
app.use("/api", apiRouter);
app.use(notFoundHandler);
app.use(errorHandler);

