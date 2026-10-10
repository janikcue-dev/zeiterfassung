// Rechenlogik für den Büro-Bereich – ohne React, damit sie für sich testbar ist.
//
// Datenformat (kommt so aus /api/buero, Aktion "daten"):
//   arbeitstag = { id, url, datum, mitarbeiter, status, gesamt, ueber, minus, beginn, ende, pause }
//   projekt    = { id, url, datum, mitarbeiter, name, stunden, reihenfolge, notiz }
// "minus" ist wie in Notion negativ gespeichert (z. B. -0.5).

import { BAUSTELLEN_HINWEIS_BIS_STUNDEN } from "./einstellungen.js";

export const STATUS_NORMAL = "Normal";
export const WOCHEN_SOLL = 40;

// Gleiche Soll-Regel wie in der Mitarbeiter-App: Mo–Do 8,5 h · Fr 6 h · Wochenende 0 h
export function sollStunden(dateStr) {
  const tag = new Date(dateStr + "T12:00:00").getDay();
  if (tag === 5) return 6;
  if (tag >= 1 && tag <= 4) return 8.5;
  return 0;
}

// ---------------------------------------------------------------------
// Datum
// ---------------------------------------------------------------------
export const WOCHENTAGE_KURZ = ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"];
export const MONATSNAMEN = ["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober", "November", "Dezember"];

export function toDateStr(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function heuteStr() {
  return toDateStr(new Date());
}

export function addTage(dateStr, n) {
  const d = new Date(dateStr + "T12:00:00");
  d.setDate(d.getDate() + n);
  return toDateStr(d);
}

export function montagVon(dateStr) {
  const d = new Date(dateStr + "T12:00:00");
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return toDateStr(d);
}

export function kalenderwoche(dateStr) {
  const d = new Date(dateStr + "T12:00:00");
  d.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7));
  const woche1 = new Date(d.getFullYear(), 0, 4, 12);
  return 1 + Math.round(((d - woche1) / 864e5 - 3 + ((woche1.getDay() + 6) % 7)) / 7);
}

export function monatsGrenzen(jahr, monat) {
  return { von: toDateStr(new Date(jahr, monat, 1, 12)), bis: toDateStr(new Date(jahr, monat + 1, 0, 12)) };
}

export function datumKurz(dateStr) {
  const [, m, t] = dateStr.split("-");
  return `${t}.${m}.`;
}

// ---------------------------------------------------------------------
// Zahlen
// ---------------------------------------------------------------------
const runde2 = (n) => Math.round(n * 100) / 100;
const summe = (liste, feld) => runde2(liste.reduce((a, x) => a + (Number(x[feld]) || 0), 0));

export function fmtStd(n) {
  return String(runde2(n || 0)).replace(".", ",");
}

export function fmtSaldo(n) {
  const r = runde2(n || 0);
  if (Math.abs(r) < 0.005) return "±0";
  return (r > 0 ? "+" : "−") + fmtStd(Math.abs(r));
}

export function normName(n) {
  return String(n || "").toLowerCase().replace(/\s+/g, " ").trim();
}

// ---------------------------------------------------------------------
// Tage zusammenführen und prüfen
// ---------------------------------------------------------------------
const schluessel = (mitarbeiter, datum) => `${mitarbeiter}|${datum}`;

function baueIndex(arbeitstage, projekte) {
  const index = new Map();
  const zelle = (m, d) => {
    const k = schluessel(m, d);
    if (!index.has(k)) index.set(k, { arbeitstage: [], projekte: [] });
    return index.get(k);
  };
  for (const a of arbeitstage) zelle(a.mitarbeiter, a.datum).arbeitstage.push(a);
  for (const p of projekte) zelle(p.mitarbeiter, p.datum).projekte.push(p);
  return index;
}

// Ein Tag eines Mitarbeiters
export function analysiereZelle(roh) {
  const arbeitstage = roh?.arbeitstage || [];
  const projekte = [...(roh?.projekte || [])].sort(
    (a, b) => (a.reihenfolge ?? 1) - (b.reihenfolge ?? 1) || a.name.localeCompare(b.name, "de")
  );
  const normal = arbeitstage.filter((a) => a.status === STATUS_NORMAL);
  const sonder = arbeitstage.filter((a) => a.status !== STATUS_NORMAL);
  const gearbeitet = summe(normal, "gesamt");
  const projektSumme = summe(projekte, "stunden");
  const saldo = runde2(summe(arbeitstage, "ueber") + summe(arbeitstage, "minus"));

  const warnungen = [];
  if (normal.length > 1) warnungen.push({ typ: "doppelt", text: "Arbeitstag doppelt eingetragen" });
  if (normal.length && Math.abs(projektSumme - gearbeitet) > 0.01) {
    warnungen.push({ typ: "summe", text: `Projekte ${fmtStd(projektSumme)} h ≠ Arbeitszeit ${fmtStd(gearbeitet)} h` });
  }
  if (!normal.length && projekte.length) warnungen.push({ typ: "summe", text: "Projektstunden ohne Arbeitstag" });

  // Korrigierbar über die Büro-Ansicht: genau ein normaler Tag mit Uhrzeiten und mind. ein Projekt
  const korrigierbar = normal.length === 1 && !!normal[0].beginn && !!normal[0].ende && projekte.length > 0;

  return {
    leer: arbeitstage.length === 0 && projekte.length === 0,
    normal, sonder, projekte, gearbeitet, projektSumme, saldo, warnungen, korrigierbar,
    abweichendeBaustellen: new Set(),
  };
}

