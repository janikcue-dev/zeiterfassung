import { useState, useEffect, useRef } from "react";

const STORAGE_KEY = "zeiterfassung_eintraege";

// Fest hinterlegte Notion-Zugangsdaten
const NOTION_TOKEN = "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";
const NOTION_DB_ARBEITSTAGE = "3906606acb1d802fbcd1c68844c94151";
const NOTION_DB_PROJEKTE = "3906606acb1d80efa3cfc8b1312b4df2";

// Soll-Arbeitszeiten pro Wochentag (0=So ... 6=Sa)
function sollStunden(dateStr) {
  const datumObj = new Date(dateStr + "T12:00:00");
  const tag = datumObj.getDay();
  if (tag === 5) return 6; // Freitag
  if (tag >= 1 && tag <= 4) return 8.5; // Mo-Do
  return 0; // Wochenende
}

// Mitarbeiter: aus URL lesen und merken — wichtig für PWA:
// Wenn die App vom Homescreen ohne ?mitarbeiter= startet, wird der
// zuletzt verwendete Name aus dem Speicher genommen.
function getMitarbeiter() {
  const params = new URLSearchParams(window.location.search);
  const ausUrl = params.get("mitarbeiter");
  if (ausUrl) {
    localStorage.setItem("mitarbeiter_name", ausUrl);
    return ausUrl;
  }
  return localStorage.getItem("mitarbeiter_name") || "";
}

