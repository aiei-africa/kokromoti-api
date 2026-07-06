// 2024 EC pink-sheet source data uses different punctuation/spelling
// conventions than our seeded constituency names in several places
// (hyphens vs slashes, "AKUAPEM" vs "AKWAPEM", acronyms vs full names, etc).
// Built by cross-referencing all 275 presidential-source constituency names
// against the confirmed 276-constituency reference table — validated to
// resolve every single one except Ablekuma North, which is a genuine
// absence (collation disrupted by electoral violence), not a naming issue.
//
// Reusable across BOTH the presidential and parliamentary 2024 seeds —
// the underlying constituencies and their real-world naming quirks are
// identical regardless of which race's data is being loaded.
export const CONSTITUENCY_ALIASES_2024: Record<string, string> = {
  "ABURA ASEBU KWAMANKESE": "Abura-Asebu-Kwamankese",
  "ADENTAN": "Adenta",
  "AFIGYA SEYERE EAST": "Afigya Sekyere East",
  "AGOTIME ZIOPE": "Agotime-Ziope",
  "AJUMAKO ENYAN ESIAM": "Ajumako-Enyan-Esiam",
  "AKUAPEM NORTH": "Akwapem North",
  "AKUAPEM SOUTH": "Akwapem South",
  "ANYAA/SOWUTUOM": "Anyaa-Sowutuom",
  "ASENE/MANSO/AKROSO": "Asene-Akroso-Manso",
  "ASIKUMA ODOBEN BRAKWA": "Asikuma-Odoben-Brakwa",
  "ATEBUBU/AMANTIN": "Atebubu-Amantin",
  "BOLGA EAST": "Bolgatanga East",
  "DABOYA/MANKARIGU": "Daboya-Mankarigu",
  "DOME/KWABENYA": "Dome-Kwabenya",
  "EFFIDUASE ASOKORE": "Effiduase-Asokore",
  "ELLEMBELE": "Ellembelle",
  "ESSIKADU-KETAN": "Essikado-Ketan",
  "EVALUE AJOMORO GWIRA": "Evalue-Ajomoro-Gwira",
  "GUSHEGU": "Gushiegu",
  "HEMANG LOWER DENKYIRA": "Hermang Lower Denkyira",
  "KOMENDA EDINA EGUAFO ABREM": "KEEA",
  "KWADASO MUNICIPAL": "Kwadaso",
  "KWAHU AFRAM PLAINS NORTH": "Afram Plains North",
  "LAMBUSSIE": "Lambussie-Karni",
  "NALERIGU GAMBAGA": "Nalerigu-Gambaga",
  "NINGO-PRAMPRAM": "Ningo Prampram",
  "NSAWAM/ADOAGYIRI": "Nsawam-Adoagyiri",
  "NSUTA/KWAMANG/BEPOSO": "Nsuta-Kwamang-Beposo",
  "ODOTOBRI": "Odotobiri",
  "OFOASE/AYIREBI": "Ofoase-Ayirebi",
  "PRESTEA HUNI-VALLEY": "Prestea-Huni Valley",
  "TARKWA NSUAEM": "Tarkwa-Nsuaem",
  "TATALE/SANGULI": "Tatale-Sanguli",
  "TWIFO ATTI MORKWA": "Twifo-Atii Morkwaa",
  "YAGABA KUBORI": "Yagaba-Kubori",
  "YAPEI/KUSAWGU": "Yapei-Kusawgu",
};

// Confirmed genuinely absent from the 2024 presidential source data —
// election-day violence disrupted collation (independently verified via
// multiple news sources: party agents disputed 18 missing pink sheets
// during presidential collation specifically; EC officials relocated to
// the regional office). The parliamentary seat for this constituency
// remained undeclared for months afterward. Recorded with CollationStatus
// DISPUTED, not silently absent or fabricated as zero.
export const MISSING_CONSTITUENCY_2024 = "Ablekuma North";

// Same real candidate, split across two name strings in the source data
// (trailing period difference). Reusable for parliamentary if the same
// inconsistency appears there.
export const CANDIDATE_NAME_MERGE_2024: Record<string, string> = {
  "Daniel Augustus Lartey Jnr.": "Daniel Augustus Lartey Jnr",
};
