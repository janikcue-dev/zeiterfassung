// Gemeinsamer Baustein für Mitarbeiter-Zugänge (persönliche Links mit Schlüssel).
// Dateien mit "_" am Anfang werden von Vercel NICHT als eigene Adresse veröffentlicht.
//
// Die Zugänge stehen in einer Notion-Datenbank "Zugänge Zeiterfassung":
//   Name (Titel) · Schlüssel (Text) · Status (Aktiv/Gesperrt) · Erstellt (Datum) · Azubi (Checkbox)
// Sie wird vom Büro-Bereich beim ersten Öffnen der Seite "Mitarbeiter" automatisch angelegt,
// als Unterseite von ZUGAENGE_PARENT_PAGE_ID (falls gesetzt) bzw. der Seite "Laufende Baustellen".
//
// Übergang: Alte Links ohne Schlüssel funktionieren noch 7 Tage ab Anlegen dieser Datenbank.

import { randomBytes } from "node:crypto";

const NOTION_VERSION = "2022-06-28";
export const DB_ARBEITSTAGE = "3906606acb1d802fbcd1c68844c94151";
export const DB_PROJEKTE = "3906606acb1d80efa3cfc8b1312b4df2";
export const ZUGAENGE_TITEL = "Zugänge Zeiterfassung";
export const UEBERGANG_TAGE = 7;
const CACHE_MS = 60 * 1000; // Sperren/Erneuern wirkt spätestens nach 1 Minute

export class ZugangFehler extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function notion(pfad, optionen = {}) {
  const response = await fetch(`https://api.notion.com/v1/${pfad}`, {
    ...optionen,
    headers: {
      Authorization: `Bearer ${process.env.NOTION_TOKEN}`,
      "Content-Type": "application/json",
      "Notion-Version": NOTION_VERSION,
    },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new ZugangFehler(502, `Notion: ${data.message || "Fehler " + response.status}`);
  return data;
}

const elternSeite = () => process.env.ZUGAENGE_PARENT_PAGE_ID || process.env.BAUSTELLEN_PAGE_ID;
const text = (p) => (p?.title || p?.rich_text || []).map((t) => t.plain_text || "").join("").trim();

function zugangAusSeite(s) {
  const p = s.properties || {};
  return {
    id: s.id,
    name: text(p.Name),
    schluessel: text(p["Schlüssel"]),
    status: p.Status?.select?.name || "Aktiv",
    erstellt: (p.Erstellt?.date?.start || "").slice(0, 10),
    azubi: !!p.Azubi?.checkbox,
  };
}

let cache = { zeit: 0, dbId: undefined, dbErstellt: null, liste: [] };

export function cacheLeeren() {
  cache = { ...cache, zeit: 0, dbErstellt: null };
}

// Datenbank suchen (unter der Elternseite). Gibt null zurück, wenn es sie noch nicht gibt.
async function findeDatenbank() {
  const parent = elternSeite();
  if (!parent) return null;
  let cursor;
  do {
    const q = `page_size=100${cursor ? `&start_cursor=${cursor}` : ""}`;
    const data = await notion(`blocks/${parent}/children?${q}`, { method: "GET" });
    for (const b of data.results || []) {
      if (b.type === "child_database" && !b.archived && !b.in_trash && (b.child_database?.title || "").trim() === ZUGAENGE_TITEL) {
        return b.id;
      }
    }
    cursor = data.has_more ? data.next_cursor : undefined;
  } while (cursor);
  return null;
}

export async function legeDatenbankAn() {
  const parent = elternSeite();
  if (!parent) throw new ZugangFehler(500, "BAUSTELLEN_PAGE_ID fehlt in den Vercel-Einstellungen");
  const db = await notion("databases", {
    method: "POST",
    body: JSON.stringify({
      parent: { type: "page_id", page_id: parent },
      title: [{ type: "text", text: { content: ZUGAENGE_TITEL } }],
      properties: {
        Name: { title: {} },
        "Schlüssel": { rich_text: {} },
        Status: { select: { options: [{ name: "Aktiv", color: "green" }, { name: "Gesperrt", color: "red" }] } },
        Erstellt: { date: {} },
        Azubi: { checkbox: {} },
      },
    }),
  });
  cache = { zeit: 0, dbId: db.id, dbErstellt: db.created_time || new Date().toISOString(), liste: [] };
  return db.id;
}

// Alle Zugänge laden (mit kurzem Zwischenspeicher pro Server-Instanz)
export async function ladeZugaenge({ frisch = false } = {}) {
  if (!frisch && cache.dbId !== undefined && Date.now() - cache.zeit < CACHE_MS) return cache;

  let dbId = cache.dbId;
  if (!dbId) dbId = await findeDatenbank();
  if (!dbId) {
    cache = { zeit: Date.now(), dbId: null, dbErstellt: null, liste: [] };
    return cache;
  }

  let dbErstellt = cache.dbErstellt;
  if (!dbErstellt || dbId !== cache.dbId) dbErstellt = (await notion(`databases/${dbId}`, { method: "GET" })).created_time;

  const liste = [];
  let cursor;
  do {
    const data = await notion(`databases/${dbId}/query`, {
      method: "POST",
      body: JSON.stringify({ page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) }),
    });
    for (const s of data.results || []) liste.push(zugangAusSeite(s));
    cursor = data.has_more ? data.next_cursor : undefined;
  } while (cursor);

  cache = { zeit: Date.now(), dbId, dbErstellt, liste };
  return cache;
}

export function uebergangBis(stand) {
  if (!stand.dbErstellt) return null; // noch nicht eingerichtet
  return new Date(new Date(stand.dbErstellt).getTime() + UEBERGANG_TAGE * 864e5).toISOString();
}

export function neuerSchluessel() {
  return randomBytes(18).toString("base64url"); // 24 Zeichen, nicht erratbar
}

// Prüft einen Aufruf der Mitarbeiter-App. Liefert den Namen, unter dem gebucht werden darf.
//   schluessel vorhanden → muss zu einem aktiven Zugang passen (Name kommt vom Server)
//   ohne Schlüssel       → nur bis Übergangsende bzw. solange das System noch nicht eingerichtet ist
export async function pruefeMitarbeiter({ schluessel, nameAusLink }) {
  const stand = await ladeZugaenge();
  const UNGUELTIG = "Dein Link ist nicht mehr gültig. Bitte den neuen Link vom Büro öffnen.";

  if (schluessel) {
    let z = stand.liste.find((x) => x.schluessel && x.schluessel === schluessel);
    if (!z) z = (await ladeZugaenge({ frisch: true })).liste.find((x) => x.schluessel && x.schluessel === schluessel);
    if (!z || z.status !== "Aktiv") throw new ZugangFehler(401, UNGUELTIG, "LINK_UNGUELTIG");
    return { name: z.name, azubi: z.azubi };
  }

  // Alter Link ohne Schlüssel
  const name = String(nameAusLink || "").trim();
  const bis = uebergangBis(stand);
  if (bis && Date.now() > new Date(bis).getTime()) throw new ZugangFehler(401, UNGUELTIG, "LINK_UNGUELTIG");
  if (stand.liste.some((x) => x.name === name && x.status !== "Aktiv")) throw new ZugangFehler(401, UNGUELTIG, "LINK_UNGUELTIG");
  return { name, azubi: null, alt: true };
}
