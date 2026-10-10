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
//   "korrektur"            → Arbeitstag + Projektstunden gemeinsam ändern

import { createHash, timingSafeEqual } from "node:crypto";

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

  return {
    mitarbeiter,
    arbeitstage: arbeitstage.map(arbeitstagAusSeite),
    projekte: projekte.map(projektAusSeite),
  };
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

async function korrektur({ arbeitstagId, arbeitsbeginn, arbeitsende, pauseMinuten, projekte }) {
  if (!istZeit(arbeitsbeginn) || !istZeit(arbeitsende)) throw new Fehler(400, "Bitte Beginn und Ende als HH:MM angeben");
  const pause = Number(pauseMinuten) || 0;
  if (pause < 0 || pause > 600) throw new Fehler(400, "Pause ungültig");
  if (!Array.isArray(projekte) || projekte.length === 0) throw new Fehler(400, "Keine Projektstunden übergeben");

  const seite = await notion(`pages/${arbeitstagId}`, { method: "GET" });
  if (normId(seite.parent?.database_id) !== DB_ARBEITSTAGE) throw new Fehler(403, "Kein Eintrag aus der Arbeitstage-Datenbank");
  const tag = arbeitstagAusSeite(seite);
  if (tag.status !== "Normal") throw new Fehler(400, "Nur normale Arbeitstage lassen sich hier korrigieren");

  // Alle Projekte dieses Mitarbeiters an diesem Tag – die Korrektur muss alle enthalten
  const vorhandene = (await queryAlle(DB_PROJEKTE, {
    and: [
      { property: "Datum", date: { equals: tag.datum } },
      { property: "Mitarbeiter", select: { equals: tag.mitarbeiter } },
    ],
  })).map(projektAusSeite);

  const andereNormal = (await queryAlle(DB_ARBEITSTAGE, {
    and: [
      { property: "Datum", date: { equals: tag.datum } },
      { property: "Mitarbeiter", select: { equals: tag.mitarbeiter } },
      { property: "Status", select: { equals: "Normal" } },
    ],
  })).filter((s) => normId(s.id) !== normId(tag.id));
  if (andereNormal.length) throw new Fehler(409, "Für diesen Tag gibt es zwei Arbeitstag-Einträge – bitte zuerst in Notion bereinigen");

  const neu = new Map();
  for (const p of projekte) {
    const stunden = Number(p.stunden);
    if (!Number.isFinite(stunden) || stunden < 0 || stunden > 24) throw new Fehler(400, "Ungültige Stundenzahl");
    neu.set(normId(p.id), runde2(stunden));
  }
  if (neu.size !== vorhandene.length || !vorhandene.every((p) => neu.has(normId(p.id)))) {
    throw new Fehler(409, "Die Projekte haben sich inzwischen geändert – bitte neu laden");
  }

  const netto = nettoStunden(arbeitsbeginn, arbeitsende, pause);
  const summe = runde2([...neu.values()].reduce((a, b) => a + b, 0));
  if (Math.abs(summe - netto) > 0.01) {
    throw new Fehler(400, `Projektstunden (${summe} h) passen nicht zur Arbeitszeit (${netto} h)`);
  }

  // Projekte zuerst, dann den Arbeitstag (gleiche Regeln wie die Mitarbeiter-App)
  for (const p of vorhandene) {
    const stunden = neu.get(normId(p.id));
    if (Math.abs(stunden - p.stunden) < 0.001) continue;
    await notion(`pages/${p.id}`, { method: "PATCH", body: JSON.stringify({ properties: { Stunden: { number: stunden } } }) });
  }

  const diff = runde2(netto - sollStunden(tag.datum));
  await notion(`pages/${tag.id}`, {
    method: "PATCH",
    body: JSON.stringify({
      properties: {
        Gesamtarbeitszeit: { number: netto },
        Arbeitsbeginn: { rich_text: [{ text: { content: arbeitsbeginn } }] },
        Arbeitsende: { rich_text: [{ text: { content: arbeitsende } }] },
        PauseMinuten: { number: pause },
        // nur ≠ 0 eintragen, sonst Zelle leeren
        "Überstunden": { number: diff > 0 ? diff : null },
        Minusstunden: { number: diff < 0 ? diff : null },
      },
    }),
  });

  return { ok: true, gesamt: netto, saldo: diff };
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
      default: return res.status(400).json({ message: "Unbekannte Aktion" });
    }
  } catch (e) {
    if (e instanceof Fehler) return res.status(e.status).json({ message: e.message });
    return res.status(502).json({ message: "Notion nicht erreichbar" });
  }
}
