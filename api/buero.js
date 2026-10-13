// Vercel Serverless Function: Büro-Bereich (nur für Inhaber/Büro)
//
// Getrennt von /api/notion, damit die Mitarbeiter-App unverändert bleibt.
// Jeder Aufruf muss das Büro-Passwort im Header "x-buero-passwort" mitschicken.
//
// Benötigte Umgebungsvariablen in Vercel (Settings → Environment Variables):
//   NOTION_TOKEN        = Secret der Notion-Integration (gibt es schon)
//   BAUSTELLEN_PAGE_ID  = ID der Seite "Laufende Baustellen" (gibt es schon)
//   BUERO_PASSWORT      = NEU – Passwort für den Büro-Bereich
//
// Aktionen (Feld "action" im Request-Body):
//   "pruefen"              → Passwort testen
//   "daten"                → Arbeitstage + Projekte im Zeitraum { von, bis } lesen
//   "baustellen"           → laufende + archivierte Baustellen
//   "baustelleAnlegen"     → neue Baustellen-Seite { name }
//   "baustelleVerschieben" → { id, ziel: "archiv" | "laufend" }
//   "korrektur"            → Arbeitstag ändern: Zeiten, Datum (verschieben), Projekte ändern/löschen/hinzufügen
//   "neuerTag"             → Tag nachtragen { mitarbeiter, datum, art, … } (normal/urlaub/krank/feiertag/schule)
//   "tagLoeschen"          → { arbeitstagIds, projektIds } in den Notion-Papierkorb
//   "zugaenge"             → Mitarbeiter mit persönlichem Link (legt die Zugänge-Datenbank beim ersten Mal an)
//   "mitarbeiterAnlegen"   → { name, farbe, azubi } neuer Mitarbeiter + Link
//   "zugangErneuern"       → { name } neuer Schlüssel, alter Link ist ungültig
//   "zugangStatus"         → { name, status: "Aktiv" | "Gesperrt" }
//   "zugangAzubi"          → { name, azubi }

import { createHash, timingSafeEqual } from "node:crypto";
import { cacheLeeren, ladeZugaenge, legeDatenbankAn, neuerSchluessel, uebergangBis } from "./_zugaenge.js";

const NOTION_VERSION = "2022-06-28";
const NOTION_VERSION_MOVE = "2026-03-11"; // der Verschiebe-Endpunkt gibt es nur in neuer API-Version

const DB_ARBEITSTAGE = "3906606acb1d802fbcd1c68844c94151";
const DB_PROJEKTE = "3906606acb1d80efa3cfc8b1312b4df2";

const MAX_TAGE_ZEITRAUM = 62;

const normId = (id) => String(id || "").replace(/-/g, "").toLowerCase();
const istDatum = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
const istZeit = (s) => typeof s === "string" && /^\d{2}:\d{2}$/.test(s);
const runde2 = (n) => Math.round(n * 100) / 100;

// Gleiche Soll-Regel wie in der Mitarbeiter-App (src/App.jsx): Mo–Do 8,5 h · Fr 6 h · Wochenende 0 h
function sollStunden(dateStr) {
  const tag = new Date(dateStr + "T12:00:00").getDay();
  if (tag === 5) return 6;
  if (tag >= 1 && tag <= 4) return 8.5;
  return 0;
}

class Fehler extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// ---------------------------------------------------------------------
// Notion-Helfer
// ---------------------------------------------------------------------
async function notion(pfad, optionen = {}, version = NOTION_VERSION) {
  const response = await fetch(`https://api.notion.com/v1/${pfad}`, {
    ...optionen,
    headers: {
      Authorization: `Bearer ${process.env.NOTION_TOKEN}`,
      "Content-Type": "application/json",
      "Notion-Version": version,
    },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Fehler(response.status === 404 ? 404 : 502, `Notion: ${data.message || "Fehler " + response.status}`);
  }
  return data;
}

async function queryAlle(dbId, filter, sorts) {
  const ergebnisse = [];
  let cursor;
  do {
    const data = await notion(`databases/${dbId}/query`, {
      method: "POST",
      body: JSON.stringify({ filter, sorts, page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) }),
    });
    ergebnisse.push(...(data.results || []));
    cursor = data.has_more ? data.next_cursor : undefined;
  } while (cursor);
  return ergebnisse;
}

