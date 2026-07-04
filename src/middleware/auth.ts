import { Request, Response, NextFunction } from "express";
import { verifyToken } from "../lib/jwt";
import { ApiError } from "./errorHandler";

// Applied ONLY to routes that need to know who's asking — favourites, and
// nothing else yet. Every browsing/read route stays fully open by design;
// this is the first feature that genuinely requires identity, not a
// general auth wall.
export interface AuthedRequest extends Request {
  userId?: string;
}

export function requireAuth(req: AuthedRequest, _res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    throw new ApiError(401, "Sign in to use this feature");
  }
  const token = header.slice("Bearer ".length);
  const payload = verifyToken(token);
  if (!payload || payload.type !== "access") {
    throw new ApiError(401, "Session expired — please sign in again");
  }
  req.userId = payload.sub;
  next();
}
