import { PrismaClient } from "@prisma/client";
import * as fs from "fs";
import * as path from "path";

const prisma = new PrismaClient();

// ── Kokromoti Seed 16: Presidential Candidate Photos ──
//
// Reads the filled presidential_candidates_export.csv (one row per real
// person, grouped across every year they ran — see Export A/B built
// earlier this session) and sets Candidate.photoUrl for EVERY one of that
// person's year-rows (candidate_ids column — semicolon-separated), not
// just their primary_candidate_id. A person who ran in 2012/2016/2020/2024
// has 4 separate Candidate rows; the same photo applies to all 4.
//
// Image files themselves are NOT touched by this script — they're copied
// directly into kokromoti-web's public/candidates/ folder via Explorer
// (a plain file copy into a real git working directory), independently of
// this repo. This script only writes the DB path string
// (/candidates/{filename}) that the frontend will request — it can't
// verify the file actually exists on disk in the other repo, so a missing
// upload would show as a broken image, not a script failure. That's an
// acceptable, non-fatal failure mode here.
//
// Connection discipline: reference data fetched once, all writes batched
// in chunked transactions — same pattern as Seed 14, not one query per row.

const CHUNK = 50;

interface CsvRow {
  displayName: string;
  primaryCandidateId: string;
  candidateIds: string[];
  imageFilename: string;
}

function loadCsv(): CsvRow[] {
  const p = path.join(__dirname, "../../db/seed-data/presidential_candidates_export.csv");
  const raw = fs.readFileSync(p, "utf-8").replace(/^\uFEFF/, ""); // strip BOM if present
  const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const header = lines[0].split(",");
  const idx = (name: string) => {
    const i = header.indexOf(name);
    if (i === -1) throw new Error(`CSV missing expected column: ${name}`);
    return i;
  };
  const iDisplayName = idx("display_name");
  const iPrimaryId = idx("primary_candidate_id");
  const iCandidateIds = idx("candidate_ids");
  const iImageFilename = idx("image_filename");

  const rows: CsvRow[] = [];
  for (const line of lines.slice(1)) {
    // Simple split is safe here — no quoted/comma-containing fields in
    // this export (verified: names don't contain literal commas).
    const f = line.split(",");
    if (f.length !== header.length) throw new Error(`Malformed CSV line (${f.length} fields, expected ${header.length}): ${line}`);
    const imageFilename = f[iImageFilename].trim();
    if (!imageFilename) continue; // genuinely unfilled row — skip, not an error
    rows.push({
      displayName: f[iDisplayName].trim(),
      primaryCandidateId: f[iPrimaryId].trim(),
      candidateIds: f[iCandidateIds].trim().split(";").map((s) => s.trim()).filter(Boolean),
      imageFilename,
    });
  }
  return rows;
}

async function main() {
  console.log("── Kokromoti Seed 16: Presidential Candidate Photos ──\n");

  const rows = loadCsv();
  console.log(`CSV loaded: ${rows.length} people with a filled image_filename (expect 45)`);
  if (rows.length === 0) throw new Error("No filled rows found — nothing to do. Aborting.");

  const totalCandidateRows = rows.reduce((s, r) => s + r.candidateIds.length, 0);
  console.log(`Total underlying Candidate rows to update (across all years): ${totalCandidateRows}\n`);

  // Verify every referenced Candidate id actually exists before writing
  // anything — catches a stale/edited CSV pointing at an id that no
  // longer matches the live DB.
  const allIds = rows.flatMap((r) => r.candidateIds);
  const existing = await prisma.candidate.findMany({ where: { id: { in: allIds } }, select: { id: true } });
  const existingSet = new Set(existing.map((c) => c.id));
  const missing = allIds.filter((id) => !existingSet.has(id));
  if (missing.length > 0) {
    console.error(`ABORT: ${missing.length} candidate_ids in the CSV don't match any Candidate row in the live DB:`);
    for (const id of missing.slice(0, 20)) console.error(`  ${id}`);
    throw new Error("CSV references unknown Candidate ids — aborting, nothing written.");
  }
  console.log(`Id resolution: ${allIds.length}/${allIds.length} candidate_ids matched real Candidate rows ✔\n`);

  const ops = rows.flatMap((r) =>
    r.candidateIds.map((id) =>
      prisma.candidate.update({
        where: { id },
        data: { photoUrl: `/candidates/${r.imageFilename}` },
      })
    )
  );

  console.log("── Writing photoUrl updates ──");
  for (let i = 0; i < ops.length; i += CHUNK) {
    await prisma.$transaction(ops.slice(i, i + CHUNK));
  }
  console.log(`  ${ops.length} Candidate rows updated (${Math.ceil(ops.length / CHUNK)} transaction batches)\n`);

  // Verification — read back and report.
  const updated = await prisma.candidate.count({ where: { id: { in: allIds }, photoUrl: { not: null } } });
  console.log("── Verification ──");
  console.log(`  ${updated}/${allIds.length} candidate rows now have a non-null photoUrl (expect ${allIds.length}/${allIds.length})`);
  console.log("\n── Seed 16 complete ──");
  console.log("\nReminder: this only sets the DB path. The actual image files must exist at");
  console.log("kokromoti-web/public/candidates/{filename} for them to actually render.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