async function kinderSeiten(pageId) {
  const liste = [];
  let cursor;
  do {
    const q = `page_size=100${cursor ? `&start_cursor=${cursor}` : ""}`;
    const data = await notion(`blocks/${pageId}/children?${q}`, { method: "GET" });
    for (const block of data.results || []) {
      if (block.type !== "child_page" || block.archived || block.in_trash) continue;
      liste.push({ id: block.id, name: (block.child_page?.title || "").trim() });
    }
    cursor = data.has_more ? data.next_cursor : undefined;
  } while (cursor);
  return liste;
}

// Eigenschaften lesen
const text = (p) => (p?.title || p?.rich_text || []).map((t) => t.plain_text || "").join("").trim();
const zahl = (p) => (typeof p?.number === "number" ? p.number : null);
const auswahl = (p) => p?.select?.name || "";
const datum = (p) => (p?.date?.start || "").slice(0, 10);

function arbeitstagAusSeite(s) {
  const p = s.properties || {};
  return {
    id: s.id,
    url: s.url,
    datum: datum(p.Datum),
    mitarbeiter: auswahl(p.Mitarbeiter),
    status: auswahl(p.Status) || "Normal",
    gesamt: zahl(p.Gesamtarbeitszeit) ?? 0,
    ueber: zahl(p["Überstunden"]) ?? 0,
    minus: zahl(p.Minusstunden) ?? 0,
    beginn: text(p.Arbeitsbeginn),
    ende: text(p.Arbeitsende),
    pause: zahl(p.PauseMinuten),
  };
}

function projektAusSeite(s) {
  const p = s.properties || {};
  return {
    id: s.id,
    url: s.url,
    datum: datum(p.Datum),
    mitarbeiter: auswahl(p.Mitarbeiter),
    name: text(p.Projekt),
    stunden: zahl(p.Stunden) ?? 0,
    reihenfolge: zahl(p.Reihenfolge),
    notiz: text(p.Notiz),
  };
}

const zeitraumFilter = (von, bis) => ({
  and: [
    { property: "Datum", date: { on_or_after: von } },
    { property: "Datum", date: { on_or_before: bis } },
  ],
});

// ---------------------------------------------------------------------
// Aktionen
// ---------------------------------------------------------------------
async function ladeDaten({ von, bis }) {
  if (!istDatum(von) || !istDatum(bis) || von > bis) throw new Fehler(400, "Ungültiger Zeitraum");
  const tage = (new Date(bis + "T12:00:00") - new Date(von + "T12:00:00")) / 864e5;
  if (tage > MAX_TAGE_ZEITRAUM) throw new Fehler(400, "Zeitraum zu lang");

  const sortierung = [{ property: "Datum", direction: "ascending" }];
  const [schema, arbeitstage, projekte] = await Promise.all([
    notion(`databases/${DB_ARBEITSTAGE}`, { method: "GET" }),
    queryAlle(DB_ARBEITSTAGE, zeitraumFilter(von, bis), sortierung),
    queryAlle(DB_PROJEKTE, zeitraumFilter(von, bis), sortierung),
  ]);

  // Mitarbeiter in der Reihenfolge + Farbe der Select-Optionen aus Notion
  const mitarbeiter = (schema.properties?.Mitarbeiter?.select?.options || []).map((o) => ({
    name: o.name,
    farbe: o.color || "default",
  }));

  // Gesperrte Mitarbeiter (gekündigt) – die Wochenübersicht blendet sie aus
  let gesperrt = [];
  try {
    gesperrt = (await ladeZugaenge()).liste.filter((z) => z.status === "Gesperrt").map((z) => z.name);
  } catch {
    /* Zugänge sind optional für die Anzeige */
  }

  return {
    mitarbeiter,
    gesperrt,
    arbeitstage: arbeitstage.map(arbeitstagAusSeite),
    projekte: projekte.map(projektAusSeite),
  };
}