// Gleiche Baustelle, gleicher Tag, unterschiedliche Stunden → Hinweis bei allen Beteiligten
function vergleicheBaustellen(zellenDesTages, grenze) {
  const proBaustelle = new Map();
  for (const [mitarbeiter, z] of zellenDesTages) {
    const proName = new Map();
    for (const p of z.projekte) {
      const k = normName(p.name);
      if (!k) continue;
      const e = proName.get(k) || { anzeige: p.name, stunden: 0 };
      e.stunden = runde2(e.stunden + p.stunden);
      proName.set(k, e);
    }
    for (const [k, e] of proName) {
      if (!proBaustelle.has(k)) proBaustelle.set(k, { anzeige: e.anzeige, eintraege: [] });
      proBaustelle.get(k).eintraege.push({ mitarbeiter, stunden: e.stunden });
    }
  }
  let anzahl = 0;
  for (const [k, b] of proBaustelle) {
    if (b.eintraege.length < 2) continue;
    const werte = b.eintraege.map((e) => e.stunden);
    const spanne = runde2(Math.max(...werte) - Math.min(...werte));
    if (spanne < 0.01) continue;
    if (grenze !== null && grenze !== undefined && spanne > grenze + 0.001) continue;
    anzahl++;
    const liste = b.eintraege.map((e) => `${e.mitarbeiter} ${fmtStd(e.stunden)} h`).join(", ");
    for (const e of b.eintraege) {
      const z = zellenDesTages.get(e.mitarbeiter);
      z.abweichendeBaustellen.add(k);
      z.warnungen.push({ typ: "baustelle", text: `${b.anzeige}: ${liste}` });
    }
  }
  return anzahl;
}

function mitarbeiterListe(daten) {
  const liste = [...(daten.mitarbeiter || [])];
  const bekannt = new Set(liste.map((m) => m.name));
  for (const x of [...daten.arbeitstage, ...daten.projekte]) {
    if (x.mitarbeiter && !bekannt.has(x.mitarbeiter)) {
      bekannt.add(x.mitarbeiter);
      liste.push({ name: x.mitarbeiter, farbe: "default" });
    }
  }
  return liste;
}

// Eigene Reihenfolge aus der Büro-Ansicht anwenden; Unbekannte (z. B. neue Mitarbeiter) hinten anhängen
export function ordneMitarbeiter(liste, reihenfolge = []) {
  const pos = new Map(reihenfolge.map((name, i) => [name, i]));
  return liste
    .map((m, i) => ({ m, i }))
    .sort((a, b) => (pos.get(a.m.name) ?? 1e6 + a.i) - (pos.get(b.m.name) ?? 1e6 + b.i))
    .map((x) => x.m);
}

// Alle Mitarbeiter (Notion-Auswahl + Namen aus den Daten) in der eigenen Reihenfolge
export function alleMitarbeiter(daten, reihenfolge = []) {
  return ordneMitarbeiter(mitarbeiterListe(daten), reihenfolge);
}

function pruefeZeitraum(daten, tage, heute, grenze = BAUSTELLEN_HINWEIS_BIS_STUNDEN, reihenfolge = []) {
  const index = baueIndex(daten.arbeitstage, daten.projekte);
  const alle = ordneMitarbeiter(mitarbeiterListe(daten), reihenfolge);
  const zellen = new Map(); // datum -> Map(mitarbeiter -> zelle)
  let abweichungen = 0;
  for (const t of tage) {
    const proTag = new Map();
    for (const m of alle) {
      const z = analysiereZelle(index.get(schluessel(m.name, t)));
      const wochentag = new Date(t + "T12:00:00").getDay();
      z.fehlt = z.leer && wochentag >= 1 && wochentag <= 5 && t < heute;
      proTag.set(m.name, z);
    }
    abweichungen += vergleicheBaustellen(proTag, grenze);
    zellen.set(t, proTag);
  }
  return { alle, zellen, abweichungen };
}

