// Vercel Serverless Function: sicherer Proxy zur Notion-API
//
// Der Notion-Schlüssel liegt NUR hier auf dem Server (Vercel-Umgebungsvariable
// NOTION_TOKEN) und wird nie an die Handys ausgeliefert.
//
// Benötigte Umgebungsvariablen in Vercel (Settings → Environment Variables):
//   NOTION_TOKEN        = Secret der Notion-Integration
//   BAUSTELLEN_PAGE_ID  = ID der Notion-Seite "Baustellen" (32 Zeichen aus dem Link)
//
// Unterstützte Aktionen (Feld "action" im Request-Body):
//   "createPage" (Standard) → legt einen Eintrag in Arbeitstage- oder Projekte-DB an
//   "baustellen"            → liefert die Unterseiten der Seite "Baustellen" als Liste

const NOTION_VERSION = "2022-06-28";

// Nur in diese Datenbanken darf über den Proxy geschrieben werden
const ERLAUBTE_DATENBANKEN = [
  "3906606acb1d802fbcd1c68844c94151", // Arbeitstage
  "3906606acb1d80efa3cfc8b1312b4df2", // Projekte
];

const normId = (id) => String(id || "").replace(/-/g, "").toLowerCase();

async function notion(pfad, token, optionen = {}) {
  const response = await fetch(`https://api.notion.com/v1/${pfad}`, {
    ...optionen,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "Notion-Version": NOTION_VERSION,
    },
  });
  const data = await response.json().catch(() => ({}));
  return { status: response.status, ok: response.ok, data };
}

// Alle direkten Unterseiten der Baustellen-Seite lesen (ohne "Archiv")
async function ladeBaustellen(token, pageId) {
  const liste = [];
  let cursor = undefined;
  do {
    const query = `page_size=100${cursor ? `&start_cursor=${cursor}` : ""}`;
    const r = await notion(`blocks/${pageId}/children?${query}`, token, { method: "GET" });
    if (!r.ok) return r;
    for (const block of r.data.results || []) {
      if (block.type !== "child_page") continue;
      if (block.archived || block.in_trash) continue;
      const name = (block.child_page?.title || "").trim();
      if (!name || name.toLowerCase() === "archiv") continue;
      liste.push({ id: block.id, name });
    }
    cursor = r.data.has_more ? r.data.next_cursor : undefined;
  } while (cursor);

  liste.sort((a, b) => a.name.localeCompare(b.name, "de"));
  return { ok: true, status: 200, data: { baustellen: liste } };
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", "no-store");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).end();

  const token = process.env.NOTION_TOKEN;
  if (!token) {
    return res.status(500).json({ message: "NOTION_TOKEN fehlt in den Vercel-Einstellungen" });
  }

  // Ältere App-Versionen schicken noch { token, body } ohne "action" –
  // das wird weiterhin als "createPage" behandelt (der mitgeschickte Token wird ignoriert).
  const { action = "createPage", body } = req.body || {};

  try {
    if (action === "baustellen") {
      const pageId = process.env.BAUSTELLEN_PAGE_ID;
      if (!pageId) return res.status(200).json({ baustellen: [], hinweis: "BAUSTELLEN_PAGE_ID nicht gesetzt" });
      const r = await ladeBaustellen(token, pageId);
      return res.status(r.status).json(r.data);
    }

    if (action === "createPage") {
      const dbId = normId(body?.parent?.database_id);
      if (!ERLAUBTE_DATENBANKEN.includes(dbId)) {
        return res.status(403).json({ message: "Diese Datenbank ist nicht freigegeben" });
      }
      const r = await notion("pages", token, { method: "POST", body: JSON.stringify(body) });
      return res.status(r.status).json(r.data);
    }

    return res.status(400).json({ message: "Unbekannte Aktion" });
  } catch {
    return res.status(502).json({ message: "Notion nicht erreichbar" });
  }
}