// ---------------------------------------------------------------------
// Mitarbeiter & persönliche Links
// ---------------------------------------------------------------------
const NOTION_FARBEN = ["default", "gray", "brown", "orange", "yellow", "green", "blue", "purple", "pink", "red"];
const heute = () => new Date().toISOString().slice(0, 10);

async function zugaengeStand() {
  let stand = await ladeZugaenge({ frisch: true });
  if (!stand.dbId) {
    await legeDatenbankAn();
    stand = await ladeZugaenge({ frisch: true });
  }
  const schema = await notion(`databases/${DB_ARBEITSTAGE}`, { method: "GET" });
  const optionen = schema.properties?.Mitarbeiter?.select?.options || [];
  const namen = [...optionen.map((o) => o.name), ...stand.liste.map((z) => z.name).filter((n) => !optionen.some((o) => o.name === n))];
  return {
    uebergangBis: uebergangBis(stand),
    mitarbeiter: namen.map((name) => {
      const z = stand.liste.find((x) => x.name === name) || null;
      return {
        name,
        farbe: optionen.find((o) => o.name === name)?.color || "default",
        zugang: z && { status: z.status, schluessel: z.schluessel, erstellt: z.erstellt, azubi: z.azubi },
      };
    }),
  };
}

function zugangProperties({ name, schluessel, status, azubi }) {
  const p = {};
  if (name !== undefined) p.Name = { title: [{ text: { content: name } }] };
  if (schluessel !== undefined) {
    p["Schlüssel"] = { rich_text: [{ text: { content: schluessel } }] };
    p.Erstellt = { date: { start: heute() } };
  }
  if (status !== undefined) p.Status = { select: { name: status } };
  if (azubi !== undefined) p.Azubi = { checkbox: !!azubi };
  return p;
}

async function zugangSetzen(name, aenderung) {
  const stand = await ladeZugaenge({ frisch: true });
  if (!stand.dbId) throw new Fehler(409, "Bitte die Seite Mitarbeiter neu laden");
  const z = stand.liste.find((x) => x.name === name);
  if (z) {
    await notion(`pages/${z.id}`, { method: "PATCH", body: JSON.stringify({ properties: zugangProperties(aenderung) }) });
  } else {
    await notion("pages", {
      method: "POST",
      body: JSON.stringify({
        parent: { database_id: stand.dbId },
        properties: zugangProperties({ name, status: "Aktiv", azubi: false, schluessel: neuerSchluessel(), ...aenderung }),
      }),
    });
  }
  cacheLeeren();
  return zugaengeStand();
}

async function mitarbeiterAnlegen({ name, farbe, azubi }) {
  const sauber = String(name || "").replace(/\s+/g, " ").trim();
  if (!sauber || sauber.length > 60) throw new Fehler(400, "Bitte einen Namen (max. 60 Zeichen) eingeben");
  if (sauber.includes(",")) throw new Fehler(400, "Notion erlaubt kein Komma im Namen");
  const color = NOTION_FARBEN.includes(farbe) ? farbe : "default";
  const stand = await zugaengeStand();
  if (stand.mitarbeiter.some((m) => m.name.toLowerCase() === sauber.toLowerCase() && m.zugang)) {
    throw new Fehler(409, `"${sauber}" hat schon einen Link – dort „Neuer Link“ verwenden`);
  }

  // Auswahl-Option in beiden Datenbanken anlegen (vorhandene Optionen bleiben unverändert erhalten)
  for (const db of [DB_ARBEITSTAGE, DB_PROJEKTE]) {
    const schema = await notion(`databases/${db}`, { method: "GET" });
    const optionen = schema.properties?.Mitarbeiter?.select?.options || [];
    if (optionen.some((o) => o.name === sauber)) continue;
    await notion(`databases/${db}`, {
      method: "PATCH",
      body: JSON.stringify({
        properties: {
          Mitarbeiter: { select: { options: [...optionen.map((o) => ({ id: o.id, name: o.name, color: o.color })), { name: sauber, color }] } },
        },
      }),
    });
  }
  return zugangSetzen(sauber, { schluessel: neuerSchluessel(), status: "Aktiv", azubi: !!azubi });
}

