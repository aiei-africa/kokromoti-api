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
// UPDATED (16 Jul 2026, first pass): extended through 2024, and 2028 is
// included pre-emptively. 2020/2024 were originally missing here not by
// design — this route predated their seeding — now that both are fully
// seeded (Seed 14 populated registeredVoters for all 276/276 constituencies
// on both races), there was no remaining reason to exclude them. 2028 has
// no Election row yet; the existing "no election found" branch below
// already handles that gracefully (pushes a null-filled year, same as it
// always did for gaps), so 2028 activates automatically the moment that
// election and its results are seeded — no code change needed then.
//
// UPDATED (16 Jul 2026, second pass): every `history[]` entry now also
// carries the full per-year detail the frontend's Hist. Trend tooltip
// actually reads — `candidates` (every candidate, not just the winner),
// `margin`, and the real vote-accounting fields (`registeredVoters`,
// `totalCast`, `validVotes`, `rejectedBallots`, `turnoutPct`,
// `stationsReporting`, `stationsTotal`, `notes`) straight off the
// ConstituencyResult row. This route previously sent only `{ electionCode,
// year, winner }` per entry — the tooltip expected far more, causing a
// real production crash on every point tap. All of this is real, final,
// seeded data (ConstituencyResult already has every one of these columns)
// — nothing here is estimated or provisional. Per standing instruction (16
// Jul 2026): no data in Kokromoti is ever presented as provisional or
// estimated — there is no `provisional` field anywhere in the schema, and
// this route does not invent one.
const TRACKED_ELECTIONS = ["1996", "2000", "2004", "2008", "2012", "2016", "2020", "2024", "2028"];

interface CandidateDetail {
  fullName: string;
  party: string | null;
  colourHex: string | null;
  votes: number;
  votePct: number;
}

// GET /results/history/:constituencyId?type=PARLIAMENTARY|PRESIDENTIAL —
// full election-by-election detail for this constituency: the winning
// party (`history[].winner`, used for the win tally/swing-seat
// classification), the complete candidate breakdown and vote-accounting
// detail per year (`history[].candidates`/`.margin`/etc — what the Hist.
// Trend tooltip renders), and a `trend` object of per-party vote-share
// point series (NDC/NPP/Others, same construction as
// /map-dashboard/trend's constituency scope) for the line chart itself.
router.get("/history/:constituencyId", asyncHandler(async (req, res) => {
  const constituencyId = requireString(req.params.constituencyId, "constituencyId");
  const type = (req.query.type ? String(req.query.type).toUpperCase() : "PARLIAMENTARY") as "PARLIAMENTARY" | "PRESIDENTIAL";

  const constituency = await prisma.constituency.findUnique({ where: { id: constituencyId }, select: { name: true } });
  if (!constituency) throw new ApiError(404, "Constituency not found");

  const elections = await prisma.election.findMany({ where: { code: { in: TRACKED_ELECTIONS } } });
  const electionByCode = new Map(elections.map((e) => [e.code, e]));
  const electionIds = elections.map((e) => e.id);

  // Single bulk query for every tracked year's result — not one query per
  // year — carrying the full candidate vote list plus every vote-accounting
  // field the tooltip needs.
  const results = await prisma.constituencyResult.findMany({
    where: { electionId: { in: electionIds }, electionType: type, constituencyId },
    select: {
      electionId: true,
      registeredVoters: true,
      totalCast: true,
      validVotes: true,
      rejectedBallots: true,
      turnoutPct: true,
      stationsReporting: true,
      stationsTotal: true,
      notes: true,
      votes: {
        include: { candidate: { select: { fullName: true, party: { select: { abbreviation: true, colourHex: true } } } } },
        orderBy: { votes: "desc" },
      },
    },
  });
  const resultByElectionId = new Map(results.map((r) => [r.electionId, r]));

  interface HistoryEntry {
    electionCode: string;
    year: number;
    winner: { fullName: string; party: string | null; colourHex: string | null; votePct: number } | null;
    candidates: CandidateDetail[];
    margin: number | null;
    registeredVoters: number | null;
    totalCast: number | null;
    validVotes: number | null;
    rejectedBallots: number | null;
    turnoutPct: number | null;
    stationsReporting: number | null;
    stationsTotal: number | null;
    notes: string | null;
  }

  const history: HistoryEntry[] = [];
  // Kept alongside `history` for building `trend` below, without a second query.
  const candidatesByYear: { electionCode: string; year: number; candidates: CandidateDetail[] }[] = [];

  for (const code of TRACKED_ELECTIONS) {
    const election = electionByCode.get(code);
    if (!election) {
      history.push({
        electionCode: code, year: Number(code), winner: null, candidates: [], margin: null,
        registeredVoters: null, totalCast: null, validVotes: null, rejectedBallots: null,
        turnoutPct: null, stationsReporting: null, stationsTotal: null, notes: null,
      });
      continue;
    }

    const result = resultByElectionId.get(election.id);
    const votes = result?.votes ?? [];
    const candidates: CandidateDetail[] = votes.map((v) => ({
      fullName: v.candidate.fullName,
      party: v.candidate.party?.abbreviation ?? null,
      colourHex: v.candidate.party?.colourHex ?? null,
      votes: v.votes,
      votePct: v.voteShare ? Number(v.voteShare) : 0,
    }));
    const winnerVote = votes[0];
    const margin = candidates.length >= 2 ? Math.round((candidates[0].votePct - candidates[1].votePct) * 100) / 100 : null;

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
      candidates,
      margin,
      registeredVoters: result?.registeredVoters ?? null,
      totalCast: result?.totalCast ?? null,
      validVotes: result?.validVotes ?? null,
      rejectedBallots: result?.rejectedBallots ?? null,
      turnoutPct: result?.turnoutPct ? Number(result.turnoutPct) : null,
      stationsReporting: result?.stationsReporting ?? null,
      stationsTotal: result?.stationsTotal ?? null,
      notes: result?.notes ?? null,
    });

    candidatesByYear.push({ electionCode: code, year: election.year, candidates });
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
