import { Router } from "express";
import { prisma } from "../lib/prisma";
import { asyncHandler, ApiError } from "../middleware/errorHandler";
import { requireString } from "../lib/params";

const router = Router();
const TRACKED_ELECTIONS = ["1996", "2000", "2004", "2008", "2012", "2016", "2020", "2024"];

function parseType(req: any): "PRESIDENTIAL" | "PARLIAMENTARY" {
  return (req.query.type ? String(req.query.type).toUpperCase() : "PRESIDENTIAL") as "PRESIDENTIAL" | "PARLIAMENTARY";
}

// GET /map-dashboard/constituency-boundaries?type=PRESIDENTIAL|PARLIAMENTARY
// (default PRESIDENTIAL) — every constituency's real geometry
// (ConstituencyBoundary, seeded from GM's own ArcGIS-derived shapefile
// data) plus its most recent (2024) result for the requested race, as a
// single GeoJSON FeatureCollection ready for the map. One bulk query, not
// 276 individual lookups. UPDATED (16 Jul 2026): was hardcoded to
// PRESIDENTIAL only — this is what fed the constituency fill colours on
// the map, so Parliamentary results never appeared on it. Now driven by
// `type`, defaulting to PRESIDENTIAL to preserve existing behaviour for
// any caller that doesn't pass it.
router.get("/constituency-boundaries", asyncHandler(async (req, res) => {
  const type = parseType(req);
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
        where: { electionId: election2024.id, electionType: type },
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

// GET /map-dashboard/trend?scope=national|region|constituency&id=X&type=PRESIDENTIAL|PARLIAMENTARY
// (default PRESIDENTIAL) — the same vote-share time series design as
// /results/history, generalized across scope. National/regional rows come
// from the pre-aggregated NationalResult/RegionalResult tables (real
// summed vote totals, not computed per-request); constituency scope
// reuses the existing per-constituency history logic directly. UPDATED
// (16 Jul 2026): all three scope branches were hardcoded to PRESIDENTIAL —
// now driven by `type`.
router.get("/trend", asyncHandler(async (req, res) => {
  const scope = (req.query.scope ? String(req.query.scope) : "national") as "national" | "region" | "constituency";
  const type = parseType(req);

  const elections = await prisma.election.findMany({ where: { code: { in: TRACKED_ELECTIONS } } });
  const electionByCode = new Map(elections.map((e) => [e.code, e]));

  interface CandidateRow { name: string; party: string | null; colourHex: string | null; photoUrl: string | null; votes: number; votePct: number; }
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
          photoUrl: (v.candidate as any).photoUrl ?? null,
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
      where: { electionId: { in: electionIds }, electionType: type, constituencyId },
      select: {
        electionId: true, registeredVoters: true, totalCast: true, validVotes: true, rejectedBallots: true, turnoutPct: true,
        votes: { include: { candidate: { select: { fullName: true, photoUrl: true, party: { select: { abbreviation: true, colourHex: true } } } } } },
      },
    });
    buildHistoryFromResults(results);
  } else if (type === "PARLIAMENTARY") {
    // Parliamentary has no single national/regional "candidate" per party —
    // 276 independent constituency races, not one shared race like
    // Presidential. RegionalResult/NationalResult (built around Presidential's
    // shape: a handful of named candidates, one per party, summed across
    // regions) has no meaningful equivalent here. The metric that IS real
    // and directly countable at this scope is SEATS WON per party — computed
    // live from the already-fully-seeded ConstituencyResult PARLIAMENTARY
    // rows (same precedent this app used for historical data before
    // RegionalResult existed: "keep computing live via groupBy" was the
    // original, deliberate design for exactly this kind of gap). No schema
    // change, no synthetic candidate rows — seat SHARE (seats ÷ total seats
    // × 100) reuses the existing 0–100% trend chart as-is, and the real
    // seat COUNT rides along in the same `votes` field the tooltip already
    // renders (candidates[].votes), so nothing on the frontend needs to
    // change to show it. Covers BOTH region and national scope in one
    // branch — a national tally is just an unfiltered version of the same
    // per-constituency-winner aggregation.
    let constituencyIdFilter: string[] | undefined;
    if (scope === "region") {
      const regionId = requireString(req.query.id, "id");
      const inRegion = await prisma.constituency.findMany({ where: { regionId }, select: { id: true } });
      constituencyIdFilter = inRegion.map((c) => c.id);
    }

    const results = await prisma.constituencyResult.findMany({
      where: {
        electionId: { in: electionIds },
        electionType: "PARLIAMENTARY",
        ...(constituencyIdFilter ? { constituencyId: { in: constituencyIdFilter } } : {}),
      },
      select: {
        electionId: true, registeredVoters: true, totalCast: true, validVotes: true, rejectedBallots: true,
        votes: {
          select: { votes: true, candidate: { select: { party: { select: { abbreviation: true, colourHex: true } } } } },
          orderBy: { votes: "desc" },
          take: 1, // only the winner of each constituency is needed for a seat tally
        },
      },
    });

    interface YearAgg {
      registeredVoters: number; totalCast: number; validVotes: number; rejectedBallots: number;
      seatsByParty: Map<string, { seats: number; colourHex: string | null }>;
      totalSeats: number;
    }
    const byElectionId = new Map<string, YearAgg>();
    for (const r of results) {
      let agg = byElectionId.get(r.electionId);
      if (!agg) { agg = { registeredVoters: 0, totalCast: 0, validVotes: 0, rejectedBallots: 0, seatsByParty: new Map(), totalSeats: 0 }; byElectionId.set(r.electionId, agg); }
      agg.registeredVoters += r.registeredVoters ?? 0;
      agg.totalCast += r.totalCast ?? 0;
      agg.validVotes += r.validVotes ?? 0;
      agg.rejectedBallots += r.rejectedBallots ?? 0;
      const winner = r.votes[0];
      if (!winner) continue; // undeclared constituency for this year — not counted as a seat either way
      agg.totalSeats++;
      const abbr = winner.candidate.party?.abbreviation ?? "Independent";
      const entry = agg.seatsByParty.get(abbr) ?? { seats: 0, colourHex: winner.candidate.party?.colourHex ?? null };
      entry.seats++;
      agg.seatsByParty.set(abbr, entry);
    }

    for (const code of TRACKED_ELECTIONS) {
      const election = electionByCode.get(code);
      if (!election) { history.push({ electionCode: code, year: Number(code), candidates: [], registeredVoters: null, totalCast: null, validVotes: null, rejectedBallots: null, turnoutPct: null, margin: null }); continue; }
      const agg = byElectionId.get(election.id);
      if (!agg || agg.totalSeats === 0) { history.push({ electionCode: code, year: election.year, candidates: [], registeredVoters: null, totalCast: null, validVotes: null, rejectedBallots: null, turnoutPct: null, margin: null }); continue; }

      const candidates: CandidateRow[] = [...agg.seatsByParty.entries()]
        .map(([abbr, { seats, colourHex }]) => ({ name: abbr, party: abbr, colourHex, photoUrl: null, votes: seats, votePct: Math.round((seats / agg.totalSeats) * 10000) / 100 }))
        .sort((a, b) => b.votes - a.votes);
      const margin = candidates.length >= 2 ? Math.round((candidates[0].votePct - candidates[1].votePct) * 100) / 100 : null;
      const turnoutPct = agg.registeredVoters > 0 ? Math.round((agg.totalCast / agg.registeredVoters) * 10000) / 100 : null;

      history.push({
        electionCode: code, year: election.year, candidates,
        registeredVoters: agg.registeredVoters || null, totalCast: agg.totalCast || null,
        validVotes: agg.validVotes || null, rejectedBallots: agg.rejectedBallots || null,
        turnoutPct, margin,
      });
    }
  } else if (scope === "region") {
    const regionId = requireString(req.query.id, "id");
    const results = await prisma.regionalResult.findMany({
      where: { electionId: { in: electionIds }, electionType: type, regionId },
      select: {
        electionId: true, registeredVoters: true, totalCast: true, validVotes: true, rejectedBallots: true, turnoutPct: true,
        votes: { include: { candidate: { select: { fullName: true, photoUrl: true, party: { select: { abbreviation: true, colourHex: true } } } } } },
      },
    });
    buildHistoryFromResults(results);
  } else {
    const results = await prisma.nationalResult.findMany({
      where: { electionId: { in: electionIds }, electionType: type },
      select: {
        electionId: true, registeredVoters: true, totalCast: true, validVotes: true, rejectedBallots: true, turnoutPct: true,
        votes: { include: { candidate: { select: { fullName: true, photoUrl: true, party: { select: { abbreviation: true, colourHex: true } } } } } },
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

  res.json({ scope, type, history, trend });
}));

// GET /map-dashboard/regions?type=PRESIDENTIAL|PARLIAMENTARY (default
// PRESIDENTIAL) — id + shortName for every region, so the frontend can
// resolve a tapped region's shortName (from the static boundary GeoJSON)
// to its real database id for the /trend?scope=region call. UPDATED (16
// Jul 2026): now ALSO returns each region's live 2024 winner
// (winnerParty/winnerColourHex) for the requested type. The national
// "16 regions" map view's geometry comes from a static file
// (ghana-regions-16.geojson, unioned from constituency polygons — no live
// polygon-union capability in the Node backend), which had the 2024
// PRESIDENTIAL winner baked into each feature's properties at generation
// time, with no way to show Parliamentary results on that view at all.
// The geometry itself doesn't need to change for a different race — only
// the fill colour does — so the frontend now merges this live
// winnerParty/winnerColourHex data onto the static file's features at
// render time instead of trusting the file's baked-in property.
router.get("/regions", asyncHandler(async (req, res) => {
  const type = parseType(req);
  const regions = await prisma.region.findMany({ select: { id: true, shortName: true, name: true } });
  const election2024 = await prisma.election.findFirst({ where: { code: "2024" } });

  const winnerByRegionId = new Map<string, { party: string; colourHex: string | null } | null>();

  if (type === "PARLIAMENTARY") {
    // RegionalResult is Presidential-only by design (no single national/
    // regional "candidate" per party for Parliamentary — 276 independent
    // constituency races). Same fix already proven for /trend and for
    // /results/parliamentary/.../region/.../summary: compute the region's
    // MAJORITY-SEAT party live from real ConstituencyResult winners,
    // tallied per region — that majority party colours the region on the
    // map, same principle as colouring a constituency by its own winner.
    const results = election2024
      ? await prisma.constituencyResult.findMany({
          where: { electionId: election2024.id, electionType: "PARLIAMENTARY" },
          select: {
            constituency: { select: { regionId: true } },
            votes: {
              select: { candidate: { select: { party: { select: { abbreviation: true, colourHex: true } } } } },
              orderBy: { votes: "desc" },
              take: 1,
            },
          },
        })
      : [];
    const seatsByRegion = new Map<string, Map<string, { seats: number; colourHex: string | null }>>();
    for (const r of results) {
      const winner = r.votes[0]?.candidate.party;
      if (!winner) continue;
      const regionId = r.constituency.regionId;
      const byParty = seatsByRegion.get(regionId) ?? new Map<string, { seats: number; colourHex: string | null }>();
      const entry = byParty.get(winner.abbreviation) ?? { seats: 0, colourHex: winner.colourHex };
      entry.seats++;
      byParty.set(winner.abbreviation, entry);
      seatsByRegion.set(regionId, byParty);
    }
    for (const [regionId, byParty] of seatsByRegion) {
      const top = [...byParty.entries()].sort((a, b) => b[1].seats - a[1].seats)[0];
      winnerByRegionId.set(regionId, top ? { party: top[0], colourHex: top[1].colourHex } : null);
    }
  } else {
    const results2024 = election2024
      ? await prisma.regionalResult.findMany({
          where: { electionId: election2024.id, electionType: type },
          include: { votes: { include: { candidate: { select: { party: { select: { abbreviation: true, colourHex: true } } } } }, orderBy: { votes: "desc" }, take: 1 } },
        })
      : [];
    for (const r of results2024) {
      winnerByRegionId.set(r.regionId, r.votes[0]?.candidate.party ? { party: r.votes[0].candidate.party.abbreviation, colourHex: r.votes[0].candidate.party.colourHex } : null);
    }
  }

  res.json(regions.map((r) => {
    const winner = winnerByRegionId.get(r.id);
    return { id: r.id, shortName: r.shortName, name: r.name, winnerParty: winner?.party ?? null, winnerColourHex: winner?.colourHex ?? null };
  }));
}));

export default router;