function berechneArbeitszeit(start, end, pauseMin) {
  if (!start || !end) return null;
  const [sh, sm] = start.split(":").map(Number);
  const [eh, em] = end.split(":").map(Number);
  const startMin = sh * 60 + sm;
  const endMin = eh * 60 + em;
  if (endMin <= startMin) return null;
  const nettoMin = endMin - startMin - parseFloat(pauseMin || 0);
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

// --- Lokaler Speicher (Quelle der Wahrheit für die Sync-Warteschlange) ---
function ladeEintraege() {
  try {
    const roh = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
    // Migration: alte Einträge ohne Sync-Felder gelten als gesendet
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

// --- Notion-Request-Bausteine ---
function baueArbeitstagRequest(datum, statusLabel, gesamtStd, mitarbeiter, zeiten, mitRelation) {
  const wochentage = ["Sonntag","Montag","Dienstag","Mittwoch","Donnerstag","Freitag","Samstag"];
  const datumObj = new Date(datum + "T12:00:00");
  const wochentag = wochentage[datumObj.getDay()];

  const properties = {
    Tag: { title: [{ text: { content: wochentag } }] },
    Datum: { date: { start: datum } },
    Gesamtarbeitszeit: { number: gesamtStd },
    Mitarbeiter: { select: { name: mitarbeiter } },
    Status: { select: { name: statusLabel } },
  };

  if (zeiten) {
    properties.Arbeitsbeginn = { rich_text: [{ text: { content: zeiten.arbeitsbeginn } }] };
    properties.Arbeitsende = { rich_text: [{ text: { content: zeiten.arbeitsende } }] };
    properties.PauseMinuten = { number: zeiten.pauseMinuten };
  }

  return {
    typ: "arbeitstag",
    mitRelation: !!mitRelation, // bekommt beim Senden die Projekt-IDs als Relation
    token: NOTION_TOKEN,
    body: { parent: { database_id: NOTION_DB_ARBEITSTAGE }, properties },
  };
}

function baueProjektRequest(datum, proj, mitarbeiter) {
  return {
    typ: "projekt",
    token: NOTION_TOKEN,
    body: {
      parent: { database_id: NOTION_DB_PROJEKTE },
      properties: {
        Projekt: { title: [{ text: { content: proj.name } }] },
        Datum: { date: { start: datum } },
        Stunden: { number: proj.stunden },
        Mitarbeiter: { select: { name: mitarbeiter } },
        ...(proj.notiz ? { Notiz: { rich_text: [{ text: { content: proj.notiz } }] } } : {}),
      },
    },
  };
}

const emptyProjekt = () => ({ id: Date.now() + Math.random(), name: "", stunden: "", notiz: "" });

const initialForm = {
  tagesart: "normal", // normal | urlaub | feiertag | krank
  datum: new Date().toISOString().split("T")[0],
  arbeitsbeginn: "",
  arbeitsende: "",
  pauseMinuten: "0",
  krankTeilstunden: "",
  projekte: [emptyProjekt()],
};

const TAGESARTEN = [
  { key: "normal", label: "Normal", icon: "💼" },
  { key: "urlaub", label: "Urlaub", icon: "🏖️" },
  { key: "feiertag", label: "Feiertag", icon: "🎉" },
  { key: "krank", label: "Krank", icon: "🤒" },
];

export default function App() {
  const [form, setForm] = useState(initialForm);
  const [eintraege, setEintraege] = useState([]);
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState(null);
  const [darkMode, setDarkMode] = useState(false);
  const [duplikatWarnung, setDuplikatWarnung] = useState(null);
  const [isOnline, setIsOnline] = useState(navigator.onLine);
  const [zeigeEintraege, setZeigeEintraege] = useState(false);
  const [syncLaeuft, setSyncLaeuft] = useState(false);
  const mitarbeiter = getMitarbeiter();
  const submittingRef = useRef(false);
  const syncingRef = useRef(false);

  useEffect(() => {
    const geladen = ladeEintraege();
    setEintraege(geladen);
    speichereEintraege(geladen); // Migration persistieren
    setDarkMode(localStorage.getItem("dark_mode") === "true");

    // PWA: Service Worker registrieren
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch(() => {});
    }

    // Online/Offline überwachen + bei Rückkehr automatisch synchronisieren
    const onOnline = () => {
      setIsOnline(true);
      syncPending();
    };
    const onOffline = () => setIsOnline(false);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);

    // Beim App-Start ausstehende Einträge senden
    syncPending();

    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function toggleDarkMode() {
    setDarkMode((d) => {
      localStorage.setItem("dark_mode", (!d).toString());
      return !d;
    });
  }

  const s = getStyles(darkMode);

  const arbeitszeit = berechneArbeitszeit(form.arbeitsbeginn, form.arbeitsende, form.pauseMinuten);
  const soll = sollStunden(form.datum);
  const pendingCount = eintraege.filter((e) => e.syncStatus === "pending").length;

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
    setStatus({ type, msg });
    setTimeout(() => setStatus(null), 4000);
  }

  function resetForm() {
    setForm({ ...initialForm, datum: form.datum, projekte: [emptyProjekt()] });
  }

  function beendeVorgang() {
    setLoading(false);
    submittingRef.current = false;
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

        // Beim Arbeitstag-Request die gesammelten Projekt-IDs als Relation "Projekte" einfügen
        let sendeBody = req;
        if (req.mitRelation && e.projektPageIds && e.projektPageIds.length > 0) {
          sendeBody = JSON.parse(JSON.stringify(req));
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
            break; // dieser Eintrag bleibt pending, nächster Eintrag
          }

          // Bei Projekt-Requests: ID der neu erstellten Notion-Seite merken (für die Relation)
          if (req.typ === "projekt") {
            const daten = await res.json().catch(() => null);
            if (daten && daten.id) {
              e.projektPageIds = [...(e.projektPageIds || []), daten.id];
            }
          }

          e.notionRequests.shift(); // erfolgreich → Request entfernen
          e.lastError = null;
          speichereEintraege(liste); // Fortschritt sofort sichern
        } catch {
          e.lastError = "Offline / Netzwerkfehler";
          netzwerkProblem = true; // Netz weg → kompletten Sync abbrechen
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

    if (!ueberschreibenBestaetigt) {
      const bereitsVorhanden = eintraege.some((e) => e.datum === form.datum);
      if (bereitsVorhanden) {
        submittingRef.current = false;
        setDuplikatWarnung({ datum: form.datum });
        return;
      }
    }

    setLoading(true);

    let eintrag = null;

    // --- URLAUB ---
    if (form.tagesart === "urlaub") {
      eintrag = {
        id: Date.now(),
        tagesart: "urlaub",
        datum: form.datum,
        gesamtArbeitszeit: 0,
        gesamtArbeitszeitFormatiert: "Urlaub",
        projekte: [],
        syncStatus: "pending",
        lastError: null,
        notionRequests: [baueArbeitstagRequest(form.datum, "Urlaub", 0, mitarbeiter, null, false)],
        projektPageIds: [],
      };
    }

    // --- FEIERTAG ---
    else if (form.tagesart === "feiertag") {
      const stunden = sollStunden(form.datum);
      eintrag = {
        id: Date.now(),
        tagesart: "feiertag",
        datum: form.datum,
        gesamtArbeitszeit: stunden,
        gesamtArbeitszeitFormatiert: `${stunden}h (Feiertag)`,
        projekte: [],
        syncStatus: "pending",
        lastError: null,
        notionRequests: [baueArbeitstagRequest(form.datum, "Feiertag", stunden, mitarbeiter, null, false)],
        projektPageIds: [],
      };
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

      const projekte = valideProjekte.map((p) => ({ name: p.name, stunden: parseFloat(p.stunden) || 0, notiz: p.notiz || "" }));
      const requests = [];
      // Projekte zuerst senden, damit ihre IDs für die Relation vorliegen
      for (const p of projekte) {
        requests.push(baueProjektRequest(form.datum, p, mitarbeiter));
      }
      if (teilstunden > 0) {
        // Normal-Eintrag bekommt die Projekt-Relation (gearbeitete Stunden gehören zu den Projekten)
        requests.push(baueArbeitstagRequest(form.datum, "Normal", teilstunden, mitarbeiter, null, true));
      }
      requests.push(baueArbeitstagRequest(form.datum, "Krankheit", restKrankheit, mitarbeiter, null, false));

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

      const projekte = valideProjekte.map((p) => ({ name: p.name, stunden: parseFloat(p.stunden) || 0, notiz: p.notiz || "" }));
      const requests = [];
      // Projekte zuerst senden, damit ihre IDs für die Relation vorliegen
      for (const p of projekte) {
        requests.push(baueProjektRequest(form.datum, p, mitarbeiter));
      }
      requests.push(
        baueArbeitstagRequest(form.datum, "Normal", nettoStunden, mitarbeiter, {
          arbeitsbeginn: form.arbeitsbeginn,
          arbeitsende: form.arbeitsende,
          pauseMinuten: parseFloat(form.pauseMinuten || 0),
        }, true)
      );

      eintrag = {
        id: Date.now(),
        tagesart: "normal",
        datum: form.datum,
        arbeitsbeginn: form.arbeitsbeginn,
        arbeitsende: form.arbeitsende,
        pauseMinuten: parseFloat(form.pauseMinuten || 0),
        gesamtArbeitszeit: nettoStunden,
        gesamtArbeitszeitFormatiert: `${arbeitszeit.h}h ${arbeitszeit.m}m`,
        projekte,
        syncStatus: "pending",
        lastError: null,
        notionRequests: requests,
        projektPageIds: [],
      };
    }

    // Eintrag lokal sichern (als pending), Formular zurücksetzen
    const neu = [eintrag, ...ladeEintraege()];
    speichereEintraege(neu);
    setEintraege(neu);
    resetForm();

    // Direkt versuchen zu senden
    await syncPending();

    // Ergebnis prüfen
    const aktuell = ladeEintraege().find((e) => e.id === eintrag.id);
    if (aktuell && aktuell.syncStatus === "synced") {
      showStatus("success", "An Notion gesendet ✓");
    } else if (!navigator.onLine) {
      showStatus("warn", "📴 Offline gespeichert – wird automatisch gesendet, sobald du wieder online bist.");
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

  return (
    <div style={s.root}>
      {/* Header */}
      <div style={s.header}>
        <div>
          <div style={s.headerLabel}>{mitarbeiter ? `Hallo ${mitarbeiter} 👋` : "ZEITERFASSUNG"}</div>
          <div style={s.headerSub}>Arbeitszeiten erfassen</div>
        </div>
        <div style={{ display: "flex", gap: 10 }}>
          <button style={{ ...s.settingsBtn, position: "relative" }} onClick={() => setZeigeEintraege((z) => !z)}>
            📋
            {pendingCount > 0 && <span style={s.pendingBadge}>{pendingCount}</span>}
          </button>
          <button style={s.settingsBtn} onClick={toggleDarkMode}>{darkMode ? "☀️" : "🌙"}</button>
        </div>
      </div>

      {/* Offline-Banner */}
      {!isOnline && (
        <div style={s.offlineBanner}>
          📴 Offline – Einträge werden zwischengespeichert und automatisch gesendet, sobald du wieder online bist.
        </div>
      )}

      {/* Toast */}
      {status && (
        <div style={{ ...s.toast, background: status.type === "error" ? "#ff3b30" : status.type === "warn" ? "#ff9500" : "#34c759" }}>
          {status.msg}
        </div>
      )}

      {/* Delete Confirm */}
      {deleteConfirm && (
        <div style={s.overlay}>
          <div style={s.modal}>
            <div style={s.modalTitle}>Eintrag verwerfen?</div>
            <div style={{ color: s.textSecondaryColor, marginBottom: 24, fontSize: 14 }}>
              Dieser Eintrag wurde noch nicht an Notion gesendet und wird unwiderruflich verworfen.
            </div>
            <div style={s.modalActions}>
              <button style={s.cancelBtn} onClick={() => setDeleteConfirm(null)}>Abbrechen</button>
              <button style={{ ...s.saveBtn, background: "#ff3b30" }} onClick={() => loescheEintrag(deleteConfirm)}>Verwerfen</button>
            </div>
          </div>
        </div>
      )}

      {/* Duplikat-Warnung */}
      {duplikatWarnung && (
        <div style={s.overlay}>
          <div style={s.modal}>
            <div style={s.modalTitle}>Eintrag bereits vorhanden?</div>
            <div style={{ color: s.textSecondaryColor, marginBottom: 24, fontSize: 14, lineHeight: 1.5 }}>
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

      {/* Einträge-Ansicht */}
      {zeigeEintraege && (
        <div style={s.card}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
            <div style={{ ...s.cardTitle, marginBottom: 0 }}>Einträge auf diesem Gerät</div>
            {pendingCount > 0 && isOnline && (
              <button style={s.syncBtn} onClick={syncPending} disabled={syncLaeuft}>
                {syncLaeuft ? "Sendet…" : "🔄 Jetzt senden"}
              </button>
            )}
          </div>

          {eintraege.length === 0 && (
            <div style={{ ...s.empty, padding: "24px 12px" }}>Noch keine Einträge vorhanden.</div>
          )}

          {eintraege.map((e) => (
            <div key={e.id} style={s.entryCard}>
              <div style={s.entryHeader}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={s.entryDate}>
                    {formatDate(e.datum)}
                    {e.tagesart && e.tagesart !== "normal" && (
                      <span style={s.tagBadge}>
                        {TAGESARTEN.find((t) => t.key === e.tagesart)?.icon} {TAGESARTEN.find((t) => t.key === e.tagesart)?.label}
                      </span>
                    )}
                    {e.syncStatus === "synced" ? (
                      <span style={{ ...s.syncBadge, color: "#34c759", background: darkMode ? "#0d2b17" : "#e8f9ee" }}>✓ Gesendet</span>
                    ) : (
                      <span style={{ ...s.syncBadge, color: "#ff9500", background: darkMode ? "#2e1f04" : "#fff3e0" }}>⏳ Ausstehend</span>
                    )}
                  </div>
                  {e.tagesart === "normal" && e.arbeitsbeginn && (
                    <div style={s.entryMeta}>{e.arbeitsbeginn} – {e.arbeitsende} · {e.pauseMinuten} Min. Pause</div>
                  )}
                  {e.lastError && e.syncStatus === "pending" && (
                    <div style={{ ...s.entryMeta, color: "#ff3b30" }}>⚠️ {e.lastError}</div>
                  )}
                  {e.projekte && e.projekte.length > 0 && (
                    <div style={s.projektList}>
                      {e.projekte.map((p, i) => (
                        <div key={i} style={s.projektItem}>
                          <span style={s.projektDot}>•</span>
                          <span style={s.projektName}>{p.name}{p.notiz ? ` – ${p.notiz}` : ""}</span>
                          {p.stunden > 0 && <span style={s.projektStunden}>{p.stunden}h</span>}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
                  <div style={s.entryHours}>{e.gesamtArbeitszeitFormatiert}</div>
                  {e.syncStatus === "pending" && (
                    <button style={s.deleteBtn} onClick={() => setDeleteConfirm(e.id)}>✕</button>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Form Card */}
      <div style={s.card}>
        <div style={s.cardTitle}>Neuer Eintrag</div>

        {/* Tagesart */}
        <div style={s.tagesartGrid}>
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

        {/* Datum */}
        <label style={{ ...s.label, textAlign: "center" }}>Datum *</label>
        <div style={{ display: "flex", justifyContent: "center" }}>
          <input style={{ ...s.input, width: "auto", minWidth: 160, maxWidth: 200, textAlign: "center" }} type="date" name="datum" value={form.datum} onChange={handleChange} />
        </div>

        {/* URLAUB */}
        {form.tagesart === "urlaub" && (
          <div style={s.infoBox}>🏖️ Dieser Tag wird als <b>Urlaub</b> in Notion vermerkt. Keine weiteren Angaben nötig.</div>
        )}

        {/* FEIERTAG */}
        {form.tagesart === "feiertag" && (
          <div style={s.infoBox}>
            🎉 Dieser Tag wird als <b>Feiertag</b> mit <b>{soll}h</b> in Notion vermerkt (Soll-Arbeitszeit für diesen Wochentag).
          </div>
        )}

        {/* KRANK */}
        {form.tagesart === "krank" && (
          <>
            <label style={s.label}>Trotzdem gearbeitete Stunden (optional)</label>
            <input style={s.input} type="number" name="krankTeilstunden" min="0" max="24" step="0.5"
              placeholder="z. B. 2" value={form.krankTeilstunden} onChange={handleChange} />
            <div style={s.infoBox}>
              🤒 Soll-Arbeitszeit heute: <b>{soll}h</b>.{" "}
              {parseFloat(form.krankTeilstunden) > 0
                ? <>Davon <b>{form.krankTeilstunden}h</b> gearbeitet (bitte Projekt unten eintragen), Rest (<b>{Math.max(soll - parseFloat(form.krankTeilstunden || 0), 0).toFixed(2)}h</b>) wird als Krankheit vermerkt.</>
                : <>Der komplette Tag wird als Krankheit vermerkt.</>}
            </div>
          </>
        )}

        {/* NORMAL */}
        {form.tagesart === "normal" && (
          <>
            <div style={{ display: "flex", justifyContent: "space-around", marginTop: 0 }}>
              <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
                <label style={{ ...s.label, textAlign: "center" }}>Arbeitsbeginn *</label>
                <input style={{ ...s.input, width: 145, textAlign: "center" }} type="time" name="arbeitsbeginn" value={form.arbeitsbeginn} onChange={handleChange} />
              </div>
              <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
                <label style={{ ...s.label, textAlign: "center" }}>Arbeitsende *</label>
                <input style={{ ...s.input, width: 145, textAlign: "center" }} type="time" name="arbeitsende" value={form.arbeitsende} onChange={handleChange} />
              </div>
            </div>

            <label style={s.label}>Pausen Minuten</label>
            <input style={s.input} type="number" name="pauseMinuten" min="0" max="480" step="5"
              placeholder="0" value={form.pauseMinuten} onChange={handleChange} />

            <div style={s.resultBox}>
              {arbeitszeit ? (
                <>
                  <div style={s.resultLabel}>NETTO-ARBEITSZEIT</div>
                  <div style={s.resultValue}>
                    {arbeitszeit.h}<span style={s.resultUnit}>h</span>{" "}
                    {arbeitszeit.m}<span style={s.resultUnit}>m</span>
                  </div>
                  <div style={s.resultDezimal}>{arbeitszeit.dezimal} Stunden</div>
                </>
              ) : (
                <div style={s.resultPlaceholder}>— Zeiten eingeben —</div>
              )}
            </div>
          </>
        )}

        {/* Projekte */}
        {(form.tagesart === "normal" || (form.tagesart === "krank" && parseFloat(form.krankTeilstunden) > 0)) && (
          <>
            <div style={s.divider} />
            <div style={s.sectionLabel}>PROJEKTE</div>

            {form.projekte.map((proj, idx) => (
              <div key={proj.id} style={s.projektBlock}>
                <div style={s.projektRow}>
                  <div style={{ flex: 1 }}>
                    {idx === 0 && <div style={s.colLabel}>Name / Projekt</div>}
                    <input
                      style={s.input}
                      type="text"
                      placeholder="Projektname"
                      value={proj.name}
                      onChange={(e) => handleProjektChange(proj.id, "name", e.target.value)}
                    />
                  </div>
                  <div style={{ width: 12 }} />
                  <div style={{ width: 80 }}>
                    {idx === 0 && <div style={s.colLabel}>Stunden</div>}
                    <input
                      style={{ ...s.input, textAlign: "center", paddingLeft: 8, paddingRight: 8 }}
                      type="number"
                      min="0"
                      max="24"
                      step="0.5"
                      placeholder="0"
                      value={proj.stunden}
                      onChange={(e) => handleProjektChange(proj.id, "stunden", e.target.value)}
                    />
                  </div>
                  {form.projekte.length > 1 && (
                    <button style={s.removeBtn} onClick={() => removeProjekt(proj.id)}>✕</button>
                  )}
                </div>
                <input
                  style={{ ...s.input, marginTop: 8, fontSize: 14 }}
                  type="text"
                  placeholder="Anmerkung (optional) – z. B. was wurde gemacht"
                  value={proj.notiz}
                  onChange={(e) => handleProjektChange(proj.id, "notiz", e.target.value)}
                />
              </div>
            ))}

            <button style={s.addBtn} onClick={addProjekt}>
              <span style={s.addBtnPlus}>＋</span> Projekt hinzufügen
            </button>

            {(() => {
              const summe = form.projekte.reduce((acc, p) => acc + (parseFloat(p.stunden) || 0), 0);
              return (
                <div style={s.summeBox}>
                  <span style={s.summeLabel}>Summe Projektstunden</span>
                  <span style={s.summeWert}>{summe.toFixed(1)} h</span>
                </div>
              );
            })()}
          </>
        )}

        {/* Submit */}
        <button style={{ ...s.submitBtn, opacity: loading ? 0.7 : 1 }} onClick={() => handleSubmit(false)} disabled={loading}>
          {loading ? "Wird gespeichert…" : isOnline ? "📄 An Notion senden" : "📴 Offline speichern"}
        </button>
      </div>

      <div style={s.footer}>
        {mitarbeiter ? `Angemeldet als ${mitarbeiter}` : "Kein Mitarbeiter im Link angegeben"}
        {pendingCount > 0 && ` · ${pendingCount} Eintrag${pendingCount > 1 ? "e" : ""} ausstehend`}
      </div>
    </div>
  );
}

function getStyles(dark) {
  const c = dark
    ? {
        bg: "#000000",
        cardBg: "#1c1c1e",
        cardBg2: "#2c2c2e",
        text: "#ffffff",
        textSecondary: "#98989d",
        textTertiary: "#636366",
        divider: "#38383a",
        inputBg: "#2c2c2e",
        resultBg: "linear-gradient(160deg, #0a1f3d 0%, #14213d 100%)",
        resultBorder: "#1f3a63",
        resultDezimal: "#6ea8e8",
        shadow: "0 1px 3px rgba(0,0,0,0.3)",
        overlayBg: "rgba(0,0,0,0.6)",
        empty: "#48484a",
        infoBoxBg: "#1c2e1c",
        infoBoxBorder: "#2d4a2d",
      }
    : {
        bg: "#f2f2f7",
        cardBg: "#ffffff",
        cardBg2: "#f2f2f7",
        text: "#1c1c1e",
        textSecondary: "#8e8e93",
        textTertiary: "#c7c7cc",
        divider: "#e5e5ea",
        inputBg: "#f2f2f7",
        resultBg: "linear-gradient(160deg, #eaf2ff 0%, #f5f8ff 100%)",
        resultBorder: "#dce8fb",
        resultDezimal: "#6e93c4",
        shadow: "0 1px 3px rgba(0,0,0,0.04)",
        overlayBg: "rgba(0,0,0,0.35)",
        empty: "#c7c7cc",
        infoBoxBg: "#fff8e6",
        infoBoxBorder: "#ffe4a3",
      };

  const accent = "#007aff";

  return {
    root: { fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Helvetica Neue', sans-serif", background: c.bg, minHeight: "100vh", maxWidth: 480, margin: "0 auto", paddingBottom: 48, color: c.text, transition: "background 0.2s ease" },
    header: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "32px 20px 20px" },
    headerLabel: { fontSize: 15, fontWeight: 700, letterSpacing: "0", color: c.text, marginBottom: 4 },
    headerSub: { fontSize: 13, fontWeight: 500, color: c.textSecondary },
    settingsBtn: { background: c.cardBg, border: "none", borderRadius: 12, width: 40, height: 40, fontSize: 17, cursor: "pointer", boxShadow: c.shadow },
    pendingBadge: { position: "absolute", top: -5, right: -5, background: "#ff9500", color: "#fff", fontSize: 11, fontWeight: 700, borderRadius: 10, minWidth: 18, height: 18, display: "flex", alignItems: "center", justifyContent: "center", padding: "0 4px" },
    offlineBanner: { margin: "0 20px 12px", borderRadius: 14, padding: "11px 14px", fontSize: 13, fontWeight: 500, color: "#fff", background: "#ff9500", lineHeight: 1.4 },
    toast: { margin: "0 20px 12px", borderRadius: 14, padding: "13px 16px", fontSize: 14, fontWeight: 500, color: "#fff", boxShadow: "0 4px 14px rgba(0,0,0,0.12)" },
    card: { margin: "8px 16px 12px", background: c.cardBg, borderRadius: 20, padding: "22px 18px", boxShadow: c.shadow },
    cardTitle: { fontSize: 13, fontWeight: 600, letterSpacing: "0.01em", color: c.textSecondary, marginBottom: 18, textTransform: "uppercase" },
    syncBtn: { background: accent, border: "none", borderRadius: 10, padding: "8px 12px", color: "#fff", fontSize: 13, fontWeight: 600, cursor: "pointer" },
    label: { display: "block", fontSize: 13, fontWeight: 500, color: c.textSecondary, marginBottom: 7, marginTop: 16 },
    input: { display: "block", width: "100%", background: c.inputBg, border: "1px solid transparent", borderRadius: 12, padding: "12px 14px", fontSize: 16, color: c.text, outline: "none", boxSizing: "border-box", colorScheme: dark ? "dark" : "light", fontFamily: "inherit" },
    tagesartGrid: { display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8, marginBottom: 4 },
    tagesartBtn: { display: "flex", flexDirection: "column", alignItems: "center", gap: 4, padding: "12px 4px", background: c.cardBg2, border: "1.5px solid transparent", borderRadius: 14, color: c.textSecondary, fontSize: 11, fontWeight: 600, cursor: "pointer" },
    tagesartBtnOn: { border: `1.5px solid ${accent}`, color: accent, background: dark ? "#0a2647" : "#eaf2ff" },
    infoBox: { marginTop: 16, background: c.infoBoxBg, border: `1px solid ${c.infoBoxBorder}`, borderRadius: 12, padding: "12px 14px", fontSize: 13, color: c.text, lineHeight: 1.5 },
    resultBox: { marginTop: 22, background: c.resultBg, border: `1px solid ${c.resultBorder}`, borderRadius: 18, padding: "20px 16px", textAlign: "center", minHeight: 84, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" },
    resultLabel: { fontSize: 11, fontWeight: 600, letterSpacing: "0.08em", color: accent, marginBottom: 6, textTransform: "uppercase" },
    resultValue: { fontSize: 40, fontWeight: 700, color: c.text, lineHeight: 1.1, letterSpacing: "-0.02em" },
    resultUnit: { fontSize: 18, fontWeight: 500, color: accent, marginLeft: 2 },
    resultDezimal: { fontSize: 13, color: c.resultDezimal, marginTop: 5, fontWeight: 500 },
    resultPlaceholder: { color: c.empty, fontSize: 15 },
    divider: { height: 1, background: c.divider, margin: "24px 0 18px" },
    sectionLabel: { fontSize: 12, fontWeight: 600, letterSpacing: "0.06em", color: c.textSecondary, marginBottom: 12, textTransform: "uppercase" },
    colLabel: { fontSize: 12, fontWeight: 500, color: c.textSecondary, marginBottom: 6 },
    projektBlock: { marginBottom: 14 },
    projektRow: { display: "flex", alignItems: "flex-end", marginBottom: 0 },
    removeBtn: { background: "transparent", border: "none", color: c.textTertiary, fontSize: 16, cursor: "pointer", padding: "0 0 0 8px", marginBottom: 3, lineHeight: 1, flexShrink: 0 },
    addBtn: { display: "flex", alignItems: "center", justifyContent: "center", gap: 8, background: c.cardBg2, border: "none", borderRadius: 12, padding: "12px 14px", color: accent, fontSize: 15, fontWeight: 600, cursor: "pointer", width: "100%", marginTop: 6 },
    addBtnPlus: { fontSize: 17, color: accent, lineHeight: 1 },
    summeBox: { display: "flex", justifyContent: "space-between", alignItems: "center", background: c.cardBg2, borderRadius: 12, padding: "12px 14px", marginTop: 12 },
    summeLabel: { fontSize: 13, fontWeight: 500, color: c.textSecondary },
    summeWert: { fontSize: 16, fontWeight: 700, color: c.text },
    submitBtn: { marginTop: 22, width: "100%", background: accent, border: "none", borderRadius: 14, padding: "16px", fontSize: 16, fontWeight: 600, color: "#fff", cursor: "pointer", boxShadow: "0 4px 12px rgba(0,122,255,0.25)" },
    entryCard: { background: c.cardBg2, borderRadius: 14, padding: "14px 14px", marginBottom: 10 },
    entryHeader: { display: "flex", justifyContent: "space-between", alignItems: "flex-start" },
    entryDate: { fontSize: 15, fontWeight: 600, color: c.text, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" },
    tagBadge: { fontSize: 11, fontWeight: 600, color: accent, background: dark ? "#0a2647" : "#eaf2ff", padding: "3px 8px", borderRadius: 8 },
    syncBadge: { fontSize: 11, fontWeight: 600, padding: "3px 8px", borderRadius: 8 },
    entryMeta: { fontSize: 13, color: c.textSecondary, marginTop: 3 },
    entryHours: { fontSize: 13, fontWeight: 700, color: accent, textAlign: "right", maxWidth: 130 },
    deleteBtn: { background: "transparent", border: "none", color: c.textTertiary, fontSize: 16, cursor: "pointer", padding: "0 2px", lineHeight: 1 },
    projektList: { marginTop: 10, borderTop: `1px solid ${c.divider}`, paddingTop: 8, display: "flex", flexDirection: "column", gap: 5 },
    projektItem: { display: "flex", alignItems: "center", gap: 8 },
    projektDot: { color: accent, fontSize: 14 },
    projektName: { fontSize: 13, color: dark ? "#d1d1d6" : "#3a3a3c", flex: 1 },
    projektStunden: { fontSize: 13, fontWeight: 600, color: c.text },
    empty: { textAlign: "center", color: c.empty, padding: "48px 24px", fontSize: 14 },
    footer: { textAlign: "center", fontSize: 12, color: c.empty, padding: "28px 0 8px", fontWeight: 500 },
    overlay: { position: "fixed", inset: 0, background: c.overlayBg, backdropFilter: "blur(4px)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100, padding: 20 },
    modal: { background: c.cardBg, borderRadius: 22, padding: 26, width: "100%", maxWidth: 400, boxShadow: "0 20px 60px rgba(0,0,0,0.3)" },
    modalTitle: { fontSize: 18, fontWeight: 700, marginBottom: 20, color: c.text, letterSpacing: "-0.01em" },
    modalActions: { display: "flex", gap: 10, marginTop: 26 },
    cancelBtn: { flex: 1, padding: "13px", background: c.cardBg2, border: "none", borderRadius: 12, color: c.text, fontSize: 15, fontWeight: 600, cursor: "pointer" },
    saveBtn: { flex: 1, padding: "13px", background: accent, border: "none", borderRadius: 12, color: "#fff", fontSize: 15, fontWeight: 600, cursor: "pointer" },
    textSecondaryColor: c.textSecondary,
  };
}
