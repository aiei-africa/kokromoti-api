import jwt from "jsonwebtoken";

const JWT_SECRET = process.env.JWT_SECRET || "dev-only-secret-change-in-production";

export function signAccessToken(userId: string) {
  return jwt.sign({ sub: userId, type: "access" }, JWT_SECRET, { expiresIn: "15m" });
}

export function signVerificationToken(userId: string) {
  // Stateless — no DB row needed. The token itself carries the claim and
  // expiry; signature guarantees it hasn't been tampered with.
  return jwt.sign({ sub: userId, type: "verify-email" }, JWT_SECRET, { expiresIn: "24h" });
}

export function verifyToken(token: string): { sub: string; type: string } | null {
  try {
    return jwt.verify(token, JWT_SECRET) as { sub: string; type: string };
  } catch {
    return null;
  }
}
