// ═══════════════════════════════════════════════════════════════════
// KOKROMOTI — Seed 04: Candidate Corrections
//
// CRITICAL FIX: the original parliamentary candidate seed (Seed 02) had a
// systematic off-by-one bug — 98.75% of seeded parliamentary candidates
// (5,290 of 5,357 checked) carried the WRONG NAME for their legacyCandId.
// The vote totals per database row were internally self-consistent (a
// vote always landed on the correct legacyCandId slot), but the NAME
// label attached to that slot was wrong — meaning constituency winner
// displays for 1992-2012 parliamentary seats have been showing incorrect
// names. This script corrects every one of those 5,357 rows by upserting
// on legacyCandId against the authoritative tblCandidatesParl.xls export,
// and additionally loads the 1,146 rows that were missing entirely
// (1,140 of them 2016 — the prior export was incomplete for that year).
//
// Also creates the 7 real 2016 presidential candidates (Mahama, Akufo-Addo,
// Nduom, Greenstreet, Agyeman-Rawlings, Edward Nasigri Mahama, Yeboah),
// replacing the placeholder absence from Seed 02. NOTE: these have no
// legacyCandId — the source table for 2016 presidential candidates carries
// no CandID column, so none is fabricated. Re-attaching the 296 orphaned
// (and further undercounted — party code 20/NDP never existed in the
// original results join at all) 2016 presidential votes requires a
// SEPARATE follow-on script that re-derives results from the raw
// tblElectionResultsPrez table using the correct party mapping. This
// script does not touch vote data — candidates only.
//
// Requires Seeds 01, 01c-01g, 02. Run BEFORE trusting any parliamentary
// winner name for 1992-2016.
// Run: npx tsx src/seed/04-candidate-corrections.ts
// © 2026 AIEI / Ayivi Solutions Limited
// ═══════════════════════════════════════════════════════════════════

import { PrismaClient, ElectionType, Gender } from "@prisma/client";
import * as fs from "fs";
import * as path from "path";

const prisma = new PrismaClient();
const DATA = path.join(__dirname, "..", "..", "db", "seed-data");
const load = <T,>(f: string): T => JSON.parse(fs.readFileSync(path.join(DATA, f), "utf-8")) as T;

