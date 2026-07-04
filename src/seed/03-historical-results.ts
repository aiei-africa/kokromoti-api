// ═══════════════════════════════════════════════════════════════════
// KOKROMOTI — Seed 03: Historical Results (1992-2016)
// Presidential: 1,794 constituency-election records, including 200
//   1992 records carrying registered-voter counts only (cast/valid/
//   candidate votes are 0 in the source — 1992 is EC-compiled from
//   secondary sources, NOT gazetted; stored as-is for reference,
//   pending review against the real gazette). 7 isolated 2000-runoff
//   gaps and 1 in 2008 remain excluded (see results_gaps_and_quality_log.md).
// Parliamentary: 1,339 constituency-election records, including 177
//   resolved 1992 uncontested-seat records and 76 flagged discrepancies
//   (carried as-recorded, not altered).
// Source: HISTORICAL_IMPORT throughout. Verified: 6,960/6,960 presidential
// vote counts exact-match the independent fact_presidential_const_results
// table for 1996-2012.
//
// PERFORMANCE: writes are batched via createMany (chunks of 1000) instead
// of per-row upserts. This is a first-time historical load, not a live
// re-sync, so createMany + skipDuplicates is the right idempotency model:
// safe to re-run, but if you need to CHANGE already-seeded figures after
// a gazette review, delete the affected constituency_results first (their
// votes cascade) rather than re-running this script expecting an update.
// Requires Seeds 01, 01c, 01d, 01e, and 02 to have run.
// Run: npx tsx src/seed/03-historical-results.ts
// © 2026 AIEI / Ayivi Solutions Limited
// ═══════════════════════════════════════════════════════════════════

import { PrismaClient, ElectionType, ResultSource, CollationStatus } from "@prisma/client";
import * as fs from "fs";
import * as path from "path";

const prisma = new PrismaClient();
const DATA = path.join(__dirname, "..", "..", "db", "seed-data");
const load = <T,>(f: string): T => JSON.parse(fs.readFileSync(path.join(DATA, f), "utf-8")) as T;

