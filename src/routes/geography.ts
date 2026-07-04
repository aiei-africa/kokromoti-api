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

router.get("/constituencies", asyncHandler(async (req, res) => {
  const region = asString(req.query.region);
  const constituencies = await prisma.constituency.findMany({
    where: region ? { region: { shortName: region } } : undefined,
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
    where: { id: requireString(req.params.id, "id") },
    include: {
      region: true, district: true, boundary: true,
      lineage: { include: { election: { select: { code: true } } } },
      _count: { select: { pollingStations: true } },
    },
  });
  if (!constituency) throw new ApiError(404, "Constituency not found");
  res.json(constituency);
}));

// GET /geography/regions/:id/results/:electionCode — region-level roll-up,
// live-computed from constituency_results (same pattern as national roll-up —
// fine at this data volume for static 1992-2016 history; see the architecture
// note on pre-computed aggregates being required before any 2028 live/
// concurrent-consumer scenario).
router.get("/regions/:id/results/:electionCode", asyncHandler(async (req, res) => {
  const regionId = requireString(req.params.id, "id");
  const electionCode = requireString(req.params.electionCode, "electionCode");

  const region = await prisma.region.findUnique({ where: { id: regionId } });
  if (!region) throw new ApiError(404, "Region not found");

  const election = await prisma.election.findFirst({ where: { code: electionCode } });
  if (!election) throw new ApiError(404, `Election ${electionCode} not found`);

  const { type } = req.query;
  const electionType = type ? String(type).toUpperCase() : "PRESIDENTIAL";

  const results = await prisma.constituencyResult.findMany({
    where: {
      electionId: election.id,
      electionType: electionType as any,
      constituency: { regionId },
    },
    include: {
      constituency: { select: { name: true } },
      votes: {
        include: { candidate: { select: { fullName: true, party: { select: { abbreviation: true, colourHex: true } } } } },
        orderBy: { votes: "desc" },
      },
    },
  });

  const registeredVoters = results.reduce((s, r) => s + (r.registeredVoters ?? 0), 0);
  const totalCast = results.reduce((s, r) => s + (r.totalCast ?? 0), 0);
  const validVotes = results.reduce((s, r) => s + (r.validVotes ?? 0), 0);
  const rejectedBallots = results.reduce((s, r) => s + (r.rejectedBallots ?? 0), 0);
  const turnoutPct = registeredVoters ? Number(((totalCast / registeredVoters) * 100).toFixed(3)) : null;

  const votesByCandidate = new Map<string, { fullName: string; party: any; votes: number }>();
  for (const r of results) {
    for (const v of r.votes) {
      const key = v.candidateId;
      const existing = votesByCandidate.get(key);
      if (existing) existing.votes += v.votes;
      else votesByCandidate.set(key, { fullName: v.candidate.fullName, party: v.candidate.party, votes: v.votes });
    }
  }
  const candidateResults = [...votesByCandidate.values()]
    .sort((a, b) => b.votes - a.votes)
    .map((c) => ({ ...c, votePct: validVotes ? Number(((c.votes / validVotes) * 100).toFixed(2)) : 0 }));

  res.json({
    region: { id: region.id, name: region.name, shortName: region.shortName },
    election: election.code,
    electionType,
    constituenciesReporting: results.length,
    registeredVoters, totalCast, validVotes, rejectedBallots, turnoutPct,
    results: candidateResults,
    byConstituency: results.map((r) => ({
      constituency: r.constituency.name,
      winner: r.votes[0] ? { fullName: r.votes[0].candidate.fullName, party: r.votes[0].candidate.party?.abbreviation } : null,
      turnoutPct: r.turnoutPct,
    })),
  });
}));

export default router;
