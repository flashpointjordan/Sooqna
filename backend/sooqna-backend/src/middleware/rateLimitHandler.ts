import type { RateLimitExceededEventHandler } from "express-rate-limit";
import { logger } from "../config/logger";

export function createRateLimitHandler(
  limiter: string,
  body: Record<string, unknown>
): RateLimitExceededEventHandler {
  return (req, res) => {
    const retryAfter = res.getHeader("Retry-After");

    logger.warn("rate_limit_exceeded", {
      limiter,
      method: req.method,
      path: req.path,
      clientIp: req.ip,
      retryAfter: retryAfter == null ? "" : String(retryAfter),
    });

    res.status(429).json(body);
  };
}
