import { Router, Response } from "express";
import { prisma } from "../lib/prisma";
import { asyncHandler, ApiError } from "../middleware/errorHandler";
import { requireAuth, AuthedRequest } from "../middleware/auth";
import { requireString } from "../lib/params";
import { FavouriteType } from "@prisma/client";

const router = Router();
const VALID_TYPES = ["CONSTITUENCY", "REGION", "PARTY", "CANDIDATE"];

// GET /favourites — everything the signed-in user has starred, with the
// actual entity resolved (not just the bare id), so the frontend doesn't
// need a second round-trip per favourite.
router.get("/", requireAuth, asyncHandler(async (req: AuthedRequest, res: Response) => {
  const favourites = await prisma.favourite.findMany({
    where: { userId: req.userId! },
    orderBy: { createdAt: "desc" },
  });

  const byType = new Map<string, string[]>();
  for (const f of favourites) {
    const list = byType.get(f.entityType) ?? [];
    list.push(f.entityId);
    byType.set(f.entityType, list);
  }

  const [constituencies, regions, parties] = await Promise.all([
    byType.has("CONSTITUENCY")
      ? prisma.constituency.findMany({ where: { id: { in: byType.get("CONSTITUENCY") } }, select: { id: true, name: true, ecCode: true } })
      : [],
    byType.has("REGION")
      ? prisma.region.findMany({ where: { id: { in: byType.get("REGION") } }, select: { id: true, name: true, shortName: true } })
      : [],
    byType.has("PARTY")
      ? prisma.party.findMany({ where: { id: { in: byType.get("PARTY") } }, select: { id: true, name: true, abbreviation: true, colourHex: true } })
      : [],
  ]);

  res.json({
    constituencies, regions, parties,
    favouritedAt: Object.fromEntries(favourites.map((f) => [f.entityId, f.createdAt])),
  });
}));

// POST /favourites — { entityType: "CONSTITUENCY" | "REGION" | "PARTY" | "CANDIDATE", entityId: "..." }
router.post("/", requireAuth, asyncHandler(async (req: AuthedRequest, res: Response) => {
  const { entityType, entityId } = req.body;
  if (!entityType || !entityId) throw new ApiError(400, "entityType and entityId are required");
  if (!VALID_TYPES.includes(entityType)) throw new ApiError(400, `entityType must be one of ${VALID_TYPES.join(", ")}`);

  const favourite = await prisma.favourite.upsert({
    where: { userId_entityType_entityId: { userId: req.userId!, entityType: entityType as FavouriteType, entityId } },
    update: {},
    create: { userId: req.userId!, entityType: entityType as FavouriteType, entityId },
  });
  res.status(201).json(favourite);
}));

// DELETE /favourites/:entityType/:entityId
router.delete("/:entityType/:entityId", requireAuth, asyncHandler(async (req: AuthedRequest, res: Response) => {
  const entityType = requireString(req.params.entityType, "entityType");
  const entityId = requireString(req.params.entityId, "entityId");
  if (!VALID_TYPES.includes(entityType)) throw new ApiError(400, `entityType must be one of ${VALID_TYPES.join(", ")}`);

  await prisma.favourite.deleteMany({
    where: { userId: req.userId!, entityType: entityType as FavouriteType, entityId },
  });
  res.status(204).send();
}));

export default router;
