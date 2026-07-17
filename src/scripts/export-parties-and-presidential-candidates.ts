import { PrismaClient } from "@prisma/client";
import * as fs from "fs";
import * as path from "path";

const prisma = new PrismaClient();

// ── Export A: Parties, 1992–2024 ──
// One row per real party (legacyPartId 1–49 only, per schema comment —
// excludes any placeholder/pseudo-party rows). `candidate_ids` carries
// every Party row's own DB id (just one per party — parties don't repeat
// across years the way candidates do) so a future import script can match
// by id, not by name/abbreviation text (avoids any spelling-drift risk,
// same lesson as the constituency name-matching work).
async function exportParties(outDir: string) {
  const parties = await prisma.party.findMany({
    where: { legacyPartId: { not: null } },
    include: {
      candidates: {
        where: { electionType: "PRESIDENTIAL" },
        select: { election: { select: { year: true } } },
      },
    },
    orderBy: { legacyPartId: "asc" },
  });

  const rows = parties.map((p) => {
    const years = [...new Set(p.candidates.map((c) => c.election.year))].sort((a, b) => a - b);
    return {
      party_id: p.id,
      legacy_part_id: p.legacyPartId,
      name: p.name,
      abbreviation: p.abbreviation,
      colour_hex: p.colourHex ?? "",
      years_contested_presidential: years.join(";"),
      current_logo_url: p.logoUrl ?? "",
      suggested_filename: `${p.id}.png`,
      image_filename: "", // set to the actual saved filename once GM supplies the image (defaults to suggested_filename)
    };
  });

  const header = Object.keys(rows[0] ?? { party_id: "", legacy_part_id: "", name: "", abbreviation: "", colour_hex: "", years_contested_presidential: "", current_logo_url: "", suggested_filename: "", image_filename: "" }).join(",");
  const csv = [header, ...rows.map((r) => Object.values(r).map((v) => `"${String(v).replace(/"/g, '""')}"`).join(","))].join("\n");
  fs.writeFileSync(path.join(outDir, "parties_export.csv"), csv, "utf-8");
  console.log(`parties_export.csv: ${rows.length} parties`);
  return rows.length;
}

// ── Export B: Presidential candidates, 1992–2024 ──
// A real person can run in multiple election years (sometimes under
// different parties — e.g. the documented Nduom CPP 2008 → PPP 2012/2016
// switch), producing multiple Candidate rows. This groups those rows by
// normalized name into ONE line per real person, so GM supplies exactly
// one photo per candidate rather than duplicating effort per year.
// `candidate_ids` carries every underlying Candidate.id for that person —
// a future import script updates photoUrl on ALL of them by id, not by
// re-matching name text (the exact trap that bit the registered-voters
// CSV join earlier this session).
function normalize(s: string): string {
  return s.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

async function exportPresidentialCandidates(outDir: string) {
  const candidates = await prisma.candidate.findMany({
    where: { electionType: "PRESIDENTIAL" },
    include: {
      party: { select: { abbreviation: true } },
      election: { select: { year: true, code: true } },
    },
    orderBy: [{ fullName: "asc" }, { election: { year: "asc" } }],
  });

  const byKey = new Map<
    string,
    { displayName: string; occurrences: { year: number; candidateId: string }[]; parties: string[]; currentPhotoUrl: string }
  >();

  for (const c of candidates) {
    const key = normalize(c.fullName);
    const existing = byKey.get(key);
    const partyAbbr = c.party?.abbreviation ?? "IND";
    if (existing) {
      existing.occurrences.push({ year: c.election.year, candidateId: c.id });
      if (!existing.parties.includes(partyAbbr)) existing.parties.push(partyAbbr);
      if (!existing.currentPhotoUrl && c.photoUrl) existing.currentPhotoUrl = c.photoUrl;
    } else {
      byKey.set(key, {
        displayName: c.fullName,
        occurrences: [{ year: c.election.year, candidateId: c.id }],
        parties: [partyAbbr],
        currentPhotoUrl: c.photoUrl ?? "",
      });
    }
  }

  // The canonical, PERMANENT id for a real person — their earliest-year
  // Candidate.id. There's no separate "Person" model in the schema (each
  // Candidate row is per election-year), so this designates one already-
  // existing, already-unique, already-persistent DB id as that person's
  // stable identity going forward. It never changes once assigned — even
  // if they run again in 2028, 2032, etc., their canonical id stays their
  // very first candidacy's id. photoUrl still gets written to EVERY one
  // of their year-rows at import time (via candidate_ids below), so the
  // image renders correctly wherever they appear — the canonical id is
  // only the filename/identity key, not the only row that gets the photo.
  const rows = [...byKey.values()]
    .map((v) => {
      const sorted = [...v.occurrences].sort((a, b) => a.year - b.year);
      return {
        display_name: v.displayName,
        primary_candidate_id: sorted[0].candidateId,
        years_contested: sorted.map((o) => o.year).join(";"),
        parties_contested: v.parties.join(";"),
        current_photo_url: v.currentPhotoUrl,
        candidate_ids: sorted.map((o) => o.candidateId).join(";"),
        suggested_filename: `${sorted[0].candidateId}.jpg`,
        image_filename: "", // set to the actual saved filename once GM supplies the image (defaults to suggested_filename)
      };
    })
    .sort((a, b) => a.display_name.localeCompare(b.display_name));

  const header = Object.keys(rows[0] ?? { display_name: "", primary_candidate_id: "", years_contested: "", parties_contested: "", current_photo_url: "", candidate_ids: "", suggested_filename: "", image_filename: "" }).join(",");
  const csv = [header, ...rows.map((r) => Object.values(r).map((v) => `"${String(v).replace(/"/g, '""')}"`).join(","))].join("\n");
  fs.writeFileSync(path.join(outDir, "presidential_candidates_export.csv"), csv, "utf-8");
  console.log(`presidential_candidates_export.csv: ${rows.length} unique candidates (from ${candidates.length} candidacy rows across all years)`);
  return rows.length;
}

async function main() {
  const outDir = path.join(__dirname, "../../exports");
  fs.mkdirSync(outDir, { recursive: true });
  console.log("── Kokromoti Export: Parties + Presidential Candidates, 1992–2024 ──\n");
  const partyCount = await exportParties(outDir);
  const candCount = await exportPresidentialCandidates(outDir);
  console.log(`\nWritten to: ${outDir}`);
  console.log(`  parties_export.csv (${partyCount} rows)`);
  console.log(`  presidential_candidates_export.csv (${candCount} rows)`);
  console.log("\nBoth files are read-only exports — nothing in the database was changed.");
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