// ---------------------------------------------------------------------
// Woche: Tage als Zeilen, Mitarbeiter als Spalten
// ---------------------------------------------------------------------
// optionen: { ausgeblendet: [Namen], reihenfolge: [Namen], grenze: Stunden }
export function baueWoche(daten, montag, heute = heuteStr(), optionen = {}) {
  const { ausgeblendet = [], reihenfolge = [], grenze = BAUSTELLEN_HINWEIS_BIS_STUNDEN } = optionen;
  const alleTage = Array.from({ length: 7 }, (_, i) => addTage(montag, i));
  const { alle, zellen } = pruefeZeitraum(daten, alleTage, heute, grenze, reihenfolge);

  // Alle Mitarbeiter aus der Notion-Auswahl – auch ohne Eintrag, damit fehlende Tage auffallen.
  // Ausblenden geht über "Mitarbeiter anordnen" in der Büro-Ansicht (oder einstellungen.js).
  const versteckt = new Set(ausgeblendet);
  const mitarbeiter = alle.filter((m) => !versteckt.has(m.name));
  // Ausgeblendete, die in dieser Woche trotzdem etwas eingetragen haben → Hinweis, damit nichts untergeht
  const ausgeblendetMitEintrag = alle
    .filter((m) => versteckt.has(m.name) && alleTage.some((t) => !zellen.get(t).get(m.name).leer))
    .map((m) => m.name);

  // Sa/So nur anzeigen, wenn jemand dort etwas eingetragen hat
  const tage = alleTage.filter((t, i) => i < 5 || mitarbeiter.some((m) => !zellen.get(t).get(m.name).leer));

  let warnungen = 0;
  let fehlend = 0;
  const zeilen = tage.map((t) => ({
    datum: t,
    zellen: mitarbeiter.map((m) => {
      const z = zellen.get(t).get(m.name);
      if (z.warnungen.length) warnungen++;
      if (z.fehlt) fehlend++;
      return z;
    }),
  }));

  const summen = mitarbeiter.map((m) => {
    const tageDesMa = alleTage.map((t) => zellen.get(t).get(m.name));
    const sonder = {};
    for (const z of tageDesMa) for (const s of z.sonder) sonder[s.status] = (sonder[s.status] || 0) + 1;
    return {
      gearbeitet: runde2(tageDesMa.reduce((a, z) => a + z.gearbeitet, 0)),
      saldo: runde2(tageDesMa.reduce((a, z) => a + z.saldo, 0)),
      sonder,
    };
  });

  return { alle, mitarbeiter, zeilen, summen, warnungen, fehlend, ausgeblendetMitEintrag };
}

// ---------------------------------------------------------------------
// Monatsabschluss – jeder Monat steht für sich (kein Übertrag)
// ---------------------------------------------------------------------
export function berechneMonatswerte({ gesamt, ueberBrutto, minus }) {
  const aufgefuellt = Math.min(minus, ueberBrutto);
  const inRegulaer = runde2(gesamt - ueberBrutto);
  return {
    inRegulaer,
    aufgefuellt: runde2(aufgefuellt),
    regulaerNachAuffuellen: runde2(inRegulaer + aufgefuellt),
    verbleibendPlus: runde2(Math.max(ueberBrutto - minus, 0)),
    nichtAusgeglichen: runde2(Math.max(minus - ueberBrutto, 0)),
  };
}

