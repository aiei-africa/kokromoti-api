// 2020 source data naming quirks — built by cross-referencing all 275
// parliamentary-source constituency names against the confirmed
// 276-constituency reference table. Validated to resolve every single one
// (Guan correctly absent — it didn't exist until 2024).
//
// Reusable for the upcoming 2020 presidential seed if it comes from the
// same source pipeline — check for overlap before assuming it's identical,
// since even the 2024 presidential/parliamentary files had partially
// different quirks from each other despite covering the same real seats.
export const CONSTITUENCY_ALIASES_2020: Record<string, string> = {
  "ABURA ASEBU KWAMANKESE": "Abura-Asebu-Kwamankese",
  "ADENTAN": "Adenta",
  "AFIGYA SEYERE EAST": "Afigya Sekyere East",
  "AJUMAKO ENYAN ESIAM": "Ajumako-Enyan-Esiam",
  "AKROPONG": "Akwapem North",
  "AKUAPEM SOUTH": "Akwapem South",
  "ANYAA SOWUTUOM": "Anyaa-Sowutuom",
  "ASENE-MANSO-AKROSO": "Asene-Akroso-Manso",
  "ASIKUMA ODOBEN BRAKWA": "Asikuma-Odoben-Brakwa",
  "ATEBUBU/AMANTIN": "Atebubu-Amantin",
  "BORTIANOR-NGLESHIE AMANFRO": "Bortianor-Ngleshie-Amanfro",
  "DABOYA/MANKARIGU": "Daboya-Mankarigu",
  "DAMANGO": "Damongo",
  "EFFIDUASE/ASOKORE": "Effiduase-Asokore",
  "ELLEMBELE": "Ellembelle",
  "ESSIKADU-KETAN": "Essikado-Ketan",
  "EVALUE AJOMORO GWIRA": "Evalue-Ajomoro-Gwira",
  "GUSHEGU": "Gushiegu",
  "HEMANG LOWER DENKYIRA": "Hermang Lower Denkyira",
  "KOMENDA EDINA EGUAFO ABREM": "KEEA",
  "KORLEY KLOTTEY": "Korle Klottey",
  "KPONE KATAMANSO": "Kpone-Katamanso",
  "KWAHU AFRAM PLAINS NORTH": "Afram Plains North",
  "LA DADEKOTOPON": "Dadekotopon",
  "LA NKWANTANANG/MADINA": "Madina",
  "LAMBUSSIE": "Lambussie-Karni",
  "NALERIGU/GAMBAGA": "Nalerigu-Gambaga",
  "NSAWAM/ADOAGYIRI": "Nsawam-Adoagyiri",
  "NSUTA/KWAMANG/BEPOSO": "Nsuta-Kwamang-Beposo",
  "ODODODIODOO": "Odododiodioo",
  "ODOTOBRI": "Odotobiri",
  "OFOASE/AYIREBI": "Ofoase-Ayirebi",
  "PRESTEA HUNI-VALLEY": "Prestea-Huni Valley",
  "SAWLA/TUNA/KALBA": "Sawla-Tuna-Kalba",
  "TARKWA NSUAEM": "Tarkwa-Nsuaem",
  "TATALE/SANGULI": "Tatale-Sanguli",
  "TWIFO ATTI MORKWA": "Twifo-Atii Morkwaa",
  "WEIJA GBAWE": "Weija-Gbawe",
  "YAGABA/KUBORI": "Yagaba-Kubori",
  "YAPEI/KUSAWGU": "Yapei-Kusawgu",
  "YUNYOOO": "Yunyoo",
};

// Verified directly against the actual EC pink sheet — the CSV's OCR
// extraction had shuffled all four candidates' names across each other's
// rows in this one constituency.
export const ODODODIODOO_CORRECTION_2020: Record<string, string> = {
  "EDWARD PATRICK NII LANTE VANDERPUYE (name reconstructed, verify)": "EDWARD PATRICK NII LANTE BANNERMAN",
  "EBENEZER OTOO / BANNERMAN (name reconstructed, verify)": "EDWIN NII LANTE VANDERPUYE",
  "ISSAKA SAMPSON": "EBENEZER OTOO",
  "NAME NOT RECOVERABLE FROM SOURCE": "ISSAKA SAMPSON",
};
