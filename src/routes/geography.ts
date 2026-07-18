import { Router } from "express";
import { prisma } from "../lib/prisma";
import { asyncHandler, ApiError } from "../middleware/errorHandler";
import { asString, requireString } from "../lib/params";

const router = Router();

router.get("/regions", asyncHandler(async (_req, res) => {
  const regions = await prisma.region.findMany({
    orderBy: { name: "asc" },
    include: { _count: { select: { constituencies: true, districts: true } } },
  });
  res.json(regions);
}));

router.get("/districts", asyncHandler(async (req, res) => {
  const region = asString(req.query.region);
  const districts = await prisma.district.findMany({
    where: region ? { region: { shortName: region } } : undefined,
    orderBy: { name: "asc" },
    include: { region: { select: { shortName: true } } },
  });
  res.json(districts);
}));

// GET /geography/constituencies — includes both the current (2024) live
// station count and the archived 2016-era station count. The archive count
// is what the Results tab badge actually uses — confirmed the 26,002
// legacy stations ARE the real 2016 figures, not a proxy.
router.get("/constituencies", asyncHandler(async (req, res) => {
  const region = asString(req.query.region);
  const constituencies = await prisma.constituency.findMany({
    where: region ? { region: { shortName: region } } : undefined,
    orderBy: { name: "asc" },
    select: {
      id: true, name: true, ecCode: true, capital: true, isActive: true,
      region: { select: { shortName: true } },
      district: { select: { name: true } },
      _count: { select: { pollingStations: true, pollingStationArchive: true } },
    },
  });
  res.json(constituencies);
}));

router.get("/constituencies/:id", asyncHandler(async (req, res) => {
  const constituency = await prisma.constituency.findUnique({
    where: { id: requireString(req.params.id, "id") },
    include: {
      region: true, district: true, boundary: true,
      lineage: { include: { election: { select: { code: true } } } },
      _count: { select: { pollingStations: true, pollingStationArchive: true } },
    },
  });
  if (!constituency) throw new ApiError(404, "Constituency not found");
  res.json(constituency);
}));

// GET /geography/constituencies/:id/stations-archive — the actual archived
// 2016-era polling station list for this constituency (real names/codes,
// not just a count). Powers the drilldown's Stations tab.
router.get("/constituencies/:id/stations-archive", asyncHandler(async (req, res) => {
  const constituencyId = requireString(req.params.id, "id");
  const stations = await prisma.pollingStationArchive.findMany({
    where: { constituencyId },
    select: { code: true, name: true, eaCode: true, registeredVoters: true },
    orderBy: { code: "asc" },
  });
  res.json(stations);
}));

// GET /geography/constituencies/:id/stations-current — the REAL 2024 EC
// polling station register for this constituency (not the 2012-2016
// archive). Powers the drilldown's Stations tab now that
// CURRENT_ELECTION_CODE has moved to 2024.
router.get("/constituencies/:id/stations-current", asyncHandler(async (req, res) => {
  const constituencyId = requireString(req.params.id, "id");
  const stations = await prisma.pollingStation.findMany({
    where: { constituencyId },
    select: { code: true, name: true, registeredVoters: true },
    orderBy: { code: "asc" },
  });
  res.json(stations);
}));

export default router;