async function baustellenStand() {
  const pageId = process.env.BAUSTELLEN_PAGE_ID;
  if (!pageId) throw new Fehler(500, "BAUSTELLEN_PAGE_ID fehlt in den Vercel-Einstellungen");
  const kinder = await kinderSeiten(pageId);
  const archivSeite = kinder.find((k) => k.name.toLowerCase() === "archiv") || null;
  const laufend = kinder.filter((k) => k !== archivSeite && k.name);
  const archiv = archivSeite ? (await kinderSeiten(archivSeite.id)).filter((k) => k.name) : [];
  const sortiere = (a, b) => a.name.localeCompare(b.name, "de");
  return { pageId, archivId: archivSeite?.id || null, laufend: laufend.sort(sortiere), archiv: archiv.sort(sortiere) };
}

const oeffentlich = ({ laufend, archiv }) => ({ laufend, archiv });

async function baustelleAnlegen({ name }) {
  const sauber = String(name || "").replace(/\s+/g, " ").trim();
  if (!sauber || sauber.length > 120) throw new Fehler(400, "Bitte einen Namen (max. 120 Zeichen) eingeben");
  const stand = await baustellenStand();
  const doppelt = [...stand.laufend, ...stand.archiv].find((b) => b.name.toLowerCase() === sauber.toLowerCase());
  if (doppelt) throw new Fehler(409, `"${doppelt.name}" gibt es schon${stand.archiv.includes(doppelt) ? " im Archiv" : ""}`);
  if (sauber.toLowerCase() === "archiv") throw new Fehler(400, "Dieser Name ist reserviert");

  await notion("pages", {
    method: "POST",
    body: JSON.stringify({
      parent: { page_id: stand.pageId },
      properties: { title: { title: [{ text: { content: sauber } }] } },
    }),
  });
  return oeffentlich(await baustellenStand());
}

async function baustelleVerschieben({ id, ziel }) {
  if (ziel !== "archiv" && ziel !== "laufend") throw new Fehler(400, "Unbekanntes Ziel");
  const stand = await baustellenStand();
  const quelle = ziel === "archiv" ? stand.laufend : stand.archiv;
  if (!quelle.some((b) => normId(b.id) === normId(id))) throw new Fehler(404, "Baustelle nicht gefunden – bitte neu laden");

  let archivId = stand.archivId;
  if (ziel === "archiv" && !archivId) {
    // Archiv-Seite fehlt noch → einmalig anlegen
    const neu = await notion("pages", {
      method: "POST",
      body: JSON.stringify({ parent: { page_id: stand.pageId }, properties: { title: { title: [{ text: { content: "Archiv" } }] } } }),
    });
    archivId = neu.id;
  }

  // Wichtig: echtes Verschieben – NICHT "archived: true", das wäre in Notion der Papierkorb.
  const zielSeite = ziel === "archiv" ? archivId : stand.pageId;
  await notion(`pages/${id}/move`, {
    method: "POST",
    body: JSON.stringify({ parent: { type: "page_id", page_id: zielSeite } }),
  }, NOTION_VERSION_MOVE);

  return oeffentlich(await baustellenStand());
}

function nettoStunden(beginn, ende, pause) {
  const [sh, sm] = beginn.split(":").map(Number);
  const [eh, em] = ende.split(":").map(Number);
  const netto = eh * 60 + em - (sh * 60 + sm) - pause;
  if (eh * 60 + em <= sh * 60 + sm || netto < 0) throw new Fehler(400, "Arbeitsende muss nach Arbeitsbeginn liegen");
  return runde2(netto / 60);
}

