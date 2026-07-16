import { Router } from "express";
import { prisma } from "../lib/prisma";
import { asyncHandler, ApiError } from "../middleware/errorHandler";
import { requireString } from "../lib/params";

const router = Router();

// Real elections only — 1992 is excluded by default since it's flagged
// elsewhere as non-gazetted/provisional (EC-compiled secondary source, not
// primary), so it's not counted toward a "swing seat" classification unless
// explicitly requested. Runoffs excluded — parliamentary has no runoff
// concept, and presidential history here tracks the first-round result.
//
// UPDATED (16 Jul 2026): extended through 2024, and 2028 is included
// pre-emptively. 2020/2024 were originally missing here not by design —
// this route predated their seeding — now that both are fully seeded
// (confirmed: Seed 14 populated registeredVoters for all 276/276
// constituencies on both races), there was no remaining reason to exclude
// them. 2028 has no Election row yet; the existing "no election found"
// branch below already handles that gracefully (pushes a null-filled
// year, same as it always did for gaps), so 2028 activates automatically
// the moment that election and its results are seeded — no code change
// needed then.
const TRACKED_ELECTIONS = ["1996", "2000", "2004", "2008", "2012", "2016", "2020", "2024", "2028"];

// GET /results/history/:constituencyId?type=PARLIAMENTARY|PRESIDENTIAL —
// the winning party for this constituency across every real, gazetted
// election on record (`history`), the win tally and swing-seat
// classification (`tally`/`isSwingSeat`), AND — new as of 16 Jul 2026 —
// a `trend` object of per-party vote-share point series (NDC/NPP/Others),
// same shape as /map-dashboard/trend's constituency scope, reusing that
// same proven aggregation logic rather than reinventing it. This is what
// the frontend's HistoryTrendChart actually needs to render the Hist.
// Trend tab's line chart — its absence here (this route never sent
// `trend`, only `history`) was the root cause of a real production crash.
router.get("/history/:constituencyId", asyncHandler(async (req, res) => {
  const constituencyId = requireString(req.params.constituencyId, "constituencyId");
  const type = (req.query.type ? String(req.query.type).toUpperCase() : "PARLIAMENTARY") as "PARLIAMENTARY" | "PRESIDENTIAL";

  const constituency = await prisma.constituency.findUnique({ where: { id: constituencyId }, select: { name: true } });
  if (!constituency) throw new ApiError(404, "Constituency not found");

  const elections = await prisma.election.findMany({ where: { code: { in: TRACKED_ELECTIONS } } });
  const electionByCode = new Map(elections.map((e) => [e.code, e]));
  const electionIds = elections.map((e) => e.id);

  // Single bulk query for every tracked year's result — not one query per
  // year — carrying the full candidate vote list (needed for trend), not
  // just the winner (needed for history/tally).
  const results = await prisma.constituencyResult.findMany({
    where: { electionId: { in: electionIds }, electionType: type, constituencyId },
    select: {
      electionId: true,
      votes: {
        include: { candidate: { select: { fullName: true, party: { select: { abbreviation: true, colourHex: true } } } } },
        orderBy: { votes: "desc" },
      },
    },
  });
  const resultByElectionId = new Map(results.map((r) => [r.electionId, r]));

  const history: { electionCode: string; year: number; winner: { fullName: string; party: string | null; colourHex: string | null; votePct: number } | null }[] = [];
  // Kept in the same iteration for building `trend` below, without a second query.
  const candidatesByYear: { electionCode: string; year: number; candidates: { party: string | null; colourHex: string | null; votePct: number }[] }[] = [];

  for (const code of TRACKED_ELECTIONS) {
    const election = electionByCode.get(code);
    if (!election) { history.push({ electionCode: code, year: Number(code), winner: null }); continue; }

    const result = resultByElectionId.get(election.id);
    const votes = result?.votes ?? [];
    const winnerVote = votes[0];

    history.push({
      electionCode: code,
      year: election.year,
      winner: winnerVote
        ? {
            fullName: winnerVote.candidate.fullName,
            party: winnerVote.candidate.party?.abbreviation ?? null,
            colourHex: winnerVote.candidate.party?.colourHex ?? null,
            votePct: winnerVote.voteShare ? Number(winnerVote.voteShare) : 0,
          }
        : null,
    });

    candidatesByYear.push({
      electionCode: code,
      year: election.year,
      candidates: votes.map((v) => ({
        party: v.candidate.party?.abbreviation ?? null,
        colourHex: v.candidate.party?.colourHex ?? null,
        votePct: v.voteShare ? Number(v.voteShare) : 0,
      })),
    });
  }

  // Tally wins per party — real count, whatever it actually is (not forced
  // to any fixed total). Only counts elections where we actually have data.
  const winsByParty = new Map<string, number>();
  let electionsWithData = 0;
  for (const h of history) {
    if (!h.winner) continue;
    electionsWithData++;
    const key = h.winner.party ?? "Independent";
    winsByParty.set(key, (winsByParty.get(key) ?? 0) + 1);
  }
  const tally = [...winsByParty.entries()].sort((a, b) => b[1] - a[1]).map(([party, wins]) => ({ party, wins }));
  const isSwingSeat = tally.length >= 2 && tally[0].wins - tally[1].wins <= 1;

  // Trend: NDC/NPP/Others vote-share point series — same construction as
  // /map-dashboard/trend's constituency scope.
  const trend = {
    NDC: { colourHex: null as string | null, points: [] as { year: number; electionCode: string; votePct: number }[] },
    NPP: { colourHex: null as string | null, points: [] as { year: number; electionCode: string; votePct: number }[] },
    Others: { colourHex: null as string | null, points: [] as { year: number; electionCode: string; votePct: number }[] },
  };
  for (const y of candidatesByYear) {
    if (y.candidates.length === 0) continue;
    let othersPct = 0, sawOthers = false;
    for (const c of y.candidates) {
      if (c.party === "NDC") { trend.NDC.colourHex = c.colourHex; trend.NDC.points.push({ year: y.year, electionCode: y.electionCode, votePct: c.votePct }); }
      else if (c.party === "NPP") { trend.NPP.colourHex = c.colourHex; trend.NPP.points.push({ year: y.year, electionCode: y.electionCode, votePct: c.votePct }); }
      else { othersPct += c.votePct; sawOthers = true; }
    }
    if (sawOthers) trend.Others.points.push({ year: y.year, electionCode: y.electionCode, votePct: Math.round(othersPct * 100) / 100 });
  }

  res.json({
    constituency: constituency.name,
    electionType: type,
    history,
    tally,
    electionsWithData,
    isSwingSeat,
    trend,
  });
}));

export default router;
