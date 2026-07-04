import { Router } from "express";
import { prisma } from "../lib/prisma";
import { asyncHandler, ApiError } from "../middleware/errorHandler";

const router = Router();

router.get("/", asyncHandler(async (_req, res) => {
  const elections = await prisma.election.findMany({
    orderBy: { year: "asc" },
    include: { rounds: { select: { code: true } } },
  });
  res.json(elections);
}));

router.get("/:code", asyncHandler(async (req, res) => {
  const election = await prisma.election.findFirst({
    where: { code: req.params.code },
    include: { rounds: true, parentElection: true },
  });
  if (!election) throw new ApiError(404, "Election not found");
  res.json(election);
}));

export default router;