const WOCHENTAGE_LANG = ["Sonntag", "Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag"];
const wochentag = (d) => WOCHENTAGE_LANG[new Date(d + "T12:00:00").getDay()];
const titel = (t) => ({ title: [{ text: { content: t } }] });

async function eintraegeAm(datum, mitarbeiter) {
  const filter = {
    and: [
      { property: "Datum", date: { equals: datum } },
      { property: "Mitarbeiter", select: { equals: mitarbeiter } },
    ],
  };
  const [tage, projekte] = await Promise.all([queryAlle(DB_ARBEITSTAGE, filter), queryAlle(DB_PROJEKTE, filter)]);
  return { tage, projekte: projekte.map(projektAusSeite) };
}

// Projektliste aus dem Büro prüfen: [{ id?, name, stunden, loeschen? }]
function pruefeProjekte(projekte) {
  if (!Array.isArray(projekte)) throw new Fehler(400, "Keine Projekte übergeben");
  return projekte.map((p) => {
    const stunden = Number(p.stunden);
    if (!p.loeschen && (!Number.isFinite(stunden) || stunden < 0 || stunden > 24)) throw new Fehler(400, "Ungültige Stundenzahl");
    const name = String(p.name ?? "").replace(/\s+/g, " ").trim();
    if (!p.loeschen && (!name || name.length > 120)) throw new Fehler(400, "Bitte für jedes Projekt einen Namen angeben (max. 120 Zeichen)");
    return { id: p.id ? String(p.id) : null, name, stunden: runde2(stunden || 0), loeschen: !!p.loeschen };
  });
}

function projektProperties({ name, stunden, datum, mitarbeiter, reihenfolge }) {
  const p = {};
  if (name !== undefined) p.Projekt = titel(name);
  if (stunden !== undefined) p.Stunden = { number: stunden };
  if (datum !== undefined) p.Datum = { date: { start: datum } };
  if (mitarbeiter !== undefined) p.Mitarbeiter = { select: { name: mitarbeiter } };
  // Reihenfolge nur bei mehreren Projekten am Tag (sonst leer) – wie in der Mitarbeiter-App
  if (reihenfolge !== undefined) p.Reihenfolge = { number: reihenfolge };
  return p;
}

const saldoProperties = (diff) => ({
  // nur ≠ 0 eintragen, sonst Zelle leeren
  "Überstunden": { number: diff > 0 ? diff : null },
  Minusstunden: { number: diff < 0 ? diff : null },
});

