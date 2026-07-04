import { useState, useEffect } from "react";

const STORAGE_KEY = "zeiterfassung_eintraege";

// Fest hinterlegte Notion-Zugangsdaten
const NOTION_TOKEN = "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";
const NOTION_DB_ARBEITSTAGE = "3906606acb1d802fbcd1c68844c94151";
const NOTION_DB_PROJEKTE = "3906606acb1d80efa3cfc8b1312b4df2";

function getMitarbeiterAusUrl() {
  const params = new URLSearchParams(window.location.search);
  return params.get("mitarbeiter") || "";
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

const emptyProjekt = () => ({ id: Date.now() + Math.random(), name: "", stunden: "" });

const initialForm = {
  datum: new Date().toISOString().split("T")[0],
  arbeitsbeginn: "",
  arbeitsende: "",
  pauseMinuten: "0",
  projekte: [emptyProjekt()],
};

export default function App() {
  const [form, setForm] = useState(initialForm);
  const [eintraege, setEintraege] = useState([]);
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState(null);
  const [darkMode, setDarkMode] = useState(false);
  const mitarbeiter = getMitarbeiterAusUrl();

  useEffect(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) setEintraege(JSON.parse(saved));
    setDarkMode(localStorage.getItem("dark_mode") === "true");
  }, []);

  function toggleDarkMode() {
    setDarkMode((d) => {
      localStorage.setItem("dark_mode", (!d).toString());
      return !d;
    });
  }

  const s = getStyles(darkMode);

  const arbeitszeit = berechneArbeitszeit(form.arbeitsbeginn, form.arbeitsende, form.pauseMinuten);

  function handleChange(e) {
    setForm((f) => ({ ...f, [e.target.name]: e.target.value }));
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
    setTimeout(() => setStatus(null), 3500);
  }

  async function handleSubmit() {
    if (!mitarbeiter) {
      showStatus("error", "Kein Mitarbeitername im Link gefunden. Bitte den korrekten Link verwenden.");
      return;
    }
    if (!form.datum || !form.arbeitsbeginn || !form.arbeitsende) {
      showStatus("error", "Bitte Datum, Arbeitsbeginn und Arbeitsende ausfüllen.");
      return;
    }
    if (!arbeitszeit) {
      showStatus("error", "Arbeitsende muss nach Arbeitsbeginn liegen.");
      return;
    }
    const valideProjekte = form.projekte.filter((p) => p.name.trim());
    if (valideProjekte.length === 0) {
      showStatus("error", "Bitte mindestens ein Projekt eintragen.");
      return;
    }
    const summeProjekte = valideProjekte.reduce((acc, p) => acc + (parseFloat(p.stunden) || 0), 0);
    const nettoStunden = parseFloat(arbeitszeit.dezimal);
    if (Math.abs(summeProjekte - nettoStunden) > 0.01) {
      showStatus("error", `Projektstunden (${summeProjekte.toFixed(2)}h) stimmen nicht mit der Netto-Arbeitszeit (${nettoStunden.toFixed(2)}h) überein.`);
      return;
    }

    setLoading(true);

    const eintrag = {
      id: Date.now(),
      datum: form.datum,
      arbeitsbeginn: form.arbeitsbeginn,
      arbeitsende: form.arbeitsende,
      pauseMinuten: parseFloat(form.pauseMinuten || 0),
      gesamtArbeitszeit: parseFloat(arbeitszeit.dezimal),
      gesamtArbeitszeitFormatiert: `${arbeitszeit.h}h ${arbeitszeit.m}m`,
      projekte: valideProjekte.map((p) => ({
        name: p.name,
        stunden: parseFloat(p.stunden) || 0,
      })),
    };

    const ok = await sendeAnNotion(eintrag);
    if (!ok) { setLoading(false); return; }

    const neu = [eintrag, ...eintraege];
    setEintraege(neu);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(neu));
    setForm({ ...initialForm, datum: form.datum, projekte: [emptyProjekt()] });
    showStatus("success", "An Notion gesendet ✓");
    setLoading(false);
  }

  async function sendeAnNotion(eintrag) {
    const proxyUrl = "/api/notion";

    const wochentage = ["Sonntag","Montag","Dienstag","Mittwoch","Donnerstag","Freitag","Samstag"];
    const datumObj = new Date(eintrag.datum + "T12:00:00");
    const wochentag = wochentage[datumObj.getDay()];

    try {
      const res1 = await fetch(proxyUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token: NOTION_TOKEN,
          body: {
            parent: { database_id: NOTION_DB_ARBEITSTAGE },
            properties: {
              Tag: { title: [{ text: { content: wochentag } }] },
              Datum: { date: { start: eintrag.datum } },
              Arbeitsbeginn: { rich_text: [{ text: { content: eintrag.arbeitsbeginn } }] },
              Arbeitsende: { rich_text: [{ text: { content: eintrag.arbeitsende } }] },
              PauseMinuten: { number: eintrag.pauseMinuten },
              Gesamtarbeitszeit: { number: eintrag.gesamtArbeitszeit },
              Mitarbeiter: { select: { name: mitarbeiter } },
            },
          },
        }),
      });
      if (!res1.ok) {
        const err = await res1.json();
        showStatus("error", `Notion Fehler (Arbeitstage): ${err.message || res1.status}`);
        return false;
      }

      for (const proj of eintrag.projekte) {
        const res2 = await fetch(proxyUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            token: NOTION_TOKEN,
            body: {
              parent: { database_id: NOTION_DB_PROJEKTE },
              properties: {
                Projekt: { title: [{ text: { content: proj.name } }] },
                Datum: { date: { start: eintrag.datum } },
                Stunden: { number: proj.stunden },
                Mitarbeiter: { select: { name: mitarbeiter } },
              },
            },
          }),
        });
        if (!res2.ok) {
          const err = await res2.json();
          showStatus("error", `Notion Fehler (Projekte): ${err.message || res2.status}`);
          return false;
        }
      }

      return true;
    } catch (e) {
      showStatus("error", `Netzwerkfehler: ${e.message}`);
      return false;
    }
  }

  function loescheEintrag(id) {
    const neu = eintraege.filter((e) => e.id !== id);
    setEintraege(neu);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(neu));
    setDeleteConfirm(null);
  }

  const gesamtStunden = eintraege.reduce((s, e) => s + e.gesamtArbeitszeit, 0);

  return (
    <div style={s.root}>
      {/* Header */}
      <div style={s.header}>
        <div>
          <div style={s.headerLabel}>{mitarbeiter ? `Hallo ${mitarbeiter} 👋` : "ZEITERFASSUNG"}</div>
          <div style={s.headerSub}>Arbeitszeiten erfassen</div>
        </div>
        <button style={s.settingsBtn} onClick={toggleDarkMode}>{darkMode ? "☀️" : "🌙"}</button>
      </div>

      {/* Toast */}
      {status && (
        <div style={{ ...s.toast, background: status.type === "error" ? "#ff3b30" : "#34c759" }}>
          {status.msg}
        </div>
      )}

      {/* Delete Confirm */}
      {deleteConfirm && (
        <div style={s.overlay}>
          <div style={s.modal}>
            <div style={s.modalTitle}>Eintrag löschen?</div>
            <div style={{ color: s.textSecondaryColor, marginBottom: 24, fontSize: 14 }}>Dieser Eintrag wird unwiderruflich gelöscht.</div>
            <div style={s.modalActions}>
              <button style={s.cancelBtn} onClick={() => setDeleteConfirm(null)}>Abbrechen</button>
              <button style={{ ...s.saveBtn, background: "#ff3b30" }} onClick={() => loescheEintrag(deleteConfirm)}>Löschen</button>
            </div>
          </div>
        </div>
      )}

      {/* Form Card */}
      <div style={s.card}>
        <div style={s.cardTitle}>Neuer Eintrag</div>

        {/* Datum */}
        <label style={{ ...s.label, textAlign: "center" }}>Datum *</label>
        <div style={{ display: "flex", justifyContent: "center" }}>
          <input style={{ ...s.input, width: "auto", minWidth: 160, maxWidth: 200, textAlign: "center" }} type="date" name="datum" value={form.datum} onChange={handleChange} />
        </div>

        {/* Arbeitsbeginn + Arbeitsende */}
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

        {/* Pausen Minuten */}
        <label style={s.label}>Pausen Minuten</label>
        <input style={s.input} type="number" name="pauseMinuten" min="0" max="480" step="5"
          placeholder="0" value={form.pauseMinuten} onChange={handleChange} />

        {/* Live Arbeitszeit */}
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

        {/* Divider */}
        <div style={s.divider} />

        {/* Projekte */}
        <div style={s.sectionLabel}>PROJEKTE</div>

        {form.projekte.map((proj, idx) => (
          <div key={proj.id} style={s.projektRow}>
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
        ))}

        {/* + Projekt hinzufügen */}
        <button style={s.addBtn} onClick={addProjekt}>
          <span style={s.addBtnPlus}>＋</span> Projekt hinzufügen
        </button>

        {/* Summe Projektstunden */}
        {(() => {
          const summe = form.projekte.reduce((acc, p) => acc + (parseFloat(p.stunden) || 0), 0);
          return (
            <div style={s.summeBox}>
              <span style={s.summeLabel}>Summe Projektstunden</span>
              <span style={s.summeWert}>{summe.toFixed(1)} h</span>
            </div>
          );
        })()}

        {/* Submit */}
        <button style={{ ...s.submitBtn, opacity: loading ? 0.7 : 1 }} onClick={handleSubmit} disabled={loading}>
          {loading ? "Wird gespeichert…" : "📄 An Notion senden"}
        </button>
      </div>

      {/* Summary */}
      {eintraege.length > 0 && (
        <div style={s.summaryBar}>
          <span style={{ color: s.textSecondaryColor, fontSize: 13 }}>{eintraege.length} Einträge</span>
          <span style={{ color: "#007aff", fontWeight: 700, fontSize: 15 }}>{gesamtStunden.toFixed(2)} h gesamt</span>
        </div>
      )}

      {/* Entries */}
      {eintraege.length > 0 && (
        <div style={s.listSection}>
          <div style={s.listTitle}>Gespeicherte Einträge</div>
          {eintraege.map((e) => (
            <div key={e.id} style={s.entryCard}>
              <div style={s.entryHeader}>
                <div>
                  <div style={s.entryDate}>{formatDate(e.datum)}</div>
                  <div style={s.entryMeta}>{e.arbeitsbeginn} – {e.arbeitsende} · {e.pauseMinuten} Min. Pause</div>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <div style={s.entryHours}>{e.gesamtArbeitszeitFormatiert}</div>
                  <button style={s.deleteBtn} onClick={() => setDeleteConfirm(e.id)}>✕</button>
                </div>
              </div>
              {e.projekte && e.projekte.length > 0 && (
                <div style={s.projektList}>
                  {e.projekte.map((p, i) => (
                    <div key={i} style={s.projektItem}>
                      <span style={s.projektDot}>•</span>
                      <span style={s.projektName}>{p.name}</span>
                      {p.stunden > 0 && <span style={s.projektStunden}>{p.stunden}h</span>}
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {eintraege.length === 0 && (
        <div style={s.empty}>Noch keine Einträge. Trag deine erste Arbeitszeit ein!</div>
      )}

      <div style={s.footer}>
        {mitarbeiter ? `Angemeldet als ${mitarbeiter}` : "Kein Mitarbeiter im Link angegeben"}
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
        radioOnBg: "#0a2647",
        empty: "#48484a",
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
        radioOnBg: "#eaf2ff",
        empty: "#c7c7cc",
      };

  const accent = "#007aff";

  return {
    root: { fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Helvetica Neue', sans-serif", background: c.bg, minHeight: "100vh", maxWidth: 480, margin: "0 auto", paddingBottom: 48, color: c.text, transition: "background 0.2s ease" },
    header: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "32px 20px 20px" },
    headerLabel: { fontSize: 15, fontWeight: 700, letterSpacing: "0", color: c.text, marginBottom: 4 },
    headerSub: { fontSize: 13, fontWeight: 500, color: c.textSecondary },
    settingsBtn: { background: c.cardBg, border: "none", borderRadius: 12, width: 40, height: 40, fontSize: 17, cursor: "pointer", boxShadow: c.shadow },
    toast: { margin: "0 20px 12px", borderRadius: 14, padding: "13px 16px", fontSize: 14, fontWeight: 500, color: "#fff", boxShadow: "0 4px 14px rgba(0,0,0,0.12)" },
    card: { margin: "8px 16px 0", background: c.cardBg, borderRadius: 20, padding: "22px 18px", boxShadow: c.shadow },
    cardTitle: { fontSize: 13, fontWeight: 600, letterSpacing: "0.01em", color: c.textSecondary, marginBottom: 18, textTransform: "uppercase" },
    label: { display: "block", fontSize: 13, fontWeight: 500, color: c.textSecondary, marginBottom: 7, marginTop: 16 },
    input: { display: "block", width: "100%", background: c.inputBg, border: "1px solid transparent", borderRadius: 12, padding: "12px 14px", fontSize: 16, color: c.text, outline: "none", boxSizing: "border-box", colorScheme: dark ? "dark" : "light", fontFamily: "inherit" },
    row: { display: "flex", marginTop: 0 },
    resultBox: { marginTop: 22, background: c.resultBg, border: `1px solid ${c.resultBorder}`, borderRadius: 18, padding: "20px 16px", textAlign: "center", minHeight: 84, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" },
    resultLabel: { fontSize: 11, fontWeight: 600, letterSpacing: "0.08em", color: accent, marginBottom: 6, textTransform: "uppercase" },
    resultValue: { fontSize: 40, fontWeight: 700, color: c.text, lineHeight: 1.1, letterSpacing: "-0.02em" },
    resultUnit: { fontSize: 18, fontWeight: 500, color: accent, marginLeft: 2 },
    resultDezimal: { fontSize: 13, color: c.resultDezimal, marginTop: 5, fontWeight: 500 },
    resultPlaceholder: { color: c.empty, fontSize: 15 },
    divider: { height: 1, background: c.divider, margin: "24px 0 18px" },
    sectionLabel: { fontSize: 12, fontWeight: 600, letterSpacing: "0.06em", color: c.textSecondary, marginBottom: 12, textTransform: "uppercase" },
    colLabel: { fontSize: 12, fontWeight: 500, color: c.textSecondary, marginBottom: 6 },
    projektRow: { display: "flex", alignItems: "flex-end", marginBottom: 10 },
    removeBtn: { background: "transparent", border: "none", color: c.textTertiary, fontSize: 16, cursor: "pointer", padding: "0 0 0 8px", marginBottom: 3, lineHeight: 1, flexShrink: 0 },
    addBtn: { display: "flex", alignItems: "center", justifyContent: "center", gap: 8, background: c.cardBg2, border: "none", borderRadius: 12, padding: "12px 14px", color: accent, fontSize: 15, fontWeight: 600, cursor: "pointer", width: "100%", marginTop: 6 },
    addBtnPlus: { fontSize: 17, color: accent, lineHeight: 1 },
    summeBox: { display: "flex", justifyContent: "space-between", alignItems: "center", background: c.cardBg2, borderRadius: 12, padding: "12px 14px", marginTop: 12 },
    summeLabel: { fontSize: 13, fontWeight: 500, color: c.textSecondary },
    summeWert: { fontSize: 16, fontWeight: 700, color: c.text },
    submitBtn: { marginTop: 22, width: "100%", background: accent, border: "none", borderRadius: 14, padding: "16px", fontSize: 16, fontWeight: 600, color: "#fff", cursor: "pointer", boxShadow: "0 4px 12px rgba(0,122,255,0.25)" },
    summaryBar: { display: "flex", justifyContent: "space-between", alignItems: "center", margin: "20px 16px 4px", padding: "14px 16px", background: c.cardBg, borderRadius: 16, boxShadow: c.shadow },
    listSection: { margin: "0 16px" },
    listTitle: { fontSize: 12, fontWeight: 600, letterSpacing: "0.06em", color: c.textSecondary, textTransform: "uppercase", margin: "20px 4px 10px" },
    entryCard: { background: c.cardBg, borderRadius: 16, padding: "16px 16px", marginBottom: 10, boxShadow: c.shadow },
    entryHeader: { display: "flex", justifyContent: "space-between", alignItems: "flex-start" },
    entryDate: { fontSize: 16, fontWeight: 600, color: c.text },
    entryMeta: { fontSize: 13, color: c.textSecondary, marginTop: 3 },
    entryHours: { fontSize: 16, fontWeight: 700, color: accent },
    deleteBtn: { background: "transparent", border: "none", color: c.textTertiary, fontSize: 16, cursor: "pointer", padding: "0 2px", lineHeight: 1 },
    projektList: { marginTop: 12, borderTop: `1px solid ${c.divider}`, paddingTop: 10, display: "flex", flexDirection: "column", gap: 6 },
    projektItem: { display: "flex", alignItems: "center", gap: 8 },
    projektDot: { color: accent, fontSize: 14 },
    projektName: { fontSize: 14, color: dark ? "#d1d1d6" : "#3a3a3c", flex: 1 },
    projektStunden: { fontSize: 14, fontWeight: 600, color: c.text },
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
