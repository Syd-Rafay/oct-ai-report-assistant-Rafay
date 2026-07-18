import type { NextRequest } from "next/server";

export type RateLimitEntry = {
  count: number;
  resetAt: number;
};

export type InMemoryRateLimiter = {
  attempts: Map<string, RateLimitEntry>;
  isRateLimited(key: string): boolean;
};

export function createInMemoryRateLimiter(windowMs: number, maxAttempts: number): InMemoryRateLimiter {
  const attempts = new Map<string, RateLimitEntry>();

  function isRateLimited(key: string) {
    const now = Date.now();
    const current = attempts.get(key);
    if (!current || current.resetAt < now) {
      attempts.set(key, { count: 1, resetAt: now + windowMs });
      return false;
    }

    current.count += 1;
    return current.count > maxAttempts;
  }

  return { attempts, isRateLimited };
}

export function rateLimitKey(request: NextRequest, accessId: string) {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return `${forwarded || "unknown"}:${accessId.toLowerCase()}`;
}