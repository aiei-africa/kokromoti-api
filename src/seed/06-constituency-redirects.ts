// ═══════════════════════════════════════════════════════════════════
// KOKROMOTI — Seed 06: Constituency Lineage Redirects
//
// 60 parliamentary candidates (1992-2008) were seeded against a
// post-2012-split constituency name that did not exist in their actual
// election year — because the source export's Constituency field is a
// denormalized text name, not the true FK. Confirmed via tblConstPrevious
// + tblPreviousConstNames + tblConstituencies.RelatedConst (three
// independent parts of the source data agreeing):
//
//   Atiwa East    (1992-2008) -> Atiwa West   (lineage: "Atiwa")
//   Berekum West  (1996-2008) -> Berekum East (lineage: "Berekum")
//   Pru West      (1996-2008) -> Pru East     (lineage: "Atebubu North"/"Pru")
//   Trobu         (2004-2008) -> Amasaman     (lineage: "Trobu-Amasaman";
//                                               RelatedConst confirms)
//
// This also resolves the previously-stuck placeholder row from Seed 04b
// (legacyCandId 5282, "Joseph Baah", Atiwa) — once redirected to the
// correct constituency, it becomes a genuine same-person duplicate at
// the right seat and merges the same way the other duplicates did.
//
// Standing method going forward: constituency resolution for any future
// historical candidate/results load should join through tblConstPrevious
// by (year, stated name) rather than matching directly against the
// current 276 constituencies — this script's REDIRECTS map is the
// one-time correction; the join method is the permanent fix upstream.
//
// Run: npx tsx src/seed/06-constituency-redirects.ts
// © 2026 AIEI / Ayivi Solutions Limited
// ═══════════════════════════════════════════════════════════════════

import { PrismaClient } from "@prisma/client";
import * as fs from "fs";
import * as path from "path";

const prisma = new PrismaClient();
const DATA = path.join(__dirname, "..", "..", "db", "seed-data");

interface Fix {
  legacyCandId: number; electionCode: string;
  oldConstituencyName: string; correctConstituencyName: string; fullName: string;
}

async function main() {
  console.log("── Kokromoti Seed 06: Constituency Lineage Redirects ──");
  const fixes: Fix[] = JSON.parse(fs.readFileSync(path.join(DATA, "constituency_redirect_fixes.json"), "utf-8"));
  console.log(`Applying ${fixes.length} confirmed redirects...`);

  const constituencies = await prisma.constituency.findMany({ select: { id: true, name: true } });
  const constByName = new Map(constituencies.map((c) => [c.name, c.id]));

  let redirected = 0, mergedDuplicates = 0, notFound = 0;
  const errors: string[] = [];

  for (const f of fixes) {
    const correctConstituencyId = constByName.get(f.correctConstituencyName);
    if (!correctConstituencyId) { errors.push(`No constituency found: ${f.correctConstituencyName}`); continue; }

    const candidate = await prisma.candidate.findFirst({ where: { legacyCandId: f.legacyCandId, electionType: "PARLIAMENTARY" } });
    if (!candidate) { notFound++; continue; }

    try {
      await prisma.candidate.update({
        where: { id: candidate.id },
        data: { constituencyId: correctConstituencyId },
      });
      redirected++;
    } catch (e) {
      // A sibling candidate already exists at the correct seat with the same
      // name+party+election (a genuine duplicate person, like Joseph Baah at
      // Atiwa) — reassign this candidate's votes onto the sibling, then
      // remove this now-redundant row, same pattern as Seed 04b.
      const sibling = await prisma.candidate.findFirst({
        where: {
          electionId: candidate.electionId, electionType: "PARLIAMENTARY",
          constituencyId: correctConstituencyId, partyId: candidate.partyId,
          fullName: candidate.fullName, NOT: { id: candidate.id },
        },
      });
      if (!sibling) { errors.push(`Redirect failed with no sibling found: legacyCandId ${f.legacyCandId}`); continue; }

      const votes = await prisma.constituencyResultVote.findMany({ where: { candidateId: candidate.id } });
      for (const v of votes) {
        const existing = await prisma.constituencyResultVote.findFirst({
          where: { constituencyResultId: v.constituencyResultId, candidateId: sibling.id },
        });
        if (existing) {
          await prisma.constituencyResultVote.delete({ where: { id: v.id } });
        } else {
          await prisma.constituencyResultVote.update({ where: { id: v.id }, data: { candidateId: sibling.id } });
        }
      }
      await prisma.candidate.delete({ where: { id: candidate.id } });
      mergedDuplicates++;
    }
    if ((redirected + mergedDuplicates) % 20 === 0) process.stdout.write(`\r  processed: ${redirected + mergedDuplicates}/${fixes.length}`);
  }
  console.log(`\r  processed: ${redirected + mergedDuplicates}/${fixes.length}`);

  console.log(`\n── Reconciliation ──`);
  console.log(`  redirected cleanly:      ${redirected}`);
  console.log(`  merged as duplicates:    ${mergedDuplicates}  (expect 1 — the Joseph Baah/Atiwa case)`);
  console.log(`  candidates not found:    ${notFound}`);
  if (errors.length) { console.warn("  Errors:"); for (const e of errors) console.warn(`    - ${e}`); }

  const remainingTmp = await prisma.candidate.count({ where: { fullName: { startsWith: "__TMP__" } } });
  console.log(`  remaining __TMP__ rows:  ${remainingTmp}  (expect 0)`);
  console.log("── Seed 06 complete ──");
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
