import { Router } from "express";
import { prisma } from "../lib/prisma";

const router = Router();

// GET /candidates?election=2016&constituency=<id>&party=NDC
router.get("/", async (req, res, next) => {
  try {
    const { election, constituency, party, type } = req.query;
    const where: any = {};
    if (election) where.election = { code: String(election) };
    if (constituency) where.constituencyId = String(constituency);
    if (party) where.party = { abbreviation: String(party) };
    if (type) where.electionType = String(type).toUpperCase();

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
  } catch (e) { next(e); }
});

export default router;
