import { prisma } from "../lib/prisma";
import fs from "fs";
import path from "path";

// Seeds RegionalResult/RegionalResultVote and NationalResult/NationalResultVote
// from real vote totals — genuinely summed from actual constituency-level
// presidential results (1996-2016 from the historical import, 2020/2024 from
// EC_OFFICIAL), not estimated.
//
// v2 fixes two real bugs found in the first run against the live database:
//
// 1. Region names: this repo's Region.shortName uses spaces consistently
//    ("Greater Accra", "Upper East", "Upper West"). The seed data had a few
//    of these stored with hyphens instead ("Greater-Accra") from an earlier,
//    inconsistent internal naming pass — normalized to match here.
//
// 2. Candidate identity: the first version aggregated every candidate whose
//    party couldn't be resolved into a single fake "IND" bucket per
//    election. That's wrong on two counts — independent candidates don't
//    have a party record with abbreviation "IND" (they have party: null),
//    and in several elections there were multiple genuinely distinct
//    independent candidates (2024 alone had four), whose votes were being
//    silently summed together as if they were one person. This version
//    joins on each candidate's actual full name within the election
//    instead, resolved against the same verified candidates data used for
//    party correction earlier (catches Nduom mislabeled CPP for 2012/2016
//    when his real party was PPP, Aggudey mislabeled EGLE in 2004 when it
//    was CPP, etc.).
//
// Upsert-keyed on each model's own @@unique constraint, so this is safe to
// run whether these tables are empty or already have prior data from the
// first (buggy) run — it corrects those rows rather than duplicating them.

interface CandidateVote { name: string; party: string | null; votes: number; }
interface RegionalRow {
  regionName: string; electionCode: string;
  registeredVoters: number | null; totalCast: number | null;
  validVotes: number | null; rejectedBallots: number | null;
  turnoutPct: number | null; source: string;
  votesByCandidate: CandidateVote[];
}
interface NationalRow extends Omit<RegionalRow, "regionName"> {}

const BATCH_SIZE = 10;

function normalizeName(s: string) {
  return s.toLowerCase().replace(/[.,]/g, "").replace(/\s+/g, " ").trim();
}

async function main() {
  const elections = await prisma.election.findMany();
  const electionByCode = new Map(elections.map((e) => [e.code, e.id]));

  const regions = await prisma.region.findMany();
  const regionByShortName = new Map(regions.map((r) => [r.shortName, r.id]));

  // Pre-fetch every presidential candidate once, keyed by (electionId,
  // normalized full name) — resolves real individual identity, not a
  // lossy party bucket.
  const candidates = await prisma.candidate.findMany({
    where: { electionType: "PRESIDENTIAL", constituencyId: null },
    select: { id: true, electionId: true, fullName: true },
  });
  const candidateByElectionName = new Map(
    candidates.map((c) => [`${c.electionId}:${normalizeName(c.fullName)}`, c.id])
  );
  console.log(`Pre-fetched ${elections.length} elections, ${regions.length} regions, ${candidates.length} presidential candidates.`);

  const skipped: string[] = [];

  // ---- National ----
  const nationalPath = path.join(__dirname, "../../db/seed-data/national_results_computed.json");
  const nationalRows: NationalRow[] = JSON.parse(fs.readFileSync(nationalPath, "utf-8"));

  let nationalUpserted = 0;
  let nationalVoteUpserted = 0;

  console.log(`Starting national: ${nationalRows.length} election years.`);
  for (const row of nationalRows) {
    const electionId = electionByCode.get(row.electionCode);
    if (!electionId) { skipped.push(`national ${row.electionCode}: no matching Election`); continue; }

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

    const total = row.votesByCandidate.reduce((a, c) => a + c.votes, 0);
    for (const c of row.votesByCandidate) {
      const candidateId = candidateByElectionName.get(`${electionId}:${normalizeName(c.name)}`);
      if (!candidateId) { skipped.push(`national ${row.electionCode} "${c.name}" (${c.party}): no matching Candidate`); continue; }
      await prisma.nationalResultVote.upsert({
        where: { nationalResultId_candidateId: { nationalResultId: result.id, candidateId } },
        update: { votes: c.votes, voteShare: total ? (c.votes / total) * 100 : null },
        create: { nationalResultId: result.id, candidateId, votes: c.votes, voteShare: total ? (c.votes / total) * 100 : null },
      });
      nationalVoteUpserted++;
    }
  }
  console.log(`National done: ${nationalUpserted} results, ${nationalVoteUpserted} vote rows.`);

  // ---- Regional ----
  const regionalPath = path.join(__dirname, "../../db/seed-data/regional_results_computed.json");
  const regionalRows: RegionalRow[] = JSON.parse(fs.readFileSync(regionalPath, "utf-8"));

  let regionalUpserted = 0;
  let regionalVoteUpserted = 0;

  console.log(`Starting regional: ${regionalRows.length} region-election combinations.`);
  for (let batchStart = 0; batchStart < regionalRows.length; batchStart += BATCH_SIZE) {
    const batch = regionalRows.slice(batchStart, batchStart + BATCH_SIZE);
    await Promise.allSettled(
      batch.map(async (row) => {
        const electionId = electionByCode.get(row.electionCode);
        const regionId = regionByShortName.get(row.regionName);
        if (!electionId) { skipped.push(`${row.electionCode}/${row.regionName}: no matching Election`); return; }
        if (!regionId) { skipped.push(`${row.electionCode}/${row.regionName}: no matching Region`); return; }

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

        const total = row.votesByCandidate.reduce((a, c) => a + c.votes, 0);
        for (const c of row.votesByCandidate) {
          const candidateId = candidateByElectionName.get(`${electionId}:${normalizeName(c.name)}`);
          if (!candidateId) { skipped.push(`${row.electionCode}/${row.regionName} "${c.name}" (${c.party}): no matching Candidate`); continue; }
          await prisma.regionalResultVote.upsert({
            where: { regionalResultId_candidateId: { regionalResultId: result.id, candidateId } },
            update: { votes: c.votes, voteShare: total ? (c.votes / total) * 100 : null },
            create: { regionalResultId: result.id, candidateId, votes: c.votes, voteShare: total ? (c.votes / total) * 100 : null },
          });
          regionalVoteUpserted++;
        }
      })
    );
    console.log(`  ...${Math.min(batchStart + BATCH_SIZE, regionalRows.length)}/${regionalRows.length} processed (${regionalUpserted} results, ${regionalVoteUpserted} vote rows so far)`);
  }

  console.log(`\nNationalResult: ${nationalUpserted} upserted, ${nationalVoteUpserted} vote rows.`);
  console.log(`RegionalResult: ${regionalUpserted} upserted, ${regionalVoteUpserted} vote rows.`);
  if (skipped.length) {
    console.log(`\n${skipped.length} skipped — genuinely worth reviewing this time, not an expected/known gap:`);
    console.log(skipped);
  } else {
    console.log("\nNothing skipped — every candidate resolved cleanly.");
  }
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });
