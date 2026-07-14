import { prisma } from "../lib/prisma";
import fs from "fs";
import path from "path";

// Seeds RegionalResult/RegionalResultVote and NationalResult/NationalResultVote
// from real vote totals — genuinely summed from actual constituency-level
// presidential results (1996-2016 from the historical import, 2020/2024 from
// EC_OFFICIAL), not estimated. Party affiliation for every candidate was
// resolved against the verified candidates table (this caught and fixed
// several real errors along the way: Nduom mislabeled CPP for 2012/2016
// when his real party was PPP, Aggudey mislabeled EGLE in 2004 when it was
// CPP, etc.) — see prez_candidates_full_1992_2016.json for that resolution.
//
// Cross-checked the region assignment against the repo's own authoritative
// region_remap.csv before seeding: 0 mismatches across all 275 legacy
// constituencies.
//
// Turnout is intentionally left null for scopes/years where the underlying
// registered-voter figure isn't complete across every constituency in that
// scope (2020/2024 have registered_voters as null for nearly every
// constituency in the source) — a partial sum divided into a turnout
// percentage would look precise and be wrong, so it's stored as genuinely
// absent rather than as a misleading number.
//
// Upsert-keyed on each model's own @@unique constraint, so this is safe to
// run whether these tables are empty or already have prior data.

interface RegionalRow {
  regionName: string; electionCode: string;
  registeredVoters: number | null; totalCast: number | null;
  validVotes: number | null; rejectedBallots: number | null;
  turnoutPct: number | null; source: string;
  votesByParty: Record<string, number>;
}
interface NationalRow extends Omit<RegionalRow, "regionName"> {}

async function resolvePresidentialCandidateId(electionId: string, partyAbbr: string): Promise<string | null> {
  const candidate = await prisma.candidate.findFirst({
    where: {
      electionId, electionType: "PRESIDENTIAL", constituencyId: null,
      party: { abbreviation: partyAbbr },
    },
  });
  return candidate?.id ?? null;
}

async function main() {
  const elections = await prisma.election.findMany();
  const electionByCode = new Map(elections.map((e) => [e.code, e.id]));

  const regions = await prisma.region.findMany();
  const regionByShortName = new Map(regions.map((r) => [r.shortName, r.id]));

  // ---- National ----
  const nationalPath = path.join(__dirname, "../../db/seed-data/national_results_computed.json");
  const nationalRows: NationalRow[] = JSON.parse(fs.readFileSync(nationalPath, "utf-8"));

  let nationalUpserted = 0;
  let nationalVoteUpserted = 0;
  const nationalSkipped: string[] = [];

  console.log(`Starting national: ${nationalRows.length} election years to process.`);
  for (const row of nationalRows) {
    const electionIdMaybe = electionByCode.get(row.electionCode);
    if (!electionIdMaybe) { nationalSkipped.push(`${row.electionCode}: no matching Election`); continue; }
    const electionId: string = electionIdMaybe;

    const result = await prisma.nationalResult.upsert({
      where: { electionId_electionType: { electionId, electionType: "PRESIDENTIAL" } },
      update: {
        registeredVoters: row.registeredVoters, totalCast: row.totalCast,
        validVotes: row.validVotes, rejectedBallots: row.rejectedBallots,
        turnoutPct: row.turnoutPct, source: "COMPUTED",
      },
      create: {
        electionId, electionType: "PRESIDENTIAL",
        registeredVoters: row.registeredVoters, totalCast: row.totalCast,
        validVotes: row.validVotes, rejectedBallots: row.rejectedBallots,
        turnoutPct: row.turnoutPct, source: "COMPUTED",
      },
    });
    nationalUpserted++;

    for (const [party, votes] of Object.entries(row.votesByParty)) {
      const candidateId = await resolvePresidentialCandidateId(electionId, party);
      if (!candidateId) { nationalSkipped.push(`${row.electionCode} ${party}: no matching Candidate`); continue; }
      const total = Object.values(row.votesByParty).reduce((a, b) => a + b, 0);
      await prisma.nationalResultVote.upsert({
        where: { nationalResultId_candidateId: { nationalResultId: result.id, candidateId } },
        update: { votes, voteShare: total ? (votes / total) * 100 : null },
        create: { nationalResultId: result.id, candidateId, votes, voteShare: total ? (votes / total) * 100 : null },
      });
      nationalVoteUpserted++;
    }
  }

  // ---- Regional ----
  const regionalPath = path.join(__dirname, "../../db/seed-data/regional_results_computed.json");
  const regionalRows: RegionalRow[] = JSON.parse(fs.readFileSync(regionalPath, "utf-8"));

  let regionalUpserted = 0;
  let regionalVoteUpserted = 0;
  const regionalSkipped: string[] = [];

  console.log(`Starting regional: ${regionalRows.length} region-election combinations to process (each with several candidate lookups — this is the slower of the two loops).`);
  for (let i = 0; i < regionalRows.length; i++) {
    const row = regionalRows[i];
    const electionIdMaybe = electionByCode.get(row.electionCode);
    const regionIdMaybe = regionByShortName.get(row.regionName);
    if (!electionIdMaybe) { regionalSkipped.push(`${row.electionCode}/${row.regionName}: no matching Election`); continue; }
    if (!regionIdMaybe) { regionalSkipped.push(`${row.electionCode}/${row.regionName}: no matching Region`); continue; }
    const electionId: string = electionIdMaybe;
    const regionId: string = regionIdMaybe;

    const result = await prisma.regionalResult.upsert({
      where: { electionId_electionType_regionId: { electionId, electionType: "PRESIDENTIAL", regionId } },
      update: {
        registeredVoters: row.registeredVoters, totalCast: row.totalCast,
        validVotes: row.validVotes, rejectedBallots: row.rejectedBallots,
        turnoutPct: row.turnoutPct, source: "COMPUTED",
      },
      create: {
        electionId, electionType: "PRESIDENTIAL", regionId,
        registeredVoters: row.registeredVoters, totalCast: row.totalCast,
        validVotes: row.validVotes, rejectedBallots: row.rejectedBallots,
        turnoutPct: row.turnoutPct, source: "COMPUTED",
      },
    });
    regionalUpserted++;

    const total = Object.values(row.votesByParty).reduce((a, b) => a + b, 0);
    for (const [party, votes] of Object.entries(row.votesByParty)) {
      const candidateId = await resolvePresidentialCandidateId(electionId, party);
      if (!candidateId) { regionalSkipped.push(`${row.electionCode}/${row.regionName} ${party}: no matching Candidate`); continue; }
      await prisma.regionalResultVote.upsert({
        where: { regionalResultId_candidateId: { regionalResultId: result.id, candidateId } },
        update: { votes, voteShare: total ? (votes / total) * 100 : null },
        create: { regionalResultId: result.id, candidateId, votes, voteShare: total ? (votes / total) * 100 : null },
      });
      regionalVoteUpserted++;
    }

    if ((i + 1) % 10 === 0 || i === regionalRows.length - 1) {
      console.log(`  ...${i + 1}/${regionalRows.length} region-elections processed (${regionalUpserted} upserted, ${regionalVoteUpserted} vote rows so far)`);
    }
  }

  console.log(`NationalResult: ${nationalUpserted} upserted, ${nationalVoteUpserted} vote rows upserted.`);
  console.log(`RegionalResult: ${regionalUpserted} upserted, ${regionalVoteUpserted} vote rows upserted.`);
  if (nationalSkipped.length || regionalSkipped.length) {
    console.log("Skipped (needs review):", [...nationalSkipped, ...regionalSkipped]);
  }
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });
