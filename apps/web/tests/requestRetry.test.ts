import assert from "node:assert/strict";
import {
  ApiRequestError,
  isRetryableRequestError,
  parseRetryAfterSeconds,
} from "../src/services/apiRequestError";
import { withRetry } from "../src/services/requestRetry";

assert.equal(
  isRetryableRequestError(new ApiRequestError("limited", 429, "RATE_LIMITED", 35)),
  false
);
assert.equal(
  isRetryableRequestError(new ApiRequestError("bad", 400, "BAD_REQUEST")),
  false
);
assert.equal(
  isRetryableRequestError(new ApiRequestError("busy", 503, "UNAVAILABLE")),
  true
);
assert.equal(isRetryableRequestError(new TypeError("fetch failed")), true);
assert.equal(
  isRetryableRequestError(new ApiRequestError("timed out", null, "REQUEST_TIMEOUT")),
  true
);
assert.equal(parseRetryAfterSeconds("35"), 35);
assert.equal(parseRetryAfterSeconds("invalid"), null);
assert.equal(parseRetryAfterSeconds("-1"), null);

async function run(): Promise<void> {
  let transientAttempts = 0;
  const transientResult = await withRetry(
    async () => {
      transientAttempts += 1;
      if (transientAttempts < 3) {
        throw new ApiRequestError("busy", 503, "UNAVAILABLE");
      }
      return "ok";
    },
    { retries: 2, delayMs: 0, sleep: async () => undefined }
  );

  assert.equal(transientResult, "ok");
  assert.equal(transientAttempts, 3);

  let limitedAttempts = 0;
  await assert.rejects(
    withRetry(
      async () => {
        limitedAttempts += 1;
        throw new ApiRequestError("limited", 429, "RATE_LIMITED", 35);
      },
      { retries: 2, delayMs: 0, sleep: async () => undefined }
    ),
    (error: unknown) => error instanceof ApiRequestError && error.status === 429
  );
  assert.equal(limitedAttempts, 1);
}

void run();
