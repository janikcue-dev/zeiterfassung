import { useState, useEffect, useRef } from "react";

// =====================================================================
// Zeiterfassung – Malermeister Cürten
// Design: finale Design-Sprache der Mitarbeiter-App
// Notion-Zugriff läuft ausschließlich über /api/notion (Schlüssel liegt in Vercel)
// =====================================================================

const STORAGE_KEY = "zeiterfassung_eintraege";
const BAUSTELLEN_CACHE_KEY = "baustellen_cache";
const BAUSTELLEN_MAX_ALTER_MS = 15 * 60 * 1000; // nach 15 Min. im Hintergrund neu laden

const NOTION_DB_ARBEITSTAGE = "3906606acb1d802fbcd1c68844c94151";
const NOTION_DB_PROJEKTE = "3906606acb1d80efa3cfc8b1312b4df2";

// Soll-Arbeitszeiten pro Wochentag (0=So ... 6=Sa)
function sollStunden(dateStr) {
  const tag = new Date(dateStr + "T12:00:00").getDay();
  if (tag === 5) return 6; // Freitag
  if (tag >= 1 && tag <= 4) return 8.5; // Mo-Do
  return 0; // Wochenende
}

// Mitarbeiter aus URL lesen und merken (PWA startet oft ohne Parameter)
function getMitarbeiter() {
  const params = new URLSearchParams(window.location.search);
  const ausUrl = params.get("mitarbeiter");
  if (ausUrl) {
    localStorage.setItem("mitarbeiter_name", ausUrl);
    return ausUrl;
  }
  return localStorage.getItem("mitarbeiter_name") || "";
}

// Azubi-Kennzeichen (?azubi=1) – gleiches Prinzip
function getIstAzubi() {
  const params = new URLSearchParams(window.location.search);
  if (params.has("azubi")) {
    const val = params.get("azubi") === "1";
    localStorage.setItem("ist_azubi", val ? "1" : "0");
    return val;
  }
  return localStorage.getItem("ist_azubi") === "1";
}

function berechneArbeitszeit(start, end, pauseMin) {
  if (!start || !end) return null;
  const [sh, sm] = start.split(":").map(Number);
  const [eh, em] = end.split(":").map(Number);
  const startMin = sh * 60 + sm;
  const endMin = eh * 60 + em;
  if (endMin <= startMin) return null;
  const nettoMin = endMin - startMin - (parseFloat(pauseMin) || 0);
  if (nettoMin < 0) return null;
  const h = Math.floor(nettoMin / 60);
  const m = Math.round(nettoMin % 60);
  return { h, m, dezimal: (nettoMin / 60).toFixed(2) };
}

function formatDate(dateStr) {
  if (!dateStr) return "";
  const [y, m, d] = dateStr.split("-");
  return `${d}.${m}.${y}`;
}