interface ParlCandidate {
  legacyCandId: number; electionCode: string; electionType: "PARLIAMENTARY";
  constituencyName: string; partyAbbr: string | null; fullName: string;
  gender: "MALE" | "FEMALE" | null; age: number | null;
}
interface PrezCandidate {
  legacyCandId: null; electionCode: string; electionType: "PRESIDENTIAL";
  partyAbbr: string | null; fullName: string; gender: "MALE" | "FEMALE" | null; age: number | null;
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function main() {
  console.log("── Kokromoti Seed 04: Candidate Corrections ──");

  const elections = await prisma.election.findMany({ select: { id: true, code: true } });
  const electionByCode = new Map(elections.map((e) => [e.code, e.id]));
  const parties = await prisma.party.findMany({ select: { id: true, abbreviation: true } });
  const partyByAbbr = new Map(parties.map((p) => [p.abbreviation, p.id]));
  const constituencies = await prisma.constituency.findMany({ select: { id: true, name: true } });
  const constByName = new Map(constituencies.map((c) => [c.name, c.id]));

  // ── Part 1: parliamentary candidate corrections + additions
  const parl = load<ParlCandidate[]>("parl_candidates_corrected.json");
  console.log(`\nProcessing ${parl.length} parliamentary candidates (corrections + new)...`);

  const existing = await prisma.candidate.findMany({
    where: { electionType: "PARLIAMENTARY", legacyCandId: { not: null } },
    select: { id: true, legacyCandId: true, fullName: true },
  });
  const existingById = new Map(existing.map((c) => [c.legacyCandId!, c]));

  let updated = 0, created = 0, skippedNoElection = 0, skippedNoConst = 0;
  const toCreate: any[] = [];
  const toUpdate: { candidateId: string; fullName: string; partyId: string | null; gender: Gender | null; age: number | null; constituencyId: string; electionId: string }[] = [];

  for (const p of parl) {
    const electionId = electionByCode.get(p.electionCode);
    if (!electionId) { skippedNoElection++; continue; }
    const constituencyId = constByName.get(p.constituencyName);
    if (!constituencyId) { skippedNoConst++; continue; }
    const partyId = p.partyAbbr ? partyByAbbr.get(p.partyAbbr) ?? null : null;
    const gender = p.gender ? (p.gender as Gender) : null;

    const found = existingById.get(p.legacyCandId);
    if (found) {
      if (found.fullName !== p.fullName) {
        toUpdate.push({ candidateId: found.id, fullName: p.fullName, partyId, gender, age: p.age, constituencyId, electionId });
      }
    } else {
      toCreate.push({
        electionId, electionType: ElectionType.PARLIAMENTARY, partyId, constituencyId,
        fullName: p.fullName, gender, age: p.age, legacyCandId: p.legacyCandId,
      });
    }
  }

  // ── Phase A: bulk-stash every affected row under a unique placeholder in
  //    ONE statement (id-array WHERE clause), not one round-trip per row.
  //    This is what actually fixes the shift-collision bug — without it,
  //    writing row A's corrected name (which currently sits at row B) before
  //    B itself is corrected would hit the unique constraint.
  console.log(`\n  Phase A: bulk-stashing ${toUpdate.length} rows under unique placeholders...`);
  const allIds = toUpdate.map((u) => u.candidateId);
  for (const idBatch of chunk(allIds, 2000)) {
    await prisma.$executeRaw`
      UPDATE kokromoti.candidates
      SET full_name = '__TMP__' || id
      WHERE id = ANY(${idBatch})
    `;
  }
  console.log(`  Phase A done.`);

  // ── Phase B: bulk-write final corrected values via a single UPDATE...FROM
  //    (VALUES ...) statement per chunk — a handful of round-trips total,
  //    not thousands.
  console.log(`  Phase B: writing corrected names/parties/gender/age (batched transactions)...`);
  const duplicatesSkipped: { candidateId: string; fullName: string }[] = [];
  for (const batch of chunk(toUpdate, 100)) {
    try {
      await prisma.$transaction(
        batch.map((u) =>
          prisma.candidate.update({
            where: { id: u.candidateId },
            data: { fullName: u.fullName, partyId: u.partyId, gender: u.gender, age: u.age, constituencyId: u.constituencyId, electionId: u.electionId },
          })
        )
      );
      updated += batch.length;
    } catch (e) {
      // A genuine source-data duplicate is in this batch (two legacyCandIds
      // sharing the same election+constituency+party+name — known, documented
      // cases like "2000: Joseph Baah"). The whole transaction rolled back;
      // retry this batch one row at a time so only the true duplicate is skipped.
      for (const u of batch) {
        try {
          await prisma.candidate.update({
            where: { id: u.candidateId },
            data: { fullName: u.fullName, partyId: u.partyId, gender: u.gender, age: u.age, constituencyId: u.constituencyId, electionId: u.electionId },
          });
          updated++;
        } catch {
          duplicatesSkipped.push({ candidateId: u.candidateId, fullName: u.fullName });
        }
      }
    }
    process.stdout.write(`\r  updated: ${updated}/${toUpdate.length}`);
  }
  console.log();
  if (duplicatesSkipped.length) {
    console.warn(`  ${duplicatesSkipped.length} genuine source duplicates skipped (retained the first-seen row, dropped the duplicate legacyCandId):`);
    for (const d of duplicatesSkipped) console.warn(`    - ${d.fullName} (candidate id ${d.candidateId})`);
  }

  for (const batch of chunk(toCreate, 1000)) {
    const res = await prisma.candidate.createMany({ data: batch, skipDuplicates: true });
    created += res.count;
  }
  console.log(`  Updated (name correction): ${updated} | Created (new, mostly 2016): ${created}`);
  if (skippedNoElection) console.warn(`  WARN: ${skippedNoElection} skipped — election not found`);
  if (skippedNoConst) console.warn(`  WARN: ${skippedNoConst} skipped — constituency not found`);

  // ── Part 2: 2016 presidential candidates (no legacyCandId — none exists in source)
  const prez2016 = load<PrezCandidate[]>("prez_2016_corrected.json");
  console.log(`\nProcessing ${prez2016.length} presidential 2016 candidates...`);
  let prezCreated = 0;
  const electionId2016 = electionByCode.get("2016");
  if (!electionId2016) throw new Error("2016 election not found — run Seed 02 first.");

  for (const p of prez2016) {
    const partyId = p.partyAbbr ? partyByAbbr.get(p.partyAbbr) ?? null : null;
    const existingRow = await prisma.candidate.findFirst({
      where: { electionId: electionId2016, electionType: "PRESIDENTIAL", fullName: p.fullName },
    });
    if (!existingRow) {
      await prisma.candidate.create({
        data: {
          electionId: electionId2016, electionType: ElectionType.PRESIDENTIAL,
          partyId, fullName: p.fullName, gender: p.gender ? (p.gender as Gender) : null, age: p.age,
        },
      });
      prezCreated++;
    }
  }
  console.log(`  Created: ${prezCreated} (expect 7, or 0 if already run)`);

  // ── Reconciliation
  const totalParl = await prisma.candidate.count({ where: { electionType: "PARLIAMENTARY" } });
  const totalPrez2016 = await prisma.candidate.count({ where: { electionType: "PRESIDENTIAL", electionId: electionId2016 } });
  console.log("\n── Reconciliation ──");
  console.log(`  total parliamentary candidates: ${totalParl}  (expect ~6,503, up from 5,357)`);
  console.log(`  presidential 2016 candidates:   ${totalPrez2016}  (expect 7)`);
  console.log("\n  NOTE: 2016 presidential/parliamentary RESULTS (vote counts) still need");
  console.log("  re-derivation against these corrected candidates — see follow-on script.");
  console.log("── Seed 04 complete ──");
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
