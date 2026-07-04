// ═══════════════════════════════════════════════════════════════════
// KOKROMOTI — Seed 05: Party Completion & Presidential Confirmation
//
// tblParties.xls (authoritative, 25 real parties) revealed 2 parties
// missing from the original 23-party seed: APC (All People's Congress)
// and UPP (United Progressive Party), both active from 2016 onward.
// If Seed 04 already ran, any parliamentary candidate whose party is
// APC or UPP would have been created with partyId = null, since those
// parties didn't exist yet. This script:
//   1. Adds the 2 missing parties.
//   2. Relinks the 23 affected 2016 parliamentary candidates (21 APC, 2 UPP)
//      by legacyCandId, so they carry the correct party instead of null.
//   3. Re-confirms presidential candidates 1992-2016 (incl. both runoffs)
//      against tblCandidatesPrez.xls — this data was already correct in
//      the DB (unlike parliamentary), so this step upserts idempotently
//      as a verification pass, not a fix.
//
// Requires Seeds 01-04. Run: npx tsx src/seed/05-party-completion.ts
// © 2026 AIEI / Ayivi Solutions Limited
// ═══════════════════════════════════════════════════════════════════

import { PrismaClient, ElectionType } from "@prisma/client";
import * as fs from "fs";
import * as path from "path";

const prisma = new PrismaClient();
const DATA = path.join(__dirname, "..", "..", "db", "seed-data");
const load = <T,>(f: string): T => JSON.parse(fs.readFileSync(path.join(DATA, f), "utf-8")) as T;

interface Party { legacyPartId: number; name: string; abbreviation: string; }
interface ParlCandidate {
  legacyCandId: number; electionCode: string; constituencyName: string;
  partyAbbr: string | null; fullName: string;
}
interface PrezCandidate {
  electionCode: string; electionType: "PRESIDENTIAL"; partyAbbr: string | null;
  fullName: string; legacyPartId: number;
}

async function main() {
  console.log("── Kokromoti Seed 05: Party Completion & Presidential Confirmation ──");
  const ghana = await prisma.country.findUniqueOrThrow({ where: { code: "GH" } });

  // ── Step 1: add missing parties (idempotent — upserts all 25, only 2 are new)
  const parties = load<Party[]>("parties_full.json");
  let partiesCreated = 0;
  for (const p of parties) {
    const res = await prisma.party.upsert({
      where: { countryId_abbreviation: { countryId: ghana.id, abbreviation: p.abbreviation } },
      update: { name: p.name, legacyPartId: p.legacyPartId },
      create: { countryId: ghana.id, name: p.name, abbreviation: p.abbreviation, legacyPartId: p.legacyPartId },
    });
    partiesCreated++;
  }
  console.log(`Parties upserted: ${partiesCreated} (expect 25; APC and UPP are the new ones)`);

  // ── Step 2: relink APC/UPP parliamentary candidates
  const parl = load<ParlCandidate[]>("parl_candidates_corrected.json");
  const affected = parl.filter((c) => c.partyAbbr === "APC" || c.partyAbbr === "UPP");
  console.log(`\nRelinking ${affected.length} candidates to their correct party...`);

  const partyByAbbr = new Map(
    (await prisma.party.findMany({ where: { countryId: ghana.id }, select: { id: true, abbreviation: true } }))
      .map((p) => [p.abbreviation, p.id])
  );

  let relinked = 0;
  for (const c of affected) {
    const partyId = partyByAbbr.get(c.partyAbbr!);
    if (!partyId) continue;
    const res = await prisma.candidate.updateMany({
      where: { legacyCandId: c.legacyCandId, electionType: "PARLIAMENTARY" },
      data: { partyId },
    });
    relinked += res.count;
  }
  console.log(`Relinked: ${relinked} (expect 23)`);

  // ── Step 3: confirm presidential 1992-2016 (idempotent verification, not a fix)
  const prez = load<PrezCandidate[]>("prez_candidates_full_1992_2016.json");
  console.log(`\nConfirming ${prez.length} presidential candidates (1992-2016, incl. runoffs)...`);

  const elections = await prisma.election.findMany({ select: { id: true, code: true } });
  const electionByCode = new Map(elections.map((e) => [e.code, e.id]));

  let matched = 0, mismatched = 0, notFound = 0;
  for (const p of prez) {
    const electionId = electionByCode.get(p.electionCode);
    if (!electionId) continue;
    const partyId = p.partyAbbr ? partyByAbbr.get(p.partyAbbr) ?? null : null;
    const existing = await prisma.candidate.findFirst({
      where: { electionId, electionType: "PRESIDENTIAL", fullName: p.fullName },
    });
    if (!existing) { notFound++; continue; }
    if (existing.partyId !== partyId) {
      await prisma.candidate.update({ where: { id: existing.id }, data: { partyId } });
      mismatched++;
    } else {
      matched++;
    }
  }
  console.log(`  Already correct: ${matched} | Party corrected: ${mismatched} | Not found in DB: ${notFound}`);
  if (notFound > 0) {
    console.log(`  (${notFound} not-found is expected if this is the first run before Seed 04's 2016 candidates were created)`);
  }

  console.log("\n── Reconciliation ──");
  const totalParties = await prisma.party.count({ where: { countryId: ghana.id } });
  console.log(`  total parties: ${totalParties} (expect 25)`);
  console.log("── Seed 05 complete ──");
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