// --- Datums-Helfer (lokale Zeitzone, nicht UTC) ---
function toDateStr(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const t = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${t}`;
}

function heuteDatumStr() {
  return toDateStr(new Date());
}

const MONATSNAMEN = ["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober", "November", "Dezember"];
const WOCHENTAGE_KURZ = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"];
const WOCHENTAGE_LANG = ["Sonntag", "Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag"];

function getMonatsTage(jahr, monat) {
  const ersterTag = new Date(jahr, monat, 1);
  const anzahlTage = new Date(jahr, monat + 1, 0).getDate();
  let startOffset = ersterTag.getDay();
  startOffset = startOffset === 0 ? 6 : startOffset - 1;
  const tage = [];
  for (let i = 0; i < startOffset; i++) tage.push(null);
  for (let t = 1; t <= anzahlTage; t++) tage.push(new Date(jahr, monat, t));
  return tage;
}

// "entry" = erfasst (grün) · "missing" = vergangener Werktag ohne Eintrag (rot) · "neutral"
function tagStatus(dateStr, eintraege, heute) {
  if (eintraege.some((e) => e.datum === dateStr)) return "entry";
  if (dateStr >= heute) return "neutral";
  const dow = new Date(dateStr + "T12:00:00").getDay();
  if (dow === 0 || dow === 6) return "neutral";
  return "missing";
}

// --- Lokaler Speicher (Offline-Queue) ---
function ladeEintraege() {
  try {
    const roh = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
    return roh.map((e) => ({
      ...e,
      syncStatus: e.syncStatus || "synced",
      notionRequests: e.notionRequests || [],
      projektPageIds: e.projektPageIds || [],
      lastError: e.lastError || null,
    }));
  } catch {
    return [];
  }
}

function speichereEintraege(liste) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(liste));
}

// --- Baustellen-Liste (aus Notion, lokal zwischengespeichert) ---
function ladeBaustellenCache() {
  try {
    const c = JSON.parse(localStorage.getItem(BAUSTELLEN_CACHE_KEY) || "null");
    if (c && Array.isArray(c.liste)) return c;
  } catch {
    /* ignorieren */
  }
  return { zeit: 0, liste: [] };
}

// --- Notion-Request-Bausteine ---
// Über-/Minusstunden werden nur geschrieben, wenn sie ≠ 0 sind (sonst bleibt die Zelle leer).
function baueArbeitstagRequest(datum, statusLabel, gesamtStd, mitarbeiter, zeiten, mitRelation, plusMinus) {
  const wochentag = WOCHENTAGE_LANG[new Date(datum + "T12:00:00").getDay()];

  const properties = {
    Tag: { title: [{ text: { content: wochentag } }] },
    Datum: { date: { start: datum } },
    Gesamtarbeitszeit: { number: gesamtStd },
    Mitarbeiter: { select: { name: mitarbeiter } },
    Status: { select: { name: statusLabel } },
  };

  if (plusMinus && plusMinus.ueber !== 0) properties.Überstunden = { number: plusMinus.ueber };
  if (plusMinus && plusMinus.minus !== 0) properties.Minusstunden = { number: plusMinus.minus };

  if (zeiten) {
    properties.Arbeitsbeginn = { rich_text: [{ text: { content: zeiten.arbeitsbeginn } }] };
    properties.Arbeitsende = { rich_text: [{ text: { content: zeiten.arbeitsende } }] };
    properties.PauseMinuten = { number: zeiten.pauseMinuten };
  }

  return {
    typ: "arbeitstag",
    mitRelation: !!mitRelation,
    body: { parent: { database_id: NOTION_DB_ARBEITSTAGE }, properties },
  };
}

// Reihenfolge wird nur geschrieben, wenn an dem Tag mehrere Projekte erfasst wurden.
function baueProjektRequest(datum, proj, mitarbeiter, mehrereProjekte) {
  return {
    typ: "projekt",
    body: {
      parent: { database_id: NOTION_DB_PROJEKTE },
      properties: {
        Projekt: { title: [{ text: { content: proj.name } }] },
        Datum: { date: { start: datum } },
        Stunden: { number: proj.stunden },
        Mitarbeiter: { select: { name: mitarbeiter } },
        ...(mehrereProjekte ? { Reihenfolge: { number: proj.reihenfolge } } : {}),
        ...(proj.notiz ? { Notiz: { rich_text: [{ text: { content: proj.notiz } }] } } : {}),
      },
    },
  };
}

const emptyProjekt = () => ({ id: Date.now() + Math.random(), name: "", stunden: "", notiz: "" });

const initialForm = {
  tagesart: "normal", // normal | urlaub | feiertag | krank | schule
  datum: heuteDatumStr(),
  arbeitsbeginn: "",
  arbeitsende: "",
  pauseMinuten: "", // bewusst leer – wird als 0 gespeichert, wenn nichts eingetragen ist
  krankTeilstunden: "",
  projekte: [emptyProjekt()],
};

const TAGESARTEN_BASIS = [
  { key: "normal", label: "Normal", icon: "💼" },
  { key: "urlaub", label: "Urlaub", icon: "🏖️" },
  { key: "feiertag", label: "Feiertag", icon: "🎉" },
  { key: "krank", label: "Krank", icon: "🤒" },
];
const TAGESART_SCHULE = { key: "schule", label: "Schule", icon: "🎓" };

// =====================================================================
// Icons (inline SVG)
// =====================================================================
function IconUhr({ color = "#0A84FF", size = 26 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  );
}

function IconListe({ color, size = 20 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2.2" strokeLinecap="round">
      <path d="M8 6h12M8 12h12M8 18h12" />
      <circle cx="4" cy="6" r="1" fill={color} />
      <circle cx="4" cy="12" r="1" fill={color} />
      <circle cx="4" cy="18" r="1" fill={color} />
    </svg>
  );
}

function IconMond({ color, size = 20 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z" />
    </svg>
  );
}

function IconSonne({ color, size = 20 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2.2" strokeLinecap="round">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </svg>
  );
}

function IconBaustelle({ color, size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 21h18M5 21V10l7-5 7 5v11" />
      <path d="M10 21v-6h4v6" />
    </svg>
  );
}

// =====================================================================
// Projektfeld mit Baustellen-Vorschlägen (Freitext bleibt immer möglich)
// =====================================================================
function ProjektEingabe({ value, onChange, baustellen, s, c }) {
  const [offen, setOffen] = useState(false);
  const blurTimer = useRef(null);

  const suche = value.trim().toLowerCase();
  const treffer = baustellen
    .filter((b) => !suche || b.name.toLowerCase().includes(suche))
    .filter((b) => b.name.toLowerCase() !== suche);

  const istBaustelle = baustellen.some((b) => b.name.toLowerCase() === suche);

  return (
    <div style={{ position: "relative" }}>
      <input
        style={{ ...s.input, paddingRight: istBaustelle ? 36 : 14 }}
        type="text"
        placeholder={baustellen.length ? "Baustelle oder Projekt" : "Projektname"}
        value={value}
        autoComplete="off"
        onChange={(e) => { onChange(e.target.value); setOffen(true); }}
        onFocus={() => { clearTimeout(blurTimer.current); setOffen(true); }}
        onBlur={() => { blurTimer.current = setTimeout(() => setOffen(false), 150); }}
      />
      {istBaustelle && (
        <span style={s.baustelleHaken} title="Baustelle aus der Liste">
          <IconBaustelle color="#23913B" />
        </span>
      )}
      {offen && treffer.length > 0 && (
        <div style={s.vorschlagListe}>
          {treffer.map((b) => (
            <button
              key={b.id}
              type="button"
              style={s.vorschlagItem}
              onClick={() => { onChange(b.name); setOffen(false); }}
            >
              <span style={s.vorschlagIcon}><IconBaustelle color="#23913B" size={14} /></span>
              <span style={{ flex: 1, textAlign: "left", color: c.text }}>{b.name}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// =====================================================================
// Eintrags-Kachel (Liste + Kalender-Tagesvorschau)
// =====================================================================
function EintragKarte({ e, s, TAGESARTEN, zeigeDelete, onDelete }) {
  const art = TAGESARTEN.find((t) => t.key === e.tagesart);
  return (
    <div style={s.entryCard}>
      <div style={s.entryHeader}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={s.entryDate}>
            {formatDate(e.datum)}
            {e.tagesart && e.tagesart !== "normal" && art && (
              <span style={s.tagBadge}>{art.icon} {art.label}</span>
            )}
            {e.syncStatus === "synced" ? (
              <span style={{ ...s.syncBadge, ...s.syncOk }}>✓ Gesendet</span>
            ) : (
              <span style={{ ...s.syncBadge, ...s.syncPending }}>⏳ Ausstehend</span>
            )}
          </div>
          {e.tagesart === "normal" && e.arbeitsbeginn && (
            <div style={s.entryMeta}>{e.arbeitsbeginn} – {e.arbeitsende} · {e.pauseMinuten || 0} Min. Pause</div>
          )}
          {e.lastError && e.syncStatus === "pending" && (
            <div style={{ ...s.entryMeta, color: "#E5484D" }}>⚠️ {e.lastError}</div>
          )}
          {e.projekte && e.projekte.length > 0 && (
            <div style={s.projektList}>
              {e.projekte.map((p, i) => (
                <div key={i} style={s.projektItem}>
                  <span style={s.projektNr}>{p.reihenfolge || i + 1}</span>
                  <span style={s.projektName}>{p.name}{p.notiz ? ` – ${p.notiz}` : ""}</span>
                  {p.stunden > 0 && <span style={s.projektStunden}>{p.stunden}h</span>}
                </div>
              ))}
            </div>
          )}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
          <div style={s.entryHours}>{e.gesamtArbeitszeitFormatiert}</div>
          {zeigeDelete && e.syncStatus === "pending" && (
            <button style={s.deleteBtn} onClick={() => onDelete(e.id)}>✕</button>
          )}
        </div>
      </div>
    </div>
  );
}

// =====================================================================
// App
// =====================================================================
export default function App() {
  const [form, setForm] = useState(initialForm);
  const [eintraege, setEintraege] = useState([]);
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState(null);
  const [darkMode, setDarkMode] = useState(() => localStorage.getItem("dark_mode") === "true");
  const [duplikatWarnung, setDuplikatWarnung] = useState(null);
  const [isOnline, setIsOnline] = useState(navigator.onLine);
  const [zeigeEintraege, setZeigeEintraege] = useState(false);
  const [syncLaeuft, setSyncLaeuft] = useState(false);
  const [baustellen, setBaustellen] = useState(() => ladeBaustellenCache().liste);
  const [baustellenLaden, setBaustellenLaden] = useState(false);
  const [kalenderDatum, setKalenderDatum] = useState(() => {
    const d = new Date();
    return { jahr: d.getFullYear(), monat: d.getMonth() };
  });
  const [vorschauTag, setVorschauTag] = useState(null);
  const [logoFehlt, setLogoFehlt] = useState(false);

  const mitarbeiter = getMitarbeiter();
  const istAzubi = getIstAzubi();
  const TAGESARTEN = istAzubi ? [...TAGESARTEN_BASIS, TAGESART_SCHULE] : TAGESARTEN_BASIS;
  const submittingRef = useRef(false);
  const syncingRef = useRef(false);
  const touchStartX = useRef(null);
  const toastTimer = useRef(null);

  useEffect(() => {
    const geladen = ladeEintraege();
    setEintraege(geladen);
    speichereEintraege(geladen);

    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch(() => {});
    }

    const onOnline = () => {
      setIsOnline(true);
      syncPending();
    };
    const onOffline = () => setIsOnline(false);

    // Zurück aus dem Hintergrund: Baustellen neu laden, wenn älter als 15 Minuten
    const onSichtbar = () => {
      if (document.visibilityState !== "visible") return;
      if (Date.now() - ladeBaustellenCache().zeit > BAUSTELLEN_MAX_ALTER_MS) aktualisiereBaustellen();
      syncPending();
    };

    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    document.addEventListener("visibilitychange", onSichtbar);

    syncPending();
    aktualisiereBaustellen(); // beim App-Start einmal laden

    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
      document.removeEventListener("visibilitychange", onSichtbar);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const s = getStyles(darkMode);
  const c = s.c;

  const arbeitszeit = berechneArbeitszeit(form.arbeitsbeginn, form.arbeitsende, form.pauseMinuten);
  const soll = sollStunden(form.datum);
  const pendingCount = eintraege.filter((e) => e.syncStatus === "pending").length;
  const heute = heuteDatumStr();

  function toggleDarkMode() {
    setDarkMode((d) => {
      localStorage.setItem("dark_mode", (!d).toString());
      return !d;
    });
  }

  async function aktualisiereBaustellen() {
    if (!navigator.onLine) return;
    setBaustellenLaden(true);
    try {
      const res = await fetch("/api/notion", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "baustellen" }),
      });
      if (res.ok) {
        const daten = await res.json();
        if (Array.isArray(daten.baustellen)) {
          localStorage.setItem(BAUSTELLEN_CACHE_KEY, JSON.stringify({ zeit: Date.now(), liste: daten.baustellen }));
          setBaustellen(daten.baustellen);
        }
      }
    } catch {
      /* offline – zwischengespeicherte Liste bleibt */
    }
    setBaustellenLaden(false);
  }

  function handleChange(e) {
    setForm((f) => ({ ...f, [e.target.name]: e.target.value }));
  }

  function setTagesart(art) {
    setForm((f) => ({ ...f, tagesart: art }));
  }

  function handleProjektChange(id, field, value) {
    setForm((f) => ({
      ...f,
      projekte: f.projekte.map((p) => (p.id === id ? { ...p, [field]: value } : p)),
    }));
  }

  function addProjekt() {
    setForm((f) => ({ ...f, projekte: [...f.projekte, emptyProjekt()] }));
  }

  function removeProjekt(id) {
    setForm((f) => ({
      ...f,
      projekte: f.projekte.length > 1 ? f.projekte.filter((p) => p.id !== id) : f.projekte,
    }));
  }

  function showStatus(type, msg) {
    clearTimeout(toastTimer.current);
    setStatus({ type, msg });
    toastTimer.current = setTimeout(() => setStatus(null), 4500);
  }

  function resetForm() {
    setForm({ ...initialForm, datum: form.datum, projekte: [emptyProjekt()] });
  }

  function beendeVorgang() {
    setLoading(false);
    submittingRef.current = false;
  }

  // --- Kalender ---
  function vorherigerMonat() {
    setKalenderDatum((k) => {
      let monat = k.monat - 1, jahr = k.jahr;
      if (monat < 0) { monat = 11; jahr -= 1; }
      return { jahr, monat };
    });
  }

  function naechsterMonat() {
    setKalenderDatum((k) => {
      let monat = k.monat + 1, jahr = k.jahr;
      if (monat > 11) { monat = 0; jahr += 1; }
      return { jahr, monat };
    });
  }

  function heuteAnzeigen() {
    const d = new Date();
    setKalenderDatum({ jahr: d.getFullYear(), monat: d.getMonth() });
    setForm((f) => ({ ...f, datum: heuteDatumStr() }));
  }

  function onTouchStart(e) {
    touchStartX.current = e.touches[0].clientX;
  }

  function onTouchEnd(e) {
    if (touchStartX.current === null) return;
    const dx = e.changedTouches[0].clientX - touchStartX.current;
    if (Math.abs(dx) > 45) {
      if (dx < 0) naechsterMonat();
      else vorherigerMonat();
    }
    touchStartX.current = null;
  }

  function onTagKlick(dateStr) {
    setForm((f) => ({ ...f, datum: dateStr }));
    const amTag = eintraege.filter((e) => e.datum === dateStr);
    if (amTag.length > 0) setVorschauTag({ datum: dateStr, eintraege: amTag });
  }

  // --- Sync: ausstehende Notion-Requests abarbeiten ---
  async function syncPending() {
    if (syncingRef.current) return;
    if (!navigator.onLine) return;
    syncingRef.current = true;
    setSyncLaeuft(true);

    const liste = ladeEintraege();
    let netzwerkProblem = false;

    for (const e of liste) {
      if (e.syncStatus !== "pending") continue;
      if (netzwerkProblem) break;

      while (e.notionRequests.length > 0) {
        const req = e.notionRequests[0];

        // Arbeitstag bekommt die gesammelten Projekt-IDs als Relation "Projekte"
        let sendeBody = { action: "createPage", body: req.body };
        if (req.mitRelation && e.projektPageIds && e.projektPageIds.length > 0) {
          sendeBody = JSON.parse(JSON.stringify(sendeBody));
          sendeBody.body.properties.Projekte = {
            relation: e.projektPageIds.map((pid) => ({ id: pid })),
          };
        }

        try {
          const res = await fetch("/api/notion", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(sendeBody),
          });
          if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            e.lastError = err.message || `Notion Fehler ${res.status}`;
            break;
          }

          if (req.typ === "projekt") {
            const daten = await res.json().catch(() => null);
            if (daten && daten.id) e.projektPageIds = [...(e.projektPageIds || []), daten.id];
          }

          e.notionRequests.shift();
          e.lastError = null;
          speichereEintraege(liste);
        } catch {
          e.lastError = "Offline / Netzwerkfehler";
          netzwerkProblem = true;
          break;
        }
      }

      if (e.notionRequests.length === 0) {
        e.syncStatus = "synced";
        e.lastError = null;
      }
      speichereEintraege(liste);
    }

    setEintraege([...liste]);
    setSyncLaeuft(false);
    syncingRef.current = false;
  }

  async function handleSubmit(ueberschreibenBestaetigt) {
    if (submittingRef.current) return;
    submittingRef.current = true;

    if (!mitarbeiter) {
      showStatus("error", "Kein Mitarbeitername im Link gefunden. Bitte den korrekten Link verwenden.");
      submittingRef.current = false;
      return;
    }
    if (!form.datum) {
      showStatus("error", "Bitte ein Datum auswählen.");
      submittingRef.current = false;
      return;
    }

    if (!ueberschreibenBestaetigt && eintraege.some((e) => e.datum === form.datum)) {
      submittingRef.current = false;
      setDuplikatWarnung({ datum: form.datum });
      return;
    }

    setLoading(true);
    let eintrag = null;

    const einfacherTag = (tagesart, statusLabel, stunden, anzeige) => ({
      id: Date.now(),
      tagesart,
      datum: form.datum,
      gesamtArbeitszeit: stunden,
      gesamtArbeitszeitFormatiert: anzeige,
      projekte: [],
      syncStatus: "pending",
      lastError: null,
      notionRequests: [baueArbeitstagRequest(form.datum, statusLabel, stunden, mitarbeiter, null, false, null)],
      projektPageIds: [],
    });

    if (form.tagesart === "urlaub") {
      eintrag = einfacherTag("urlaub", "Urlaub", 0, "Urlaub");
    } else if (form.tagesart === "schule") {
      eintrag = einfacherTag("schule", "Schultag", 0, "Schultag");
    } else if (form.tagesart === "feiertag") {
      const stunden = sollStunden(form.datum);
      eintrag = einfacherTag("feiertag", "Feiertag", stunden, `${stunden}h (Feiertag)`);
    }

    // --- KRANK ---
    else if (form.tagesart === "krank") {
      const teilstunden = parseFloat(form.krankTeilstunden) || 0;
      const sollHeute = sollStunden(form.datum);
      const restKrankheit = Math.max(sollHeute - teilstunden, 0);

      const valideProjekte = form.projekte.filter((p) => p.name.trim());
      if (teilstunden > 0 && valideProjekte.length === 0) {
        showStatus("error", "Bitte ein Projekt für die gearbeiteten Stunden eintragen.");
        beendeVorgang();
        return;
      }
      if (teilstunden > 0) {
        const summeProjekte = valideProjekte.reduce((acc, p) => acc + (parseFloat(p.stunden) || 0), 0);
        if (Math.abs(summeProjekte - teilstunden) > 0.01) {
          showStatus("error", `Projektstunden (${summeProjekte.toFixed(2)}h) stimmen nicht mit den gearbeiteten Stunden (${teilstunden.toFixed(2)}h) überein.`);
          beendeVorgang();
          return;
        }
      }

      const projekte = teilstunden > 0
        ? valideProjekte.map((p, idx) => ({ name: p.name.trim(), stunden: parseFloat(p.stunden) || 0, notiz: p.notiz.trim(), reihenfolge: idx + 1 }))
        : [];
      const mehrere = projekte.length > 1;
      const requests = projekte.map((p) => baueProjektRequest(form.datum, p, mitarbeiter, mehrere));

      if (teilstunden > 0) {
        // Keine Minusstunden – die Krankheit füllt den Tag auf.
        const ueberKrank = Math.max(Math.round((teilstunden - sollHeute) * 100) / 100, 0);
        requests.push(baueArbeitstagRequest(form.datum, "Normal", teilstunden, mitarbeiter, null, true, { ueber: ueberKrank, minus: 0 }));
      }
      requests.push(baueArbeitstagRequest(form.datum, "Krankheit", restKrankheit, mitarbeiter, null, false, null));

      eintrag = {
        id: Date.now(),
        tagesart: "krank",
        datum: form.datum,
        gesamtArbeitszeit: restKrankheit,
        gesamtArbeitszeitFormatiert: teilstunden > 0
          ? `${teilstunden}h gearbeitet + ${restKrankheit.toFixed(2)}h krank`
          : `Krank (${restKrankheit.toFixed(2)}h)`,
        projekte,
        syncStatus: "pending",
        lastError: null,
        notionRequests: requests,
        projektPageIds: [],
      };
    }

    // --- NORMAL ---
    else {
      if (!form.arbeitsbeginn || !form.arbeitsende) {
        showStatus("error", "Bitte Arbeitsbeginn und Arbeitsende ausfüllen.");
        beendeVorgang();
        return;
      }
      if (!arbeitszeit) {
        showStatus("error", "Arbeitsende muss nach Arbeitsbeginn liegen.");
        beendeVorgang();
        return;
      }
      const valideProjekte = form.projekte.filter((p) => p.name.trim());
      if (valideProjekte.length === 0) {
        showStatus("error", "Bitte mindestens ein Projekt eintragen.");
        beendeVorgang();
        return;
      }
      const summeProjekte = valideProjekte.reduce((acc, p) => acc + (parseFloat(p.stunden) || 0), 0);
      const nettoStunden = parseFloat(arbeitszeit.dezimal);
      if (Math.abs(summeProjekte - nettoStunden) > 0.01) {
        showStatus("error", `Projektstunden (${summeProjekte.toFixed(2)}h) stimmen nicht mit der Netto-Arbeitszeit (${nettoStunden.toFixed(2)}h) überein.`);
        beendeVorgang();
        return;
      }

      const projekte = valideProjekte.map((p, idx) => ({ name: p.name.trim(), stunden: parseFloat(p.stunden) || 0, notiz: p.notiz.trim(), reihenfolge: idx + 1 }));
      const mehrere = projekte.length > 1;
      const requests = projekte.map((p) => baueProjektRequest(form.datum, p, mitarbeiter, mehrere));

      // Über-/Minusstunden gegenüber Soll (Mo-Do 8,5h · Fr 6h · Wochenende 0h)
      const diff = Math.round((nettoStunden - sollStunden(form.datum)) * 100) / 100;
      const plusMinus = { ueber: Math.max(diff, 0), minus: Math.min(diff, 0) };
      const pause = parseFloat(form.pauseMinuten) || 0;

      requests.push(
        baueArbeitstagRequest(form.datum, "Normal", nettoStunden, mitarbeiter, {
          arbeitsbeginn: form.arbeitsbeginn,
          arbeitsende: form.arbeitsende,
          pauseMinuten: pause,
        }, true, plusMinus)
      );

      eintrag = {
        id: Date.now(),
        tagesart: "normal",
        datum: form.datum,
        arbeitsbeginn: form.arbeitsbeginn,
        arbeitsende: form.arbeitsende,
        pauseMinuten: pause,
        gesamtArbeitszeit: nettoStunden,
        gesamtArbeitszeitFormatiert: `${arbeitszeit.h}h ${arbeitszeit.m}m`,
        projekte,
        syncStatus: "pending",
        lastError: null,
        notionRequests: requests,
        projektPageIds: [],
      };
    }

    const neu = [eintrag, ...ladeEintraege()];
    speichereEintraege(neu);
    setEintraege(neu);
    resetForm();

    await syncPending();

    const aktuell = ladeEintraege().find((e) => e.id === eintrag.id);
    if (aktuell && aktuell.syncStatus === "synced") {
      showStatus("success", "An Notion gesendet ✓");
    } else if (!navigator.onLine) {
      showStatus("warn", "Offline gespeichert – wird automatisch gesendet, sobald du wieder online bist.");
    } else {
      showStatus("warn", `Zwischengespeichert – Senden wird erneut versucht. ${aktuell?.lastError ? "(" + aktuell.lastError + ")" : ""}`);
    }

    beendeVorgang();
  }

  function loescheEintrag(id) {
    const liste = ladeEintraege().filter((e) => e.id !== id);
    speichereEintraege(liste);
    setEintraege(liste);
    setDeleteConfirm(null);
  }

  const zeigeProjekte = form.tagesart === "normal" || (form.tagesart === "krank" && parseFloat(form.krankTeilstunden) > 0);
  const summeProjekte = form.projekte.reduce((acc, p) => acc + (parseFloat(p.stunden) || 0), 0);
  const zielStunden = form.tagesart === "normal"
    ? (arbeitszeit ? parseFloat(arbeitszeit.dezimal) : null)
    : (parseFloat(form.krankTeilstunden) || null);
  const summePasst = zielStunden !== null && Math.abs(summeProjekte - zielStunden) <= 0.01;
  const datumObj = new Date(form.datum + "T12:00:00");

  return (
    <div style={s.root}>
      {/* Header: Logo links, Aktionen rechts */}
      <div style={s.header}>
        <div style={s.logoContainer}>
          {!logoFehlt ? (
            <img src="/logo.png" alt="Malermeister Cürten" style={s.logo} onError={() => setLogoFehlt(true)} />
          ) : (
            <div style={s.logoFallback}>Malermeister Cürten</div>
          )}
        </div>
        <div style={{ display: "flex", gap: 10 }}>
          <button style={{ ...s.headerBtn, position: "relative" }} onClick={() => setZeigeEintraege((z) => !z)} aria-label="Einträge">
            <IconListe color={zeigeEintraege ? "#0A84FF" : c.text} />
            {pendingCount > 0 && <span style={s.pendingBadge}>{pendingCount}</span>}
          </button>
          <button style={s.headerBtn} onClick={toggleDarkMode} aria-label="Dunkelmodus">
            {darkMode ? <IconSonne color={c.text} /> : <IconMond color={c.text} />}
          </button>
        </div>
      </div>

      <div style={s.begruessung}>
        <div style={s.begruessungTitel}>{mitarbeiter ? `Hallo ${mitarbeiter} 👋` : "Hallo 👋"}</div>
        <div style={s.begruessungSub}>Arbeitszeiten erfassen</div>
      </div>

      {!isOnline && (
        <div style={s.offlineBanner}>
          Offline – Einträge werden zwischengespeichert und automatisch gesendet, sobald du wieder online bist.
        </div>
      )}

      {status && (
        <div style={{ ...s.toast, background: status.type === "error" ? "#E5484D" : status.type === "warn" ? "#FF8A00" : "#23913B" }}>
          {status.msg}
        </div>
      )}

      {/* Verwerfen-Dialog */}
      {deleteConfirm && (
        <div style={s.overlay}>
          <div style={s.modal}>
            <div style={s.modalTitle}>Eintrag verwerfen?</div>
            <div style={s.modalText}>Dieser Eintrag wurde noch nicht an Notion gesendet und wird unwiderruflich verworfen.</div>
            <div style={s.modalActions}>
              <button style={s.cancelBtn} onClick={() => setDeleteConfirm(null)}>Abbrechen</button>
              <button style={{ ...s.saveBtn, background: "#E5484D" }} onClick={() => loescheEintrag(deleteConfirm)}>Verwerfen</button>
            </div>
          </div>
        </div>
      )}

      {/* Duplikat-Warnung */}
      {duplikatWarnung && (
        <div style={s.overlay}>
          <div style={s.modal}>
            <div style={s.modalTitle}>Eintrag bereits vorhanden?</div>
            <div style={s.modalText}>
              Für den <b>{formatDate(duplikatWarnung.datum)}</b> wurde von diesem Gerät aus bereits ein Eintrag gesendet.
              Möchtest du trotzdem einen weiteren Eintrag für diesen Tag senden?
            </div>
            <div style={s.modalActions}>
              <button style={s.cancelBtn} onClick={() => setDuplikatWarnung(null)}>Abbrechen</button>
              <button style={s.saveBtn} onClick={() => { setDuplikatWarnung(null); handleSubmit(true); }}>Trotzdem senden</button>
            </div>
          </div>
        </div>
      )}

      {/* Kalender-Tagesvorschau */}
      {vorschauTag && (
        <div style={s.overlay} onClick={() => setVorschauTag(null)}>
          <div style={s.modal} onClick={(e) => e.stopPropagation()}>
            <div style={s.modalTitle}>{formatDate(vorschauTag.datum)}</div>
            {vorschauTag.eintraege.map((e) => (
              <EintragKarte key={e.id} e={e} s={s} TAGESARTEN={TAGESARTEN} />
            ))}
            <button style={{ ...s.cancelBtn, width: "100%", marginTop: 6 }} onClick={() => setVorschauTag(null)}>Schließen</button>
          </div>
        </div>
      )}

      {/* Einträge auf diesem Gerät */}
      {zeigeEintraege && (
        <div style={s.card}>
          <div style={s.cardKopfZeile}>
            <div style={s.cardTitle}>Einträge auf diesem Gerät</div>
            {pendingCount > 0 && isOnline && (
              <button style={s.syncBtn} onClick={syncPending} disabled={syncLaeuft}>
                {syncLaeuft ? "Sendet…" : "Jetzt senden"}
              </button>
            )}
          </div>
          {eintraege.length === 0 && <div style={s.empty}>Noch keine Einträge vorhanden.</div>}
          {eintraege.map((e) => (
            <EintragKarte key={e.id} e={e} s={s} TAGESARTEN={TAGESARTEN} zeigeDelete onDelete={(id) => setDeleteConfirm(id)} />
          ))}
        </div>
      )}

      {/* Zeiterfassung */}
      <div style={s.card}>
        <div style={s.bereichKopf}>
          <div style={s.iconFeld}><IconUhr /></div>
          <div>
            <div style={s.bereichTitel}>Zeiterfassung</div>
            <div style={s.bereichSub}>{WOCHENTAGE_LANG[datumObj.getDay()]}, {formatDate(form.datum)}</div>
          </div>
        </div>

        {/* Tagesart */}
        <div style={{ ...s.tagesartGrid, gridTemplateColumns: `repeat(${TAGESARTEN.length}, 1fr)` }}>
          {TAGESARTEN.map((t) => (
            <button
              key={t.key}
              style={{ ...s.tagesartBtn, ...(form.tagesart === t.key ? s.tagesartBtnOn : {}) }}
              onClick={() => setTagesart(t.key)}
            >
              <span style={{ fontSize: 20 }}>{t.icon}</span>
              <span>{t.label}</span>
            </button>
          ))}
        </div>

        {/* Kalender */}
        <div style={s.kalenderWrap} onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
          <div style={s.kalenderHeader}>
            <button style={s.kalenderNavBtn} onClick={vorherigerMonat} aria-label="Vorheriger Monat">‹</button>
            <div style={s.kalenderTitelWrap}>
              <span style={s.kalenderTitel}>{MONATSNAMEN[kalenderDatum.monat]} {kalenderDatum.jahr}</span>
              <button style={s.kalenderHeuteBtn} onClick={heuteAnzeigen}>Heute</button>
            </div>
            <button style={s.kalenderNavBtn} onClick={naechsterMonat} aria-label="Nächster Monat">›</button>
          </div>

          <div style={s.kalenderWochentage}>
            {WOCHENTAGE_KURZ.map((w) => <div key={w} style={s.kalenderWochentag}>{w}</div>)}
          </div>

          <div style={s.kalenderGrid}>
            {getMonatsTage(kalenderDatum.jahr, kalenderDatum.monat).map((tag, i) => {
              if (!tag) return <div key={"leer" + i} />;
              const dateStr = toDateStr(tag);
              const stat = tagStatus(dateStr, eintraege, heute);
              let zellStyle = { ...s.kalenderTag };
              if (stat === "entry") zellStyle = { ...zellStyle, ...s.kalenderTagEntry };
              else if (stat === "missing") zellStyle = { ...zellStyle, ...s.kalenderTagMissing };
              if (dateStr === heute) zellStyle = { ...zellStyle, fontWeight: 800 };
              if (dateStr === form.datum) zellStyle = { ...zellStyle, ...s.kalenderTagSelected };
              return (
                <button key={dateStr} style={zellStyle} onClick={() => onTagKlick(dateStr)}>
                  {tag.getDate()}
                </button>
              );
            })}
          </div>

          <div style={s.legende}>
            <span style={s.legendeItem}><span style={{ ...s.legendePunkt, background: "#23913B" }} />erfasst</span>
            <span style={s.legendeItem}><span style={{ ...s.legendePunkt, background: "#E5484D" }} />fehlt</span>
          </div>
        </div>

        {form.tagesart === "urlaub" && (
          <div style={s.infoBox}>🏖️ Dieser Tag wird als <b>Urlaub</b> in Notion vermerkt. Keine weiteren Angaben nötig.</div>
        )}

        {form.tagesart === "schule" && (
          <div style={s.infoBox}>🎓 Dieser Tag wird als <b>Schultag</b> in Notion vermerkt. Keine weiteren Angaben nötig.</div>
        )}

        {form.tagesart === "feiertag" && (
          <div style={s.infoBox}>
            🎉 Dieser Tag wird als <b>Feiertag</b> mit <b>{soll}h</b> in Notion vermerkt (Soll-Arbeitszeit für diesen Wochentag).
          </div>
        )}

        {form.tagesart === "krank" && (
          <>
            <label style={s.label}>Trotzdem gearbeitete Stunden (optional)</label>
            <input style={s.input} type="number" inputMode="decimal" name="krankTeilstunden" min="0" max="24" step="0.5"
              placeholder="z. B. 2" value={form.krankTeilstunden} onChange={handleChange} />
            <div style={s.infoBox}>
              🤒 Soll-Arbeitszeit heute: <b>{soll}h</b>.{" "}
              {parseFloat(form.krankTeilstunden) > 0
                ? <>Davon <b>{form.krankTeilstunden}h</b> gearbeitet (bitte Projekt unten eintragen), Rest (<b>{Math.max(soll - parseFloat(form.krankTeilstunden || 0), 0).toFixed(2)}h</b>) wird als Krankheit vermerkt.</>
                : <>Der komplette Tag wird als Krankheit vermerkt.</>}
            </div>
          </>
        )}

        {form.tagesart === "normal" && (
          <>
            <div style={s.zeitenGrid}>
              <div>
                <label style={s.labelMitte}>Arbeitsbeginn</label>
                <input style={{ ...s.input, ...s.zeitInput }} type="time" name="arbeitsbeginn" value={form.arbeitsbeginn} onChange={handleChange} />
              </div>
              <div>
                <label style={s.labelMitte}>Arbeitsende</label>
                <input style={{ ...s.input, ...s.zeitInput }} type="time" name="arbeitsende" value={form.arbeitsende} onChange={handleChange} />
              </div>
            </div>

            <div style={s.pauseWrap}>
              <label style={s.labelMitte}>Pause (Minuten)</label>
              <input style={{ ...s.input, ...s.zeitInput }} type="number" inputMode="numeric" name="pauseMinuten" min="0" max="480" step="5"
                placeholder="–" value={form.pauseMinuten} onChange={handleChange} />
            </div>

            <div style={s.resultBox}>
              {arbeitszeit ? (
                <>
                  <div style={s.resultLabel}>Gesamtstunden</div>
                  <div style={s.resultValue}>
                    {arbeitszeit.h}<span style={s.resultUnit}>h</span>{" "}
                    {arbeitszeit.m}<span style={s.resultUnit}>m</span>
                  </div>
                  <div style={s.resultDezimal}>
                    {arbeitszeit.dezimal} Stunden · Soll {String(soll).replace(".", ",")}h
                  </div>
                </>
              ) : (
                <div style={s.resultPlaceholder}>Zeiten eingeben</div>
              )}
            </div>
          </>
        )}

        {/* Projekte */}
        {zeigeProjekte && (
          <>
            <div style={s.divider} />
            <div style={s.projekteKopf}>
              <div style={s.sectionLabel}>Projekte</div>
              <button style={s.aktualisierenBtn} onClick={aktualisiereBaustellen} disabled={baustellenLaden}>
                {baustellenLaden ? "Lädt…" : "↻ Baustellen"}
              </button>
            </div>

            {form.projekte.map((proj, idx) => (
              <div key={proj.id} style={s.projektBlock}>
                <div style={s.projektRow}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    {idx === 0 && <div style={s.colLabel}>Baustelle / Projekt</div>}
                    <ProjektEingabe
                      value={proj.name}
                      onChange={(v) => handleProjektChange(proj.id, "name", v)}
                      baustellen={baustellen}
                      s={s}
                      c={c}
                    />
                  </div>
                  <div style={{ width: 10 }} />
                  <div style={{ width: 76, flexShrink: 0 }}>
                    {idx === 0 && <div style={s.colLabel}>Stunden</div>}
                    <input
                      style={{ ...s.input, textAlign: "center", paddingLeft: 6, paddingRight: 6 }}
                      type="number"
                      inputMode="decimal"
                      min="0"
                      max="24"
                      step="0.5"
                      placeholder="0"
                      value={proj.stunden}
                      onChange={(e) => handleProjektChange(proj.id, "stunden", e.target.value)}
                    />
                  </div>
                  {form.projekte.length > 1 && (
                    <button style={s.removeBtn} onClick={() => removeProjekt(proj.id)} aria-label="Projekt entfernen">✕</button>
                  )}
                </div>
                <input
                  style={{ ...s.input, marginTop: 8, fontSize: 15 }}
                  type="text"
                  placeholder="Notiz (optional) – was wurde gemacht?"
                  value={proj.notiz}
                  onChange={(e) => handleProjektChange(proj.id, "notiz", e.target.value)}
                />
              </div>
            ))}

            <button style={s.addBtn} onClick={addProjekt}>＋ Weiteres Projekt hinzufügen</button>

            <div style={s.summeBox}>
              <span style={s.summeLabel}>Summe Projektstunden</span>
              <span style={{ ...s.summeWert, color: zielStunden === null ? c.text : summePasst ? "#23913B" : "#E5484D" }}>
                {summeProjekte.toFixed(2).replace(".", ",")} h
                {zielStunden !== null && !summePasst && ` / ${zielStunden.toFixed(2).replace(".", ",")} h`}
              </span>
            </div>
          </>
        )}

        <button style={{ ...s.submitBtn, opacity: loading ? 0.7 : 1 }} onClick={() => handleSubmit(false)} disabled={loading}>
          {loading ? "Wird gespeichert…" : isOnline ? "An Notion senden" : "Offline speichern"}
        </button>
      </div>

      <div style={s.footer}>
        {mitarbeiter ? `Angemeldet als ${mitarbeiter}` : "Kein Mitarbeiter im Link angegeben"}
        {pendingCount > 0 && ` · ${pendingCount} Eintrag${pendingCount > 1 ? "e" : ""} ausstehend`}
      </div>
    </div>
  );
}

// =====================================================================
// Styles – finale Design-Sprache
// =====================================================================
function getStyles(dark) {
  const c = dark
    ? {
        bg: "#000000",
        card: "#1C1C1E",
        feld: "#2C2C2E",
        text: "#F2F2F7",
        sek: "#A1A1AA",
        sek2: "#8E8E93",
        divider: "#38383A",
        schatten: "0 8px 24px rgba(0,0,0,.35)",
        blauBg: "#0B2A4A",
        gruenBg: "#123822",
        gruen: "#4ADE80",
        rotBg: "#3A1212",
        rot: "#FF6961",
        infoBg: "#2A2416",
        infoRand: "#4A3D1C",
        overlay: "rgba(0,0,0,.6)",
      }
    : {
        bg: "#F2F2F7",
        card: "#FFFFFF",
        feld: "#F2F2F7",
        text: "#1D2735",
        sek: "#5F6977",
        sek2: "#7D8795",
        divider: "#E6E8EC",
        schatten: "0 8px 24px rgba(37,52,73,.07)",
        blauBg: "#E8F3FF",
        gruenBg: "#E8F7E8",
        gruen: "#23913B",
        rotBg: "#FDEBEA",
        rot: "#E5484D",
        infoBg: "#FFF0DF",
        infoRand: "#FFE0BC",
        overlay: "rgba(29,39,53,.35)",
      };

  const blau = "#0A84FF";

  return {
    c,
    root: { fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Helvetica Neue', sans-serif", background: c.bg, minHeight: "100vh", maxWidth: 480, margin: "0 auto", padding: "0 0 48px", color: c.text, boxSizing: "border-box", textAlign: "left" },

    // Header
    header: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "calc(env(safe-area-inset-top, 0px) + 18px) 16px 6px" },
    logoContainer: { width: 170, height: 58, display: "flex", alignItems: "center", boxSizing: "border-box", ...(dark ? { background: "#FFFFFF", borderRadius: 14, padding: "4px 10px" } : {}) },
    logo: { maxWidth: "100%", maxHeight: "100%", objectFit: "contain" },
    logoFallback: { fontSize: 18, fontWeight: 800, color: c.text, letterSpacing: "-0.01em" },
    headerBtn: { background: c.card, border: "none", borderRadius: 14, width: 44, height: 44, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", boxShadow: c.schatten },
    pendingBadge: { position: "absolute", top: -5, right: -5, background: "#FF8A00", color: "#fff", fontSize: 11, fontWeight: 700, borderRadius: 10, minWidth: 18, height: 18, display: "flex", alignItems: "center", justifyContent: "center", padding: "0 4px" },

    begruessung: { padding: "14px 20px 14px" },
    begruessungTitel: { fontSize: 26, fontWeight: 800, color: c.text, letterSpacing: "-0.02em" },
    begruessungSub: { fontSize: 15, color: c.sek, marginTop: 2 },

    offlineBanner: { margin: "0 16px 12px", borderRadius: 16, padding: "12px 14px", fontSize: 13, fontWeight: 600, color: "#fff", background: "#FF8A00", lineHeight: 1.4 },
    toast: { margin: "0 16px 12px", borderRadius: 16, padding: "13px 16px", fontSize: 14, fontWeight: 600, color: "#fff", boxShadow: "0 8px 24px rgba(37,52,73,.15)" },

    // Karten
    card: { margin: "0 16px 14px", background: c.card, borderRadius: 24, padding: "20px 18px", boxShadow: c.schatten },
    cardKopfZeile: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 },
    cardTitle: { fontSize: 17, fontWeight: 700, color: c.text },
    bereichKopf: { display: "flex", alignItems: "center", gap: 14, marginBottom: 18 },
    iconFeld: { width: 52, height: 52, borderRadius: 20, background: c.blauBg, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 },
    bereichTitel: { fontSize: 20, fontWeight: 800, color: c.text, letterSpacing: "-0.01em" },
    bereichSub: { fontSize: 14, color: c.sek, marginTop: 2 },
    syncBtn: { background: blau, border: "none", borderRadius: 12, padding: "8px 12px", color: "#fff", fontSize: 13, fontWeight: 700, cursor: "pointer" },

    // Eingaben
    label: { display: "block", fontSize: 13, fontWeight: 600, color: c.sek, marginBottom: 7, marginTop: 16 },
    labelMitte: { display: "block", fontSize: 13, fontWeight: 600, color: c.sek, marginBottom: 7, textAlign: "center" },
    input: { display: "block", width: "100%", background: c.feld, border: "1px solid transparent", borderRadius: 14, padding: "13px 14px", fontSize: 16, color: c.text, outline: "none", boxSizing: "border-box", colorScheme: dark ? "dark" : "light", fontFamily: "inherit", WebkitAppearance: "none", minHeight: 48 },
    zeitInput: { textAlign: "center", fontSize: 18, fontWeight: 600, minWidth: 0, paddingLeft: 8, paddingRight: 8 },
    zeitenGrid: { display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)", gap: 12, marginTop: 18 },
    pauseWrap: { width: "50%", margin: "14px auto 0" },

    // Tagesart
    tagesartGrid: { display: "grid", gap: 8, marginBottom: 4 },
    tagesartBtn: { display: "flex", flexDirection: "column", alignItems: "center", gap: 4, padding: "11px 2px", background: c.feld, border: "1.5px solid transparent", borderRadius: 16, color: c.sek, fontSize: 11, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" },
    tagesartBtnOn: { border: `1.5px solid ${blau}`, color: blau, background: c.blauBg },

    // Kalender
    kalenderWrap: { marginTop: 18 },
    kalenderHeader: { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 },
    kalenderNavBtn: { background: c.feld, border: "none", borderRadius: 12, width: 36, height: 36, fontSize: 20, fontWeight: 700, color: c.text, cursor: "pointer", lineHeight: 1 },
    kalenderTitelWrap: { display: "flex", flexDirection: "column", alignItems: "center", gap: 2 },
    kalenderTitel: { fontSize: 16, fontWeight: 800, color: c.text },
    kalenderHeuteBtn: { background: "none", border: "none", color: blau, fontSize: 12, fontWeight: 700, cursor: "pointer", padding: 0 },
    kalenderWochentage: { display: "grid", gridTemplateColumns: "repeat(7, 1fr)", marginBottom: 4 },
    kalenderWochentag: { textAlign: "center", fontSize: 11, fontWeight: 700, color: c.sek2 },
    kalenderGrid: { display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 4 },
    kalenderTag: { aspectRatio: "1", display: "flex", alignItems: "center", justifyContent: "center", background: c.feld, border: "2px solid transparent", borderRadius: 12, fontSize: 14, fontWeight: 600, color: c.text, cursor: "pointer", padding: 0, fontFamily: "inherit" },
    kalenderTagEntry: { background: c.gruenBg, color: c.gruen },
    kalenderTagMissing: { background: c.rotBg, color: c.rot },
    kalenderTagSelected: { border: `2px solid ${blau}` },
    legende: { display: "flex", gap: 14, justifyContent: "center", marginTop: 10 },
    legendeItem: { display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: c.sek2, fontWeight: 600 },
    legendePunkt: { width: 8, height: 8, borderRadius: 4, display: "inline-block" },

    infoBox: { marginTop: 16, background: c.infoBg, border: `1px solid ${c.infoRand}`, borderRadius: 16, padding: "12px 14px", fontSize: 14, color: c.text, lineHeight: 1.5 },

    // Gesamtstunden
    resultBox: { marginTop: 18, background: c.blauBg, borderRadius: 20, padding: "18px 16px", textAlign: "center", minHeight: 84, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" },
    resultLabel: { fontSize: 12, fontWeight: 700, letterSpacing: "0.06em", color: blau, marginBottom: 4, textTransform: "uppercase" },
    resultValue: { fontSize: 38, fontWeight: 800, color: c.text, lineHeight: 1.1, letterSpacing: "-0.02em" },
    resultUnit: { fontSize: 18, fontWeight: 600, color: blau, marginLeft: 2 },
    resultDezimal: { fontSize: 13, color: c.sek, marginTop: 5, fontWeight: 500 },
    resultPlaceholder: { color: c.sek2, fontSize: 15, fontWeight: 500 },

    // Projekte
    divider: { height: 1, background: c.divider, margin: "22px 0 16px" },
    projekteKopf: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 },
    sectionLabel: { fontSize: 13, fontWeight: 700, letterSpacing: "0.06em", color: c.sek, textTransform: "uppercase" },
    aktualisierenBtn: { background: "none", border: "none", color: "#23913B", fontSize: 13, fontWeight: 700, cursor: "pointer", padding: 0, fontFamily: "inherit" },
    colLabel: { fontSize: 12, fontWeight: 600, color: c.sek2, marginBottom: 6 },
    projektBlock: { marginBottom: 14 },
    projektRow: { display: "flex", alignItems: "flex-end" },
    removeBtn: { background: "transparent", border: "none", color: c.sek2, fontSize: 16, cursor: "pointer", padding: "0 0 14px 8px", lineHeight: 1, flexShrink: 0 },
    baustelleHaken: { position: "absolute", right: 12, top: "50%", transform: "translateY(-50%)", display: "flex", pointerEvents: "none" },
    vorschlagListe: { position: "absolute", left: 0, right: 0, top: "calc(100% + 6px)", background: c.card, borderRadius: 16, boxShadow: "0 12px 32px rgba(37,52,73,.18)", zIndex: 30, maxHeight: 260, overflowY: "auto", padding: 6, border: `1px solid ${c.divider}` },
    vorschlagItem: { display: "flex", alignItems: "center", gap: 10, width: "100%", background: "none", border: "none", borderRadius: 12, padding: "11px 10px", fontSize: 15, cursor: "pointer", fontFamily: "inherit" },
    vorschlagIcon: { width: 28, height: 28, borderRadius: 10, background: c.gruenBg, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 },
    addBtn: { display: "block", background: "transparent", border: `1.5px dashed ${dark ? "#3A4A60" : "#B9D7FA"}`, borderRadius: 16, padding: "13px 14px", color: blau, fontSize: 15, fontWeight: 700, cursor: "pointer", width: "100%", marginTop: 4, fontFamily: "inherit" },
    summeBox: { display: "flex", justifyContent: "space-between", alignItems: "center", background: c.feld, borderRadius: 14, padding: "12px 14px", marginTop: 12 },
    summeLabel: { fontSize: 14, fontWeight: 600, color: c.sek },
    summeWert: { fontSize: 16, fontWeight: 800 },
    submitBtn: { marginTop: 20, width: "100%", background: blau, border: "none", borderRadius: 18, padding: "17px", fontSize: 17, fontWeight: 700, color: "#fff", cursor: "pointer", boxShadow: "0 8px 20px rgba(10,132,255,.28)", fontFamily: "inherit" },

    // Einträge
    entryCard: { background: c.feld, borderRadius: 16, padding: "14px", marginBottom: 10 },
    entryHeader: { display: "flex", justifyContent: "space-between", alignItems: "flex-start" },
    entryDate: { fontSize: 15, fontWeight: 700, color: c.text, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" },
    tagBadge: { fontSize: 11, fontWeight: 700, color: blau, background: c.blauBg, padding: "3px 8px", borderRadius: 8 },
    syncBadge: { fontSize: 11, fontWeight: 700, padding: "3px 8px", borderRadius: 8 },
    syncOk: { color: c.gruen, background: c.gruenBg },
    syncPending: { color: "#FF8A00", background: dark ? "#2E1F04" : "#FFF0DF" },
    entryMeta: { fontSize: 13, color: c.sek, marginTop: 3 },
    entryHours: { fontSize: 13, fontWeight: 800, color: blau, textAlign: "right", maxWidth: 130 },
    deleteBtn: { background: "transparent", border: "none", color: c.sek2, fontSize: 16, cursor: "pointer", padding: "0 2px", lineHeight: 1 },
    projektList: { marginTop: 10, borderTop: `1px solid ${c.divider}`, paddingTop: 8, display: "flex", flexDirection: "column", gap: 5 },
    projektItem: { display: "flex", alignItems: "center", gap: 8 },
    projektNr: { display: "inline-flex", alignItems: "center", justifyContent: "center", width: 18, height: 18, borderRadius: 9, background: c.blauBg, color: blau, fontSize: 10, fontWeight: 800, flexShrink: 0 },
    projektName: { fontSize: 13, color: c.text, flex: 1 },
    projektStunden: { fontSize: 13, fontWeight: 700, color: c.text },
    empty: { textAlign: "center", color: c.sek2, padding: "24px 12px", fontSize: 14 },
    footer: { textAlign: "center", fontSize: 12, color: c.sek2, padding: "20px 0 8px", fontWeight: 500 },

    // Dialoge
    overlay: { position: "fixed", inset: 0, background: c.overlay, backdropFilter: "blur(6px)", WebkitBackdropFilter: "blur(6px)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100, padding: 20 },
    modal: { background: c.card, borderRadius: 24, padding: 24, width: "100%", maxWidth: 400, boxShadow: "0 20px 60px rgba(0,0,0,.25)", maxHeight: "85vh", overflowY: "auto", boxSizing: "border-box" },
    modalTitle: { fontSize: 19, fontWeight: 800, marginBottom: 14, color: c.text },
    modalText: { color: c.sek, fontSize: 15, lineHeight: 1.5 },
    modalActions: { display: "flex", gap: 10, marginTop: 22 },
    cancelBtn: { flex: 1, padding: "14px", background: c.feld, border: "none", borderRadius: 14, color: c.text, fontSize: 15, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" },
    saveBtn: { flex: 1, padding: "14px", background: blau, border: "none", borderRadius: 14, color: "#fff", fontSize: 15, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" },
  };
}
