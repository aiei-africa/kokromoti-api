import { PrismaClient } from "@prisma/client";
import * as fs from "fs";
import * as path from "path";

const prisma = new PrismaClient();

interface GhCandidate { name: string; party: string; votes: number; }
interface GhConstituency {
  constituency: string; region_id: number;
  total_valid_votes: number; total_rejected_ballots: number; total_votes_cast: number;
  candidates: GhCandidate[];
}

async function main() {
  console.log("── Comparing ghelection.com 2016 Parliamentary data against what's already in the database ──\n");

  const election = await prisma.election.findFirst({ where: { code: "2016" } });
  if (!election) throw new Error("2016 election not found");

  const dataPath = path.join(__dirname, "../../db/seed-data/ghelection_2016_parl_resolved.json");
  const ghData: GhConstituency[] = JSON.parse(fs.readFileSync(dataPath, "utf-8"));

  const existingResults = await prisma.constituencyResult.findMany({
    where: { electionId: election.id, electionType: "PARLIAMENTARY" },
    include: {
      constituency: { select: { name: true } },
      votes: { include: { candidate: { include: { party: true } } } },
    },
  });
  console.log(`Existing 2016 PARLIAMENTARY results in DB: ${existingResults.length}`);

  const existingByName = new Map(existingResults.map((r) => [r.constituency.name.trim().toUpperCase(), r]));
  const ghByName = new Map(ghData.map((g) => [g.constituency.trim().toUpperCase(), g]));

  let overlap = 0, exactWinnerMatch = 0, winnerMismatch = 0, validVotesExactMatch = 0, validVotesClose = 0, validVotesFarOff = 0;
  const mismatchDetails: string[] = [];

  for (const [name, existing] of existingByName) {
    const gh = ghByName.get(name);
    if (!gh) continue; // this constituency isn't in the ghelection data (shouldn't happen given 275/275, but guard anyway)
    overlap++;

    // existing DB winner
    const existingWinner = existing.votes.reduce((a, b) => (b.votes > a.votes ? b : a));
    const existingWinnerParty = existingWinner.candidate.party?.abbreviation ?? "IND";

    // ghelection winner
    const ghWinner = gh.candidates.reduce((a, b) => (b.votes > a.votes ? b : a));

    if (existingWinnerParty === ghWinner.party) exactWinnerMatch++;
    else {
      winnerMismatch++;
      mismatchDetails.push(
        `  WINNER MISMATCH: ${name} — DB says ${existingWinnerParty} (${existingWinner.candidate.fullName}, ${existingWinner.votes} votes), ghelection says ${ghWinner.party} (${ghWinner.name}, ${ghWinner.votes} votes)`
      );
    }

    const existingValid = existing.validVotes ?? 0;
    const ghValid = gh.total_valid_votes;
    const diff = Math.abs(existingValid - ghValid);
    if (diff === 0) validVotesExactMatch++;
    else if (diff <= 50) validVotesClose++;
    else {
      validVotesFarOff++;
      mismatchDetails.push(`  VALID VOTES FAR OFF: ${name} — DB=${existingValid}, ghelection=${ghValid}, diff=${diff}`);
    }
  }

  console.log(`\nOverlapping constituencies (in both DB and ghelection data): ${overlap}`);
  console.log(`Winner matches: ${exactWinnerMatch}/${overlap}`);
  console.log(`Winner mismatches: ${winnerMismatch}/${overlap}`);
  console.log(`Valid-votes exact match: ${validVotesExactMatch}/${overlap}`);
  console.log(`Valid-votes close (within 50): ${validVotesClose}/${overlap}`);
  console.log(`Valid-votes far off (>50): ${validVotesFarOff}/${overlap}`);

  if (mismatchDetails.length) {
    console.log("\n── Mismatch details ──");
    for (const line of mismatchDetails) console.log(line);
  }

  // also report: of the 275 ghelection constituencies, how many are NEW (not in DB at all)?
  const newOnes = [...ghByName.keys()].filter((name) => !existingByName.has(name));
  console.log(`\nConstituencies in ghelection data NOT currently in DB (new coverage): ${newOnes.length}`);
}

main().catch(console.error).finally(() => prisma.$disconnect());
