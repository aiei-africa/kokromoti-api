import { Router } from "express";
import { prisma } from "../lib/prisma";
import { asyncHandler, ApiError } from "../middleware/errorHandler";
import { requireString } from "../lib/params";

const router = Router();
const TRACKED_ELECTIONS = ["1996", "2000", "2004", "2008", "2012", "2016", "2020", "2024"];

// GET /map-dashboard/constituency-boundaries — every constituency's real
// geometry (ConstituencyBoundary, seeded from GM's own ArcGIS-derived
// shapefile data) plus its most recent (2024) presidential result, as a
// single GeoJSON FeatureCollection ready for the map. One bulk query, not
// 276 individual lookups.
router.get("/constituency-boundaries", asyncHandler(async (_req, res) => {
  const boundaries = await prisma.constituencyBoundary.findMany({
    include: {
      constituency: {
        select: {
          id: true, name: true, district: true, region: { select: { shortName: true } },
        },
      },
    },
  });

  const election2024 = await prisma.election.findFirst({ where: { code: "2024" } });
  const results2024 = election2024
    ? await prisma.constituencyResult.findMany({
        where: { electionId: election2024.id, electionType: "PRESIDENTIAL" },
        include: { votes: { include: { candidate: { select: { fullName: true, party: { select: { abbreviation: true, colourHex: true } } } } }, orderBy: { votes: "desc" }, take: 1 } },
      })
    : [];
  const winnerByConstituencyId = new Map(
    results2024.map((r) => [r.constituencyId, r.votes[0] ? { party: r.votes[0].candidate.party?.abbreviation ?? null, name: r.votes[0].candidate.fullName, votes: r.votes[0].votes, colourHex: r.votes[0].candidate.party?.colourHex ?? null } : null])
  );

  const features = boundaries.map((b) => {
    const winner = winnerByConstituencyId.get(b.constituencyId);
    return {
      type: "Feature",
      properties: {
        constituencyId: b.constituencyId,
        name: b.constituency.name,
        district: b.constituency.district,
        region: b.constituency.region?.shortName ?? null,
        source: b.source,
        winnerParty: winner?.party ?? null,
        winnerName: winner?.name ?? null,
        winnerVotes: winner?.votes ?? null,
        winnerColourHex: winner?.colourHex ?? null,
      },
      geometry: b.geometry,
    };
  });

  res.json({ type: "FeatureCollection", features });
}));

