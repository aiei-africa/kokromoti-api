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
    select: { id: true, fullName: true, photoUrl: true, party: { select: { abbreviation: true, colourHex: true } } },
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

// GET /results/presidential/:electionCode/region/:regionId — same roll-up
// as the national route above, scoped to one region's constituencies.
// Ghana's national summary and Regions' per-region summary must use
// identical logic — this mirrors it exactly rather than re-deriving a
// different calculation for the regional case.
router.get("/presidential/:electionCode/region/:regionId", asyncHandler(async (req, res) => {
  const election = await findElection(requireString(req.params.electionCode, "electionCode"));
  const regionId = requireString(req.params.regionId, "regionId");

  const votes = await prisma.constituencyResultVote.groupBy({
    by: ["candidateId"],
    where: { constituencyResult: { electionId: election.id, electionType: "PRESIDENTIAL", constituency: { regionId } } },
    _sum: { votes: true },
  });

  const candidateIds = votes.map((v) => v.candidateId);
  const candidates = await prisma.candidate.findMany({
    where: { id: { in: candidateIds } },
    select: { id: true, fullName: true, photoUrl: true, party: { select: { abbreviation: true, colourHex: true } } },
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

// GET /results/presidential/:electionCode/by-constituency — every seat's FULL
// candidate breakdown in one call.
router.get("/presidential/:electionCode/by-constituency", asyncHandler(async (req, res) => {
  const election = await findElection(requireString(req.params.electionCode, "electionCode"));
  const results = await prisma.constituencyResult.findMany({
    where: { electionId: election.id, electionType: "PRESIDENTIAL" },
    include: {
      constituency: { select: { id: true, name: true, ecCode: true } },
      votes: {
        include: { candidate: { select: { fullName: true, photoUrl: true, party: { select: { abbreviation: true, colourHex: true } } } } },
        orderBy: { votes: "desc" },
      },
    },
    orderBy: { constituency: { name: "asc" } },
  });
  res.json(results.map((r) => ({
    constituency: r.constituency,
    status: r.status,
    totalCast: r.totalCast,
    turnoutPct: r.turnoutPct ? Number(r.turnoutPct) : null,
    results: r.votes.map((v) => ({
      candidate: { fullName: v.candidate.fullName, photoUrl: v.candidate.photoUrl, party: v.candidate.party },
      votes: v.votes,
      votePct: v.voteShare ? Number(v.voteShare) : 0,
    })),
  })));
}));

// GET /results/presidential/:electionCode/:constituencyId — single-seat detail.
// Explicitly remapped (not a raw res.json(result) passthrough) for two
// reasons: Prisma's Decimal fields (turnoutPct, voteShare) serialize to JSON
// as STRINGS via their own toJSON(), not numbers — calling .toFixed() on
// that string throws "is not a function" on the frontend. And the raw field
// is named voteShare, not votePct, which the frontend actually expects.
router.get("/presidential/:electionCode/:constituencyId", asyncHandler(async (req, res) => {
  const election = await findElection(requireString(req.params.electionCode, "electionCode"));
  const constituencyId = requireString(req.params.constituencyId, "constituencyId");
  const result = await prisma.constituencyResult.findFirst({
    where: { electionId: election.id, electionType: "PRESIDENTIAL", constituencyId },
    include: {
      constituency: { select: { name: true, ecCode: true } },
      votes: {
        include: { candidate: { select: { fullName: true, photoUrl: true, party: { select: { abbreviation: true, colourHex: true } } } } },
        orderBy: { votes: "desc" },
      },
    },
  });
  if (!result) throw new ApiError(404, "No presidential result for this constituency/election");
  res.json({
    id: result.id,
    status: result.status,
    registeredVoters: result.registeredVoters,
    totalCast: result.totalCast,
    validVotes: result.validVotes,
    rejectedBallots: result.rejectedBallots,
    turnoutPct: result.turnoutPct ? Number(result.turnoutPct) : null,
    constituency: result.constituency,
    votes: result.votes.map((v) => ({
      candidate: { fullName: v.candidate.fullName, photoUrl: v.candidate.photoUrl, party: v.candidate.party },
      votes: v.votes,
      votePct: v.voteShare ? Number(v.voteShare) : 0,
    })),
  });
}));

// GET /results/parliamentary/:electionCode — every seat, FULL candidate breakdown
router.get("/parliamentary/:electionCode", asyncHandler(async (req, res) => {
  const election = await findElection(requireString(req.params.electionCode, "electionCode"));
  const results = await prisma.constituencyResult.findMany({
    where: { electionId: election.id, electionType: "PARLIAMENTARY" },
    include: {
      constituency: { select: { id: true, name: true, ecCode: true } },
      votes: {
        include: { candidate: { select: { fullName: true, photoUrl: true, party: { select: { abbreviation: true, colourHex: true } } } } },
        orderBy: { votes: "desc" },
      },
    },
    orderBy: { constituency: { name: "asc" } },
  });
  res.json(results.map((r) => ({
    constituency: r.constituency,
    status: r.status,
    totalCast: r.totalCast,
    turnoutPct: r.turnoutPct ? Number(r.turnoutPct) : null,
    results: r.votes.map((v) => ({
      candidate: { fullName: v.candidate.fullName, photoUrl: v.candidate.photoUrl, party: v.candidate.party },
      votes: v.votes,
      votePct: v.voteShare ? Number(v.voteShare) : 0,
    })),
  })));
}));

// GET /results/parliamentary/:electionCode/summary — seat count by party
async function computeParliamentarySeatSummary(electionId: string, regionId?: string) {
  const results = await prisma.constituencyResult.findMany({
    where: { electionId, electionType: "PARLIAMENTARY", ...(regionId ? { constituency: { regionId } } : {}) },
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

async function computeParliamentaryVotesByParty(electionId: string, regionId?: string) {
  const votes = await prisma.constituencyResultVote.groupBy({
    by: ["candidateId"],
    where: {
      constituencyResult: {
        electionId, electionType: "PARLIAMENTARY",
        ...(regionId ? { constituency: { regionId } } : {}),
      },
    },
    _sum: { votes: true },
  });

  const candidateIds = votes.map((v) => v.candidateId);
  const candidates = await prisma.candidate.findMany({
    where: { id: { in: candidateIds } },
    select: { id: true, partyId: true, party: { select: { name: true, abbreviation: true, colourHex: true } } },
  });
  const partyByCandidateId = new Map(candidates.map((c) => [c.id, c.party]));

  const sumsByParty = new Map<string, { name: string; abbreviation: string; colourHex: string | null; votes: number }>();
  for (const v of votes) {
    const party = partyByCandidateId.get(v.candidateId);
    const key = party?.abbreviation ?? "Independent";
    const existing = sumsByParty.get(key);
    const add = v._sum.votes ?? 0;
    if (existing) existing.votes += add;
    else sumsByParty.set(key, { name: party?.name ?? "Independent candidates", abbreviation: key, colourHex: party?.colourHex ?? null, votes: add });
  }

  const total = [...sumsByParty.values()].reduce((s, p) => s + p.votes, 0);
  // Shaped to match CandidateResult exactly (candidate.fullName = the
  // party's full name, standing in for "the candidate" at this scope) so
  // the frontend's existing CandidateResultRow renders this with zero
  // changes — same component Presidential already uses.
  const results = [...sumsByParty.values()]
    .sort((a, b) => b.votes - a.votes)
    .map((p) => ({
      candidate: { fullName: p.name, party: { abbreviation: p.abbreviation, colourHex: p.colourHex } },
      votes: p.votes,
      votePct: total ? Number(((p.votes / total) * 100).toFixed(2)) : 0,
    }));

  return { totalValidVotes: total, results };
}

// GET /results/parliamentary/:electionCode/votes-by-party — national total
// votes summed by party across every parliamentary candidate. Distinct
// from /summary above (seats won) — vote share and seat share genuinely
// diverge under FPTP; both are real, legitimate figures.
router.get("/parliamentary/:electionCode/votes-by-party", asyncHandler(async (req, res) => {
  const election = await findElection(requireString(req.params.electionCode, "electionCode"));
  const data = await computeParliamentaryVotesByParty(election.id);
  res.json({ election: election.code, ...data });
}));

// GET /results/parliamentary/:electionCode/region/:regionId/summary — same
// real seat-tally logic as the national summary above, scoped to one
// region. NOT a sum of individual MP candidates' votes (that's meaningless
// across ~5-30 different people) — a genuine count of seats won per party
// within the region, same method already proven for the national figure
// and for the map's regional/national trend chart.
router.get("/parliamentary/:electionCode/region/:regionId/summary", asyncHandler(async (req, res) => {
  const election = await findElection(requireString(req.params.electionCode, "electionCode"));
  const regionId = requireString(req.params.regionId, "regionId");
  const summary = await computeParliamentarySeatSummary(election.id, regionId);
  res.json({ election: election.code, ...summary });
}));

// GET /results/parliamentary/:electionCode/region/:regionId/votes-by-party
// — same real metric as the national route above, scoped to one region.
router.get("/parliamentary/:electionCode/region/:regionId/votes-by-party", asyncHandler(async (req, res) => {
  const election = await findElection(requireString(req.params.electionCode, "electionCode"));
  const regionId = requireString(req.params.regionId, "regionId");
  const data = await computeParliamentaryVotesByParty(election.id, regionId);
  res.json({ election: election.code, ...data });
}));

// GET /results/parliamentary/:electionCode/:constituencyId — single-seat full
// breakdown. Same explicit remapping as the presidential version above, for
// the same reason (Decimal-as-string, voteShare/votePct naming).
router.get("/parliamentary/:electionCode/:constituencyId", asyncHandler(async (req, res) => {
  const election = await findElection(requireString(req.params.electionCode, "electionCode"));
  const constituencyId = requireString(req.params.constituencyId, "constituencyId");
  const result = await prisma.constituencyResult.findFirst({
    where: { electionId: election.id, electionType: "PARLIAMENTARY", constituencyId },
    include: {
      constituency: { select: { name: true, ecCode: true } },
      votes: {
        include: { candidate: { select: { fullName: true, photoUrl: true, party: { select: { abbreviation: true, colourHex: true } } } } },
        orderBy: { votes: "desc" },
      },
    },
  });
  if (!result) throw new ApiError(404, "No parliamentary result for this constituency/election");
  res.json({
    id: result.id,
    status: result.status,
    registeredVoters: result.registeredVoters,
    totalCast: result.totalCast,
    validVotes: result.validVotes,
    rejectedBallots: result.rejectedBallots,
    turnoutPct: result.turnoutPct ? Number(result.turnoutPct) : null,
    constituency: result.constituency,
    votes: result.votes.map((v) => ({
      candidate: { fullName: v.candidate.fullName, photoUrl: v.candidate.photoUrl, party: v.candidate.party },
      votes: v.votes,
      votePct: v.voteShare ? Number(v.voteShare) : 0,
    })),
  });
}));

export default router;
