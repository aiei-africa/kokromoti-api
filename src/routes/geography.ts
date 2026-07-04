import { Router } from "express";
import { prisma } from "../lib/prisma";
import { asyncHandler, ApiError } from "../middleware/errorHandler";

const router = Router();

router.get("/regions", asyncHandler(async (_req, res) => {
  const regions = await prisma.region.findMany({
    orderBy: { name: "asc" },
    include: { _count: { select: { constituencies: true, districts: true } } },
  });
  res.json(regions);
}));

router.get("/districts", asyncHandler(async (req, res) => {
  const { region } = req.query;
  const districts = await prisma.district.findMany({
    where: region ? { region: { shortName: String(region) } } : undefined,
    orderBy: { name: "asc" },
    include: { region: { select: { shortName: true } } },
  });
  res.json(districts);
}));

router.get("/constituencies", asyncHandler(async (req, res) => {
  const { region } = req.query;
  const constituencies = await prisma.constituency.findMany({
    where: region ? { region: { shortName: String(region) } } : undefined,
    orderBy: { name: "asc" },
    select: {
      id: true, name: true, ecCode: true, capital: true, isActive: true,
      region: { select: { shortName: true } },
      district: { select: { name: true } },
      _count: { select: { pollingStations: true } },
    },
  });
  res.json(constituencies);
}));

router.get("/constituencies/:id", asyncHandler(async (req, res) => {
  const constituency = await prisma.constituency.findUnique({
    where: { id: req.params.id },
    include: {
      region: true, district: true, boundary: true,
      lineage: { include: { election: { select: { code: true } } } },
      _count: { select: { pollingStations: true } },
    },
  });
  if (!constituency) throw new ApiError(404, "Constituency not found");
  res.json(constituency);
}));

export default router;
