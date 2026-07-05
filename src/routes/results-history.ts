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
const TRACKED_ELECTIONS = ["1996", "2000", "2004", "2008", "2012", "2016"];

// GET /results/history/:constituencyId?type=PARLIAMENTARY|PRESIDENTIAL —
// the winning party for this constituency across every real, gazetted
// election on record. Powers the drilldown's Hist. Trend tab and the
// swing-seat classification ("NDC 4 / NPP 2 in 6 elections") — built from
// actual results, not forced to match any fixed number.
router.get("/history/:constituencyId", asyncHandler(async (req, res) => {
  const constituencyId = requireString(req.params.constituencyId, "constituencyId");
  const type = (req.query.type ? String(req.query.type).toUpperCase() : "PARLIAMENTARY") as "PARLIAMENTARY" | "PRESIDENTIAL";

  const constituency = await prisma.constituency.findUnique({ where: { id: constituencyId }, select: { name: true } });
  if (!constituency) throw new ApiError(404, "Constituency not found");

  const elections = await prisma.election.findMany({ where: { code: { in: TRACKED_ELECTIONS } } });
  const electionByCode = new Map(elections.map((e) => [e.code, e]));

  const history: { electionCode: string; year: number; winner: { fullName: string; party: string | null; colourHex: string | null; votePct: number } | null }[] = [];

  for (const code of TRACKED_ELECTIONS) {
    const election = electionByCode.get(code);
    if (!election) { history.push({ electionCode: code, year: Number(code), winner: null }); continue; }

    const result = await prisma.constituencyResult.findFirst({
      where: { electionId: election.id, electionType: type, constituencyId },
      include: {
        votes: {
          include: { candidate: { select: { fullName: true, party: { select: { abbreviation: true, colourHex: true } } } } },
          orderBy: { votes: "desc" },
          take: 1,
        },
      },
    });

    const winnerVote = result?.votes[0];
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

  res.json({
    constituency: constituency.name,
    electionType: type,
    history,
    tally,
    electionsWithData,
    isSwingSeat,
  });
}));

export default router;