// Korrektur eines normalen Arbeitstags:
// Uhrzeiten, Datum (Tag verschieben), Projekte ändern / löschen / hinzufügen – alles zusammen.
async function korrektur({ arbeitstagId, datum, arbeitsbeginn, arbeitsende, pauseMinuten, projekte }) {
  if (!istZeit(arbeitsbeginn) || !istZeit(arbeitsende)) throw new Fehler(400, "Bitte Beginn und Ende als HH:MM angeben");
  const pause = Number(pauseMinuten) || 0;
  if (pause < 0 || pause > 600) throw new Fehler(400, "Pause ungültig");
  const liste = pruefeProjekte(projekte);

  const seite = await notion(`pages/${arbeitstagId}`, { method: "GET" });
  if (normId(seite.parent?.database_id) !== DB_ARBEITSTAGE) throw new Fehler(403, "Kein Eintrag aus der Arbeitstage-Datenbank");
  const tag = arbeitstagAusSeite(seite);
  if (tag.status !== "Normal") throw new Fehler(400, "Nur normale Arbeitstage lassen sich hier korrigieren");

  const neuesDatum = datum === undefined || datum === tag.datum ? tag.datum : datum;
  if (!istDatum(neuesDatum)) throw new Fehler(400, "Ungültiges Datum");

  const alt = await eintraegeAm(tag.datum, tag.mitarbeiter);
  if (alt.tage.some((s) => normId(s.id) !== normId(tag.id) && auswahl(s.properties?.Status) === "Normal")) {
    throw new Fehler(409, "Für diesen Tag gibt es zwei Arbeitstag-Einträge – bitte zuerst den doppelten löschen");
  }

  // Alle vorhandenen Projekte müssen im Auftrag vorkommen (behalten oder löschen)
  const bekannt = new Map(alt.projekte.map((p) => [normId(p.id), p]));
  const genannt = new Set(liste.filter((p) => p.id).map((p) => normId(p.id)));
  if (genannt.size !== bekannt.size || ![...bekannt.keys()].every((id) => genannt.has(id)) || liste.some((p) => p.id && !bekannt.has(normId(p.id)))) {
    throw new Fehler(409, "Die Projekte haben sich inzwischen geändert – bitte neu laden");
  }

  const bleiben = liste.filter((p) => !p.loeschen);
  if (!bleiben.length) throw new Fehler(400, "Mindestens ein Projekt muss bleiben – sonst den ganzen Tag löschen");
  const netto = nettoStunden(arbeitsbeginn, arbeitsende, pause);
  const summe = runde2(bleiben.reduce((a, p) => a + p.stunden, 0));
  if (Math.abs(summe - netto) > 0.01) throw new Fehler(400, `Projektstunden (${summe} h) passen nicht zur Arbeitszeit (${netto} h)`);

  // Tag verschieben: am Zieltag darf noch nichts für diesen Mitarbeiter stehen
  if (neuesDatum !== tag.datum) {
    const ziel = await eintraegeAm(neuesDatum, tag.mitarbeiter);
    if (ziel.tage.length || ziel.projekte.length) {
      throw new Fehler(409, `${tag.mitarbeiter} hat am ${neuesDatum.split("-").reverse().join(".")} schon einen Eintrag`);
    }
  }

  const mehrere = bleiben.length > 1;
  const ids = [];
  let nr = 0;
  for (const p of liste) {
    if (p.loeschen) {
      // In den Notion-Papierkorb (dort 30 Tage wiederherstellbar)
      await notion(`pages/${p.id}`, { method: "PATCH", body: JSON.stringify({ archived: true }) });
      continue;
    }
    nr++;
    const reihenfolge = mehrere ? nr : null;
    if (p.id) {
      const vorher = bekannt.get(normId(p.id));
      const properties = {};
      if (Math.abs(p.stunden - vorher.stunden) >= 0.001) properties.Stunden = { number: p.stunden };
      if (p.name !== vorher.name) properties.Projekt = titel(p.name);
      if ((vorher.reihenfolge ?? null) !== reihenfolge) properties.Reihenfolge = { number: reihenfolge };
      if (neuesDatum !== tag.datum) properties.Datum = { date: { start: neuesDatum } };
      if (Object.keys(properties).length) await notion(`pages/${p.id}`, { method: "PATCH", body: JSON.stringify({ properties }) });
      ids.push(p.id);
    } else {
      const neu = await notion("pages", {
        method: "POST",
        body: JSON.stringify({
          parent: { database_id: DB_PROJEKTE },
          properties: projektProperties({ name: p.name, stunden: p.stunden, datum: neuesDatum, mitarbeiter: tag.mitarbeiter, ...(mehrere ? { reihenfolge } : {}) }),
        }),
      });
      ids.push(neu.id);
    }
  }

  const diff = runde2(netto - sollStunden(neuesDatum));
  await notion(`pages/${tag.id}`, {
    method: "PATCH",
    body: JSON.stringify({
      properties: {
        Tag: titel(wochentag(neuesDatum)),
        Datum: { date: { start: neuesDatum } },
        Gesamtarbeitszeit: { number: netto },
        Arbeitsbeginn: { rich_text: [{ text: { content: arbeitsbeginn } }] },
        Arbeitsende: { rich_text: [{ text: { content: arbeitsende } }] },
        PauseMinuten: { number: pause },
        ...saldoProperties(diff),
        Projekte: { relation: ids.map((id) => ({ id })) },
      },
    }),
  });

  return { ok: true, gesamt: netto, saldo: diff, datum: neuesDatum };
}

