import { Router } from "express";
import { prisma } from "../lib/prisma";
import { asyncHandler, ApiError } from "../middleware/errorHandler";

const router = Router();

async function findElection(code: string) {
  const election = await prisma.election.findFirst({ where: { code } });
  if (!election) throw new ApiError(404, `Election ${code} not found`);
  return election;
}

// GET /results/presidential/:electionCode — national roll-up across all constituencies
router.get("/presidential/:electionCode", asyncHandler(async (req, res) => {
  const election = await findElection(req.params.electionCode);

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
  const election = await findElection(req.params.electionCode);
  const result = await prisma.constituencyResult.findFirst({
    where: { electionId: election.id, electionType: "PRESIDENTIAL", constituencyId: req.params.constituencyId },
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
  const election = await findElection(req.params.electionCode);
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

// GET /results/parliamentary/:electionCode/:constituencyId — single-seat full breakdown
router.get("/parliamentary/:electionCode/:constituencyId", asyncHandler(async (req, res) => {
  const election = await findElection(req.params.electionCode);
  const result = await prisma.constituencyResult.findFirst({
    where: { electionId: election.id, electionType: "PARLIAMENTARY", constituencyId: req.params.constituencyId },
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
