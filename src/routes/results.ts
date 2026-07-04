import { Router } from "express";
import { prisma } from "../lib/prisma";
import { asyncHandler, ApiError } from "../middleware/errorHandler";
import { requireString } from "../lib/params";

const router = Router();

async function findElection(code: string) {
  const election = await prisma.election.findFirst({ where: { code } });
  if (!election) throw new ApiError(404, `Election ${code} not found`);
  return election;
}

// GET /results/presidential/:electionCode — national roll-up across all constituencies
router.get("/presidential/:electionCode", asyncHandler(async (req, res) => {
  const election = await findElection(requireString(req.params.electionCode, "electionCode"));

  const votes = await prisma.constituencyResultVote.groupBy({
    by: ["candidateId"],
    where: { constituencyResult: { electionId: election.id, electionType: "PRESIDENTIAL" } },
    _sum: { votes: true },
  });

  const candidateIds = votes.map((v) => v.candidateId);
  const candidates = await prisma.candidate.findMany({
    where: { id: { in: candidateIds } },
    select: { id: true, fullName: true, party: { select: { abbreviation: true, colourHex: true } } },
  });
  const candById = new Map(candidates.map((c) => [c.id, c]));

  const total = votes.reduce((s, v) => s + (v._sum.votes ?? 0), 0);
  const results = votes
    .map((v) => ({
      candidate: candById.get(v.candidateId),
      votes: v._sum.votes ?? 0,
      votePct: total ? Number((((v._sum.votes ?? 0) / total) * 100).toFixed(2)) : 0,
    }))
    .sort((a, b) => b.votes - a.votes);

  res.json({ election: election.code, totalValidVotes: total, results });
}));

// GET /results/presidential/:electionCode/:constituencyId — single-seat detail
router.get("/presidential/:electionCode/:constituencyId", asyncHandler(async (req, res) => {
  const election = await findElection(requireString(req.params.electionCode, "electionCode"));
  const constituencyId = requireString(req.params.constituencyId, "constituencyId");
  const result = await prisma.constituencyResult.findFirst({
    where: { electionId: election.id, electionType: "PRESIDENTIAL", constituencyId },
    include: {
      constituency: { select: { name: true, ecCode: true } },
      votes: {
        include: { candidate: { select: { fullName: true, party: { select: { abbreviation: true, colourHex: true } } } } },
        orderBy: { votes: "desc" },
      },
    },
  });
  if (!result) throw new ApiError(404, "No presidential result for this constituency/election");
  res.json(result);
}));

// GET /results/parliamentary/:electionCode — every seat's declared winner
router.get("/parliamentary/:electionCode", asyncHandler(async (req, res) => {
  const election = await findElection(requireString(req.params.electionCode, "electionCode"));
  const results = await prisma.constituencyResult.findMany({
    where: { electionId: election.id, electionType: "PARLIAMENTARY" },
    include: {
      constituency: { select: { name: true, ecCode: true } },
      votes: {
        include: { candidate: { select: { fullName: true, party: { select: { abbreviation: true, colourHex: true } } } } },
        orderBy: { votes: "desc" },
        take: 1,
      },
    },
    orderBy: { constituency: { name: "asc" } },
  });
  res.json(results.map((r) => ({
    constituency: r.constituency,
    status: r.status,
    winner: r.votes[0] ?? null,
    totalCast: r.totalCast,
    turnoutPct: r.turnoutPct,
  })));
}));

// GET /results/parliamentary/:electionCode/summary — seat count by party, the
// national "who won" headline number. Deliberately a separate, isolated
// aggregation function (not inlined) so the exact same logic can be reused
// as the write-path into NationalResult once 2028's live pipeline needs
// pre-computed, stored aggregates instead of live queries — see the
// architecture note on this in the migration record.
async function computeParliamentarySeatSummary(electionId: string) {
  const results = await prisma.constituencyResult.findMany({
    where: { electionId, electionType: "PARLIAMENTARY" },
    include: {
      votes: {
        include: { candidate: { select: { party: { select: { abbreviation: true, colourHex: true } } } } },
        orderBy: { votes: "desc" },
        take: 1,
      },
    },
  });

  const seatsByParty = new Map<string, { abbreviation: string; colourHex: string | null; seats: number }>();
  let declaredSeats = 0, independentSeats = 0, undeclaredSeats = 0;

  for (const r of results) {
    const winner = r.votes[0];
    if (!winner) { undeclaredSeats++; continue; }
    declaredSeats++;
    const party = winner.candidate.party;
    if (!party) { independentSeats++; continue; }
    const existing = seatsByParty.get(party.abbreviation);
    if (existing) existing.seats++;
    else seatsByParty.set(party.abbreviation, { abbreviation: party.abbreviation, colourHex: party.colourHex, seats: 1 });
  }

  const totalSeats = results.length;
  const majorityThreshold = Math.floor(totalSeats / 2) + 1;
  const parties = [...seatsByParty.values()].sort((a, b) => b.seats - a.seats);
  const hasMajority = parties.length > 0 && parties[0].seats >= majorityThreshold;

  return {
    totalSeats, declaredSeats, undeclaredSeats, independentSeats,
    majorityThreshold, hasMajority,
    leadingParty: parties[0] ?? null,
    parties,
  };
}

router.get("/parliamentary/:electionCode/summary", asyncHandler(async (req, res) => {
  const election = await findElection(requireString(req.params.electionCode, "electionCode"));
  const summary = await computeParliamentarySeatSummary(election.id);
  res.json({ election: election.code, ...summary });
}));

// GET /results/parliamentary/:electionCode/:constituencyId — single-seat full breakdown
router.get("/parliamentary/:electionCode/:constituencyId", asyncHandler(async (req, res) => {
  const election = await findElection(requireString(req.params.electionCode, "electionCode"));
  const constituencyId = requireString(req.params.constituencyId, "constituencyId");
  const result = await prisma.constituencyResult.findFirst({
    where: { electionId: election.id, electionType: "PARLIAMENTARY", constituencyId },
    include: {
      constituency: { select: { name: true, ecCode: true } },
      votes: {
        include: { candidate: { select: { fullName: true, party: { select: { abbreviation: true, colourHex: true } } } } },
        orderBy: { votes: "desc" },
      },
    },
  });
  if (!result) throw new ApiError(404, "No parliamentary result for this constituency/election");
  res.json(result);
}));

export default router;