interface ResultRecord {
  electionCode: string;
  legacyConstId: number;
  registeredVoters: number | null;
  totalCast: number | null;
  validVotes: number | null;
  rejectedBallots: number | null;
  votes: { legacyCandId: number; votes: number }[];
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function seedResults(records: ResultRecord[], electionType: ElectionType, label: string) {
  console.log(`\n── ${label} (${records.length} records) ──`);

  const elections = await prisma.election.findMany({ select: { id: true, code: true } });
  const electionByCode = new Map(elections.map((e) => [e.code, e.id]));

  const constituencies = await prisma.constituency.findMany({
    where: { legacyConstId: { not: null } }, select: { id: true, legacyConstId: true },
  });
  const constByLegacy = new Map(constituencies.map((c) => [c.legacyConstId!, c.id]));

  const candidates = await prisma.candidate.findMany({
    where: { electionType, legacyCandId: { not: null } },
    select: { id: true, legacyCandId: true },
  });
  const candByLegacy = new Map(candidates.map((c) => [c.legacyCandId!, c.id]));

  // ── Pass 1: build and batch-insert constituency_results
  let skippedNoElection = 0, skippedNoConst = 0;
  const resultRows: {
    electionId: string; electionType: ElectionType; constituencyId: string;
    registeredVoters: number | null; totalCast: number | null; validVotes: number | null;
    rejectedBallots: number | null; turnoutPct: number | null; source: ResultSource; status: CollationStatus;
    stationsReporting: number; _key: string; // for re-lookup after insert
  }[] = [];

  for (const rec of records) {
    const electionId = electionByCode.get(rec.electionCode);
    if (!electionId) { skippedNoElection++; continue; }
    const constituencyId = constByLegacy.get(rec.legacyConstId);
    if (!constituencyId) { skippedNoConst++; continue; }

    const turnoutPct =
      rec.registeredVoters && rec.totalCast
        ? Number(((rec.totalCast / rec.registeredVoters) * 100).toFixed(3))
        : null;

    resultRows.push({
      electionId, electionType, constituencyId,
      registeredVoters: rec.registeredVoters, totalCast: rec.totalCast,
      validVotes: rec.validVotes, rejectedBallots: rec.rejectedBallots, turnoutPct,
      source: ResultSource.HISTORICAL_IMPORT, status: CollationStatus.DECLARED, stationsReporting: 0,
      _key: `${electionId}:${constituencyId}`,
    });
  }

  let resultsInserted = 0;
  for (const batch of chunk(resultRows, 1000)) {
    const res = await prisma.constituencyResult.createMany({
      data: batch.map(({ _key, ...row }) => row),
      skipDuplicates: true,
    });
    resultsInserted += res.count;
    process.stdout.write(`\r  results: ${resultsInserted}/${resultRows.length} inserted`);
  }
  console.log();

  // ── Re-fetch to get generated ids, keyed for vote attachment
  const inserted = await prisma.constituencyResult.findMany({
    where: { electionType, electionId: { in: [...new Set(resultRows.map((r) => r.electionId))] } },
    select: { id: true, electionId: true, constituencyId: true },
  });
  const resultIdByKey = new Map(inserted.map((r) => [`${r.electionId}:${r.constituencyId}`, r.id]));

  // ── Pass 2: build and batch-insert vote lines
  let votesSkippedNoCand = 0, votesSkippedNoResult = 0;
  const voteRows: { constituencyResultId: string; candidateId: string; votes: number; voteShare: number | null }[] = [];

  for (const rec of records) {
    const electionId = electionByCode.get(rec.electionCode);
    const constituencyId = electionId ? constByLegacy.get(rec.legacyConstId) : undefined;
    if (!electionId || !constituencyId) continue;
    const resultId = resultIdByKey.get(`${electionId}:${constituencyId}`);
    if (!resultId) { votesSkippedNoResult++; continue; }

    for (const v of rec.votes) {
      const candidateId = candByLegacy.get(v.legacyCandId);
      if (!candidateId) { votesSkippedNoCand++; continue; }
      const voteShare = rec.validVotes ? Number(((v.votes / rec.validVotes) * 100).toFixed(4)) : null;
      voteRows.push({ constituencyResultId: resultId, candidateId, votes: v.votes, voteShare });
    }
  }

  let votesInserted = 0;
  for (const batch of chunk(voteRows, 2000)) {
    const res = await prisma.constituencyResultVote.createMany({ data: batch, skipDuplicates: true });
    votesInserted += res.count;
    process.stdout.write(`\r  votes: ${votesInserted}/${voteRows.length} inserted`);
  }
  console.log();

  console.log(`  Vote lines: ${votesInserted} inserted, ${votesSkippedNoCand} skipped (candidate not found), ${votesSkippedNoResult} skipped (result not found)`);
  if (skippedNoElection) console.warn(`  WARN: ${skippedNoElection} records skipped — election code not found`);
  if (skippedNoConst) console.warn(`  WARN: ${skippedNoConst} records skipped — constituency not found`);

  const perElectionCount: Record<string, number> = {};
  for (const r of records) perElectionCount[r.electionCode] = (perElectionCount[r.electionCode] || 0) + 1;
  console.log("  Source coverage by election:", perElectionCount);

  return { inserted: resultsInserted, votesInserted };
}

async function main() {
  console.log("── Kokromoti Seed 03: Historical Results (1992-2016) ──");
  console.log("Batched writes (createMany) — should complete in well under a minute.");
  console.log("See db/seed-data/results_gaps_and_quality_log.md for known gaps and flagged discrepancies.");

  const start = Date.now();
  const prezResults = load<ResultRecord[]>("presidential_results.json");
  const parlResults = load<ResultRecord[]>("parliamentary_results.json");

  const prez = await seedResults(prezResults, ElectionType.PRESIDENTIAL, "Presidential Results");
  const parl = await seedResults(parlResults, ElectionType.PARLIAMENTARY, "Parliamentary Results");

  console.log("\n── National Roll-Up Sanity Check (Presidential) ──");
  const elections = await prisma.election.findMany({ where: { code: { not: "2028" } }, orderBy: { year: "asc" } });
  for (const e of elections) {
    const votes = await prisma.constituencyResultVote.groupBy({
      by: ["candidateId"],
      where: { constituencyResult: { electionId: e.id, electionType: "PRESIDENTIAL" } },
      _sum: { votes: true },
    });
    if (votes.length === 0) continue;
    const top = votes.sort((a, b) => (b._sum.votes ?? 0) - (a._sum.votes ?? 0))[0];
    const cand = await prisma.candidate.findUnique({ where: { id: top.candidateId }, select: { fullName: true } });
    const total = votes.reduce((s, v) => s + (v._sum.votes ?? 0), 0);
    const pct = total ? (((top._sum.votes ?? 0) / total) * 100).toFixed(2) : "0";
    console.log(`  ${e.code}: leader ${cand?.fullName} — ${top._sum.votes?.toLocaleString()} votes (${pct}%) of ${total.toLocaleString()} total`);
  }

  console.log("\n── Reconciliation ──");
  console.log(`  presidential constituency-results: ${prez.inserted} (expect 1794; includes 200 non-gazetted 1992 records — registered voters only, 0 votes)`);
  console.log(`  parliamentary constituency-results: ${parl.inserted} (expect 1339)`);
  console.log(`  total vote lines: ${prez.votesInserted + parl.votesInserted}`);
  console.log(`  elapsed: ${((Date.now() - start) / 1000).toFixed(1)}s`);
  console.log("\n  NOTE: 1992 presidential rows are EC-compiled from secondary sources,");
  console.log("  not gazetted. Stored as-is for reference pending review against the");
  console.log("  real gazette. They carry registered-voter counts only.");
  console.log("── Seed 03 complete ──");
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