// Neuen Tag für einen Mitarbeiter anlegen (fehlender Tag, Nachtrag, Urlaub, Krank …)
const TAGESARTEN = { normal: "Normal", urlaub: "Urlaub", krank: "Krankheit", feiertag: "Feiertag", schule: "Schultag" };

async function neuerTag({ mitarbeiter, datum, art, arbeitsbeginn, arbeitsende, pauseMinuten, projekte }) {
  const status = TAGESARTEN[art];
  if (!status) throw new Fehler(400, "Unbekannte Tagesart");
  if (!istDatum(datum)) throw new Fehler(400, "Bitte ein Datum wählen");
  const name = String(mitarbeiter || "").trim();
  const schema = await notion(`databases/${DB_ARBEITSTAGE}`, { method: "GET" });
  if (!(schema.properties?.Mitarbeiter?.select?.options || []).some((o) => o.name === name)) throw new Fehler(400, "Unbekannter Mitarbeiter");

  const vorhanden = await eintraegeAm(datum, name);
  if (vorhanden.tage.length || vorhanden.projekte.length) {
    throw new Fehler(409, `${name} hat an diesem Tag schon einen Eintrag – bitte die Kachel bearbeiten`);
  }

  const soll = sollStunden(datum);
  const properties = {
    Tag: titel(wochentag(datum)),
    Datum: { date: { start: datum } },
    Mitarbeiter: { select: { name } },
    Status: { select: { name: status } },
  };

  if (status === "Normal") {
    if (!istZeit(arbeitsbeginn) || !istZeit(arbeitsende)) throw new Fehler(400, "Bitte Beginn und Ende als HH:MM angeben");
    const pause = Number(pauseMinuten) || 0;
    if (pause < 0 || pause > 600) throw new Fehler(400, "Pause ungültig");
    const liste = pruefeProjekte(projekte).filter((p) => !p.loeschen);
    if (!liste.length) throw new Fehler(400, "Bitte mindestens ein Projekt eintragen");
    const netto = nettoStunden(arbeitsbeginn, arbeitsende, pause);
    const summe = runde2(liste.reduce((a, p) => a + p.stunden, 0));
    if (Math.abs(summe - netto) > 0.01) throw new Fehler(400, `Projektstunden (${summe} h) passen nicht zur Arbeitszeit (${netto} h)`);

    const ids = [];
    const mehrere = liste.length > 1;
    for (const [i, p] of liste.entries()) {
      const neu = await notion("pages", {
        method: "POST",
        body: JSON.stringify({
          parent: { database_id: DB_PROJEKTE },
          properties: projektProperties({ name: p.name, stunden: p.stunden, datum, mitarbeiter: name, ...(mehrere ? { reihenfolge: i + 1 } : {}) }),
        }),
      });
      ids.push(neu.id);
    }
    const diff = runde2(netto - soll);
    Object.assign(properties, {
      Gesamtarbeitszeit: { number: netto },
      Arbeitsbeginn: { rich_text: [{ text: { content: arbeitsbeginn } }] },
      Arbeitsende: { rich_text: [{ text: { content: arbeitsende } }] },
      PauseMinuten: { number: pause },
      Projekte: { relation: ids.map((id) => ({ id })) },
    });
    if (diff > 0) properties["Überstunden"] = { number: diff };
    if (diff < 0) properties.Minusstunden = { number: diff };
  } else {
    // wie die Mitarbeiter-App: Urlaub/Schule 0 h, Feiertag und Krankheit = Soll des Tages
    properties.Gesamtarbeitszeit = { number: status === "Feiertag" || status === "Krankheit" ? soll : 0 };
  }

  await notion("pages", { method: "POST", body: JSON.stringify({ parent: { database_id: DB_ARBEITSTAGE }, properties }) });
  return { ok: true };
}

