import { Router } from "express";
import { prisma } from "../lib/prisma";
import { asyncHandler } from "../middleware/errorHandler";
import { asString } from "../lib/params";

const router = Router();

// GET /candidates?election=2016&constituency=<id>&party=NDC&type=PARLIAMENTARY
router.get("/", asyncHandler(async (req, res) => {
  const election = asString(req.query.election);
  const constituency = asString(req.query.constituency);
  const party = asString(req.query.party);
  const type = asString(req.query.type);

  const where: Record<string, unknown> = {};
  if (election) where.election = { code: election };
  if (constituency) where.constituencyId = constituency;
  if (party) where.party = { abbreviation: party };
  if (type) where.electionType = type.toUpperCase();

  const candidates = await prisma.candidate.findMany({
    where,
    select: {
      id: true, fullName: true, gender: true, age: true, electionType: true, isIncumbent: true,
      election: { select: { code: true } },
      constituency: { select: { name: true } },
      party: { select: { abbreviation: true, colourHex: true } },
    },
    orderBy: { fullName: "asc" },
    take: 500,
  });
  res.json(candidates);
}));

export default router;