// Im Monatsabschluss wird nur sortiert, nie ausgeblendet: wer Stunden hat, muss in der Abrechnung stehen.
export function baueMonat(daten, jahr, monat, heute = heuteStr(), optionen = {}) {
  const { reihenfolge = [], grenze = BAUSTELLEN_HINWEIS_BIS_STUNDEN } = optionen;
  const { von, bis } = monatsGrenzen(jahr, monat);
  const tage = [];
  for (let t = von; t <= bis; t = addTage(t, 1)) tage.push(t);
  const { alle, zellen, abweichungen } = pruefeZeitraum(daten, tage, heute, grenze, reihenfolge);

  const zeilen = alle
    .map((m) => {
      const tageDesMa = tage.map((t) => zellen.get(t).get(m.name));
      const at = daten.arbeitstage.filter((a) => a.mitarbeiter === m.name);
      const pr = daten.projekte.filter((p) => p.mitarbeiter === m.name);
      if (!at.length && !pr.length) return null;

      const gesamt = summe(pr, "stunden"); // Stunden auf den Baustellen
      const gearbeitetLautArbeitstagen = summe(at.filter((a) => a.status === STATUS_NORMAL), "gesamt");
      const ueberBrutto = summe(at, "ueber");
      const minus = Math.abs(summe(at, "minus"));
      const zaehle = (status) => at.filter((a) => a.status === status).length;

      return {
        mitarbeiter: m,
        gesamt,
        ueberBrutto,
        minus: runde2(minus),
        ...berechneMonatswerte({ gesamt, ueberBrutto, minus }),
        urlaub: zaehle("Urlaub"),
        feiertag: zaehle("Feiertag"),
        schule: zaehle("Schultag"),
        krankTage: zaehle("Krankheit"),
        krankStunden: summe(at.filter((a) => a.status === "Krankheit"), "gesamt"),
        fehlendeTage: tageDesMa.filter((z) => z.fehlt).length,
        tageMitWarnung: tageDesMa.filter((z) => z.warnungen.length).length,
        summenAbweichung: Math.abs(gesamt - gearbeitetLautArbeitstagen) > 0.01 ? runde2(gesamt - gearbeitetLautArbeitstagen) : 0,
      };
    })
    .filter(Boolean);

  // Stunden pro Baustelle
  const proBaustelle = new Map();
  for (const p of daten.projekte) {
    const k = normName(p.name);
    if (!k) continue;
    const e = proBaustelle.get(k) || { name: p.name, stunden: 0, mitarbeiter: new Set() };
    e.stunden = runde2(e.stunden + p.stunden);
    e.mitarbeiter.add(p.mitarbeiter);
    proBaustelle.set(k, e);
  }
  const baustellen = [...proBaustelle.values()]
    .map((b) => ({ ...b, mitarbeiter: [...b.mitarbeiter] }))
    .sort((a, b) => b.stunden - a.stunden);

  return { zeilen, baustellen, abweichungen, von, bis };
}

// CSV für Steuerbüro/Lohn (Semikolon + Dezimalkomma, öffnet sauber in deutschem Excel)
export function monatAlsCsv(monat, titel) {
  const kopf = [
    "Mitarbeiter", "Monat", "Gesamt Baustellen (h)", "Überstunden brutto (h)", "Minusstunden (h)",
    "In regulärer Zeit (h)", "Regulär nach Auffüllen (h)", "Verbleibende Plusstunden (h)", "Nicht ausgeglichen (h)",
    "Urlaub (Tage)", "Krank (Tage)", "Krank (h)", "Feiertage", "Schultage",
  ];
  const z = (n) => fmtStd(n);
  const zeilen = monat.zeilen.map((r) => [
    r.mitarbeiter.name, titel, z(r.gesamt), z(r.ueberBrutto), z(r.minus), z(r.inRegulaer),
    z(r.regulaerNachAuffuellen), z(r.verbleibendPlus), z(r.nichtAusgeglichen),
    r.urlaub, r.krankTage, z(r.krankStunden), r.feiertag, r.schule,
  ]);
  const zelle = (v) => `"${String(v).replace(/"/g, '""')}"`;
  return "﻿" + [kopf, ...zeilen].map((r) => r.map(zelle).join(";")).join("\r\n");
}

// ---------------------------------------------------------------------
// Farben
// ---------------------------------------------------------------------
// Notion-Select-Farben (helle Variante) → Hintergrund, Schrift, Akzent
export const NOTION_FARBEN = {
  default: { bg: "#EDEDEC", fg: "#32302C", akzent: "#9B9A97" },
  gray: { bg: "#E3E2E0", fg: "#32302C", akzent: "#9B9A97" },
  brown: { bg: "#EEE0DA", fg: "#442A1E", akzent: "#9F6B53" },
  orange: { bg: "#FADEC9", fg: "#49290E", akzent: "#D9730D" },
  yellow: { bg: "#FDECC8", fg: "#402C1B", akzent: "#CB912F" },
  green: { bg: "#DBEDDB", fg: "#1C3829", akzent: "#448361" },
  blue: { bg: "#D3E5EF", fg: "#183347", akzent: "#337EA9" },
  purple: { bg: "#E8DEEE", fg: "#412454", akzent: "#9065B0" },
  pink: { bg: "#F5E0E9", fg: "#4C2337", akzent: "#C14C8A" },
  red: { bg: "#FFE2DD", fg: "#5D1715", akzent: "#D44C47" },
};

export const farbeVon = (name) => NOTION_FARBEN[name] || NOTION_FARBEN.default;

// Feste Farbe pro Baustelle (aus dem Namen abgeleitet → überall gleich)
const BAUSTELLEN_PALETTE = ["#2F6FC0", "#2E8B57", "#7A4CC2", "#C2185B", "#B26A00", "#00838F", "#5D6D7E", "#AD1457", "#558B2F", "#6D4C41"];
export function baustellenFarbe(name) {
  const k = normName(name);
  let h = 0;
  for (let i = 0; i < k.length; i++) h = (h * 31 + k.charCodeAt(i)) >>> 0;
  return BAUSTELLEN_PALETTE[h % BAUSTELLEN_PALETTE.length];
}
