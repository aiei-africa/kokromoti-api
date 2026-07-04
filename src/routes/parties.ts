import { Router } from "express";
import { prisma } from "../lib/prisma";

const router = Router();

router.get("/", async (_req, res, next) => {
  try {
    const parties = await prisma.party.findMany({
      orderBy: { abbreviation: "asc" },
      select: { id: true, name: true, abbreviation: true, colourHex: true, colourLight: true, colourBg: true, logoUrl: true },
    });
    res.json(parties);
  } catch (e) { next(e); }
});

export default router;