// Ganzen Tag eines Mitarbeiters löschen (Arbeitstag-Einträge + zugehörige Projekte) – landet im Notion-Papierkorb
async function tagLoeschen({ arbeitstagIds, projektIds }) {
  const tagIds = Array.isArray(arbeitstagIds) ? arbeitstagIds.map(String) : [];
  const projIds = Array.isArray(projektIds) ? projektIds.map(String) : [];
  if (!tagIds.length && !projIds.length) throw new Fehler(400, "Nichts zum Löschen ausgewählt");
  for (const [ids, db] of [[tagIds, DB_ARBEITSTAGE], [projIds, DB_PROJEKTE]]) {
    for (const id of ids) {
      const s = await notion(`pages/${id}`, { method: "GET" });
      if (normId(s.parent?.database_id) !== db) throw new Fehler(403, "Eintrag gehört nicht zur Zeiterfassung");
    }
  }
  for (const id of [...projIds, ...tagIds]) {
    await notion(`pages/${id}`, { method: "PATCH", body: JSON.stringify({ archived: true }) });
  }
  return { ok: true };
}

// ---------------------------------------------------------------------
// Passwort
// ---------------------------------------------------------------------
function passwortOk(headerWert) {
  const soll = process.env.BUERO_PASSWORT || "";
  if (!soll) return false;
  let eingabe = "";
  try {
    eingabe = decodeURIComponent(String(headerWert || ""));
  } catch {
    return false;
  }
  const a = createHash("sha256").update(eingabe).digest();
  const b = createHash("sha256").update(soll).digest();
  return timingSafeEqual(a, b);
}

const warte = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------
// Einstieg
// ---------------------------------------------------------------------
export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return res.status(405).end();

  if (!process.env.NOTION_TOKEN) return res.status(500).json({ message: "NOTION_TOKEN fehlt in den Vercel-Einstellungen" });
  if (!process.env.BUERO_PASSWORT) return res.status(500).json({ message: "BUERO_PASSWORT fehlt in den Vercel-Einstellungen" });

  if (!passwortOk(req.headers["x-buero-passwort"])) {
    await warte(800); // bremst Durchprobieren von Passwörtern
    return res.status(401).json({ message: "Passwort falsch" });
  }

  const { action, ...daten } = req.body || {};
  try {
    switch (action) {
      case "pruefen": return res.status(200).json({ ok: true });
      case "daten": return res.status(200).json(await ladeDaten(daten));
      case "baustellen": return res.status(200).json(oeffentlich(await baustellenStand()));
      case "baustelleAnlegen": return res.status(200).json(await baustelleAnlegen(daten));
      case "baustelleVerschieben": return res.status(200).json(await baustelleVerschieben(daten));
      case "korrektur": return res.status(200).json(await korrektur(daten));
      case "neuerTag": return res.status(200).json(await neuerTag(daten));
      case "tagLoeschen": return res.status(200).json(await tagLoeschen(daten));
      case "zugaenge": return res.status(200).json(await zugaengeStand());
      case "mitarbeiterAnlegen": return res.status(200).json(await mitarbeiterAnlegen(daten));
      case "zugangErneuern": return res.status(200).json(await zugangSetzen(String(daten.name || ""), { schluessel: neuerSchluessel() }));
      case "zugangStatus":
        if (daten.status !== "Aktiv" && daten.status !== "Gesperrt") return res.status(400).json({ message: "Unbekannter Status" });
        return res.status(200).json(await zugangSetzen(String(daten.name || ""), { status: daten.status }));
      case "zugangAzubi": return res.status(200).json(await zugangSetzen(String(daten.name || ""), { azubi: !!daten.azubi }));
      default: return res.status(400).json({ message: "Unbekannte Aktion" });
    }
  } catch (e) {
    if (e instanceof Fehler || typeof e?.status === "number") return res.status(e.status).json({ message: e.message });
    return res.status(502).json({ message: "Notion nicht erreichbar" });
  }
}