// GET /map-dashboard/trend?scope=national|region|constituency&id=X —
// the same vote-share time series design as /results/history, generalized
// across scope. National/regional rows come from the pre-aggregated
// NationalResult/RegionalResult tables (real summed vote totals, not
// computed per-request); constituency scope reuses the existing
// per-constituency history logic directly.
router.get("/trend", asyncHandler(async (req, res) => {
  const scope = (req.query.scope ? String(req.query.scope) : "national") as "national" | "region" | "constituency";

  const elections = await prisma.election.findMany({ where: { code: { in: TRACKED_ELECTIONS } } });
  const electionByCode = new Map(elections.map((e) => [e.code, e]));

  interface CandidateRow { name: string; party: string | null; colourHex: string | null; votes: number; votePct: number; }
  interface YearRow {
    electionCode: string; year: number;
    candidates: CandidateRow[];
    registeredVoters: number | null; totalCast: number | null; validVotes: number | null;
    rejectedBallots: number | null; turnoutPct: number | null; margin: number | null;
  }

  const history: YearRow[] = [];
  const electionIds = [...electionByCode.values()].map((e) => e.id);

  function buildHistoryFromResults(results: { electionId: string; registeredVoters: number | null; totalCast: number | null; validVotes: number | null; rejectedBallots: number | null; turnoutPct: any; votes: { votes: number; voteShare: any; candidate: { fullName: string; party: { abbreviation: string; colourHex: string | null } | null } }[] }[]) {
    const byElectionId = new Map(results.map((r) => [r.electionId, r]));
    for (const code of TRACKED_ELECTIONS) {
      const election = electionByCode.get(code);
      if (!election) { history.push({ electionCode: code, year: Number(code), candidates: [], registeredVoters: null, totalCast: null, validVotes: null, rejectedBallots: null, turnoutPct: null, margin: null }); continue; }
      const result = byElectionId.get(election.id);
      const candidates: CandidateRow[] = (result?.votes ?? [])
        .slice()
        .sort((a, b) => b.votes - a.votes)
        .map((v) => ({
          name: v.candidate.fullName, party: v.candidate.party?.abbreviation ?? null, colourHex: v.candidate.party?.colourHex ?? null,
          votes: v.votes, votePct: v.voteShare ? Number(v.voteShare) : 0,
        }));
      const margin = candidates.length >= 2 ? Math.round((candidates[0].votePct - candidates[1].votePct) * 100) / 100 : null;
      history.push({
        electionCode: code, year: election.year, candidates,
        registeredVoters: result?.registeredVoters ?? null, totalCast: result?.totalCast ?? null,
        validVotes: result?.validVotes ?? null, rejectedBallots: result?.rejectedBallots ?? null,
        turnoutPct: result?.turnoutPct ? Number(result.turnoutPct) : null, margin,
      });
    }
  }

  if (scope === "constituency") {
    const constituencyId = requireString(req.query.id, "id");
    const results = await prisma.constituencyResult.findMany({
      where: { electionId: { in: electionIds }, electionType: "PRESIDENTIAL", constituencyId },
      select: {
        electionId: true, registeredVoters: true, totalCast: true, validVotes: true, rejectedBallots: true, turnoutPct: true,
        votes: { include: { candidate: { select: { fullName: true, party: { select: { abbreviation: true, colourHex: true } } } } } },
      },
    });
    buildHistoryFromResults(results);
  } else if (scope === "region") {
    const regionId = requireString(req.query.id, "id");
    const results = await prisma.regionalResult.findMany({
      where: { electionId: { in: electionIds }, electionType: "PRESIDENTIAL", regionId },
      select: {
        electionId: true, registeredVoters: true, totalCast: true, validVotes: true, rejectedBallots: true, turnoutPct: true,
        votes: { include: { candidate: { select: { fullName: true, party: { select: { abbreviation: true, colourHex: true } } } } } },
      },
    });
    buildHistoryFromResults(results);
  } else {
    const results = await prisma.nationalResult.findMany({
      where: { electionId: { in: electionIds }, electionType: "PRESIDENTIAL" },
      select: {
        electionId: true, registeredVoters: true, totalCast: true, validVotes: true, rejectedBallots: true, turnoutPct: true,
        votes: { include: { candidate: { select: { fullName: true, party: { select: { abbreviation: true, colourHex: true } } } } } },
      },
    });
    buildHistoryFromResults(results);
  }

  // NDC/NPP/Others trend lines for the chart, same shape as /results/history
  const trend = {
    NDC: { colourHex: null as string | null, points: [] as { year: number; electionCode: string; votePct: number }[] },
    NPP: { colourHex: null as string | null, points: [] as { year: number; electionCode: string; votePct: number }[] },
    Others: { colourHex: null as string | null, points: [] as { year: number; electionCode: string; votePct: number }[] },
  };
  for (const h of history) {
    if (h.candidates.length === 0) continue;
    let othersPct = 0, sawOthers = false;
    for (const c of h.candidates) {
      if (c.party === "NDC") { trend.NDC.colourHex = c.colourHex; trend.NDC.points.push({ year: h.year, electionCode: h.electionCode, votePct: c.votePct }); }
      else if (c.party === "NPP") { trend.NPP.colourHex = c.colourHex; trend.NPP.points.push({ year: h.year, electionCode: h.electionCode, votePct: c.votePct }); }
      else { othersPct += c.votePct; sawOthers = true; }
    }
    if (sawOthers) trend.Others.points.push({ year: h.year, electionCode: h.electionCode, votePct: Math.round(othersPct * 100) / 100 });
  }

  res.json({ scope, history, trend });
}));

// GET /map-dashboard/regions — id + shortName for every region, so the
// frontend can resolve a tapped region's shortName (from the static
// boundary GeoJSON) to its real database id for the /trend?scope=region call.
router.get("/regions", asyncHandler(async (_req, res) => {
  const regions = await prisma.region.findMany({ select: { id: true, shortName: true, name: true } });
  res.json(regions);
}));

export default router;
