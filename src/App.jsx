import { useState, useEffect } from "react";

const STORAGE_KEY = "zeiterfassung_eintraege";

const NOTION_TOKEN = "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";
const NOTION_DB_ARBEITSTAGE = "3906606acb1d802fbcd1c68844c94151";
const NOTION_DB_PROJEKTE = "3906606acb1d80efa3cfc8b1312b4df2";

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
  const [notionToken, setNotionToken] = useState("");
  const [notionDb, setNotionDb] = useState("");
  const [notionDbProjekte, setNotionDbProjekte] = useState("");
  const [speicherMode, setSpeicherMode] = useState("lokal");
  const [status, setStatus] = useState(null);
  const [settings, setSettings] = useState(false);
  const [loading, setLoading] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState(null);

  useEffect(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) setEintraege(JSON.parse(saved));
    setNotionToken(localStorage.getItem("notion_token") || "");
    setNotionDb(localStorage.getItem("notion_db") || "");
    setNotionDbProjekte(localStorage.getItem("notion_db_projekte") || "");
    setSpeicherMode(localStorage.getItem("speicher_mode") || "lokal");
  }, []);

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

  function saveSettings() {
    localStorage.setItem("notion_token", notionToken);
    localStorage.setItem("notion_db", notionDb);
    localStorage.setItem("notion_db_projekte", notionDbProjekte);
    localStorage.setItem("speicher_mode", speicherMode);
    setSettings(false);
    showStatus("success", "Einstellungen gespeichert ✓");
  }

  function showStatus(type, msg) {
    setStatus({ type, msg });
    setTimeout(() => setStatus(null), 3500);
  }

  async function handleSubmit() {
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

    if (speicherMode === "notion") {
      const ok = await sendeAnNotion(eintrag);
      if (!ok) { setLoading(false); return; }
    }

    const neu = [eintrag, ...eintraege];
    setEintraege(neu);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(neu));
    setForm({ ...initialForm, datum: form.datum, projekte: [emptyProjekt()] });
    showStatus("success", speicherMode === "notion" ? "An Notion gesendet ✓" : "Lokal gespeichert ✓");
    setLoading(false);
  }

  async function sendeAnNotion(eintrag) {
    const proxyUrl = "/api/notion";
    if (!notionToken || !notionDb || !notionDbProjekte) {
      showStatus("error", "Notion Token und beide Datenbank-IDs müssen in den Einstellungen eingetragen sein.");
      return false;
    }

    // Wochentag berechnen
    const wochentage = ["Sonntag","Montag","Dienstag","Mittwoch","Donnerstag","Freitag","Samstag"];
    const datumObj = new Date(eintrag.datum + "T12:00:00");
    const wochentag = wochentage[datumObj.getDay()];

    try {
      // --- DB 1: Arbeitstag ---
      const res1 = await fetch(proxyUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token: notionToken,
          body: {
            parent: { database_id: notionDb },
            properties: {
              Tag: { title: [{ text: { content: wochentag } }] },
              Datum: { date: { start: eintrag.datum } },
              Arbeitsbeginn: { rich_text: [{ text: { content: eintrag.arbeitsbeginn } }] },
              Arbeitsende: { rich_text: [{ text: { content: eintrag.arbeitsende } }] },
              PauseMinuten: { number: eintrag.pauseMinuten },
              Gesamtarbeitszeit: { number: eintrag.gesamtArbeitszeit },
            },
          },
        }),
      });
      if (!res1.ok) {
        const err = await res1.json();
        showStatus("error", `Notion Fehler (Arbeitstage): ${err.message || res1.status}`);
        return false;
      }

      // --- DB 2: Projekte (ein Eintrag pro Projekt) ---
      for (const proj of eintrag.projekte) {
        const res2 = await fetch(proxyUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            token: notionToken,
            body: {
              parent: { database_id: notionDbProjekte },
              properties: {
                Projekt: { title: [{ text: { content: proj.name } }] },
                Datum: { date: { start: eintrag.datum } },
                Stunden: { number: proj.stunden },
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
          <div style={s.headerLabel}>ZEITERFASSUNG</div>
          <div style={s.headerSub}>Arbeitszeiten erfassen & verwalten</div>
        </div>
        <button style={s.settingsBtn} onClick={() => setSettings(true)}>⚙️</button>
      </div>

      {/* Toast */}
      {status && (
        <div style={{ ...s.toast, background: status.type === "error" ? "#ef4444" : "#10b981" }}>
          {status.msg}
        </div>
      )}

      {/* Settings Modal */}
      {settings && (
        <div style={s.overlay}>
          <div style={s.modal}>
            <div style={s.modalTitle}>Einstellungen</div>
            <label style={s.label}>Speichermodus</label>
            <div style={s.radioGroup}>
              {["lokal", "notion"].map((m) => (
                <button key={m}
                  style={{ ...s.radioBtn, ...(speicherMode === m ? s.radioBtnOn : {}) }}
                  onClick={() => setSpeicherMode(m)}>
                  {m === "lokal" ? "💾 Lokal" : "📄 Notion API"}
                </button>
              ))}
            </div>
            {speicherMode === "notion" && (
              <>
                <label style={s.label}>Notion Integration Token</label>
                <input style={s.input} placeholder="secret_xxxx..." value={notionToken}
                  onChange={(e) => setNotionToken(e.target.value)} type="password" />
                <label style={s.label}>Datenbank-ID – Arbeitstage</label>
                <input style={s.input} placeholder="ID der Arbeitstage-Datenbank" value={notionDb}
                  onChange={(e) => setNotionDb(e.target.value)} />
                <label style={s.label}>Datenbank-ID – Projekte</label>
                <input style={s.input} placeholder="ID der Projekte-Datenbank" value={notionDbProjekte}
                  onChange={(e) => setNotionDbProjekte(e.target.value)} />
                <div style={s.hint}>
                  <b style={{color:"#6ee7b7"}}>DB Arbeitstage:</b> Tag (Titel), Datum, Arbeitsbeginn, Arbeitsende (Text), PauseMinuten, Gesamtarbeitszeit (Zahl).<br/><br/>
                  <b style={{color:"#6ee7b7"}}>DB Projekte:</b> Projekt (Titel), Datum (Datum), Stunden (Zahl).
                </div>
              </>
            )}
            <div style={s.modalActions}>
              <button style={s.cancelBtn} onClick={() => setSettings(false)}>Abbrechen</button>
              <button style={s.saveBtn} onClick={saveSettings}>Speichern</button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Confirm */}
      {deleteConfirm && (
        <div style={s.overlay}>
          <div style={s.modal}>
            <div style={s.modalTitle}>Eintrag löschen?</div>
            <div style={{ color: "#94a3b8", marginBottom: 24, fontSize: 14 }}>Dieser Eintrag wird unwiderruflich gelöscht.</div>
            <div style={s.modalActions}>
              <button style={s.cancelBtn} onClick={() => setDeleteConfirm(null)}>Abbrechen</button>
              <button style={{ ...s.saveBtn, background: "#ef4444" }} onClick={() => loescheEintrag(deleteConfirm)}>Löschen</button>
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
          {loading ? "Wird gespeichert…" : speicherMode === "notion" ? "📄 An Notion senden" : "💾 Lokal speichern"}
        </button>
      </div>

      {/* Summary */}
      {eintraege.length > 0 && (
        <div style={s.summaryBar}>
          <span style={{ color: "#94a3b8", fontSize: 13 }}>{eintraege.length} Einträge</span>
          <span style={{ color: "#34d399", fontWeight: 700, fontSize: 15 }}>{gesamtStunden.toFixed(2)} h gesamt</span>
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
        Modus: {speicherMode === "notion" ? "📄 Notion API" : "💾 Lokaler Speicher"}
      </div>
    </div>
  );
}

const s = {
  root: { fontFamily: "'Inter', -apple-system, sans-serif", background: "#0f172a", minHeight: "100vh", maxWidth: 480, margin: "0 auto", paddingBottom: 48, color: "#f1f5f9" },
  header: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "28px 20px 16px", borderBottom: "1px solid #1e293b" },
  headerLabel: { fontSize: 11, fontWeight: 700, letterSpacing: "0.15em", color: "#34d399", marginBottom: 2 },
  headerSub: { fontSize: 16, fontWeight: 600, color: "#e2e8f0" },
  settingsBtn: { background: "#1e293b", border: "none", borderRadius: 10, width: 40, height: 40, fontSize: 18, cursor: "pointer" },
  toast: { margin: "12px 20px 0", borderRadius: 10, padding: "12px 16px", fontSize: 14, fontWeight: 500, color: "#fff" },
  card: { margin: "20px 16px 0", background: "#1e293b", borderRadius: 16, padding: "20px 18px" },
  cardTitle: { fontSize: 13, fontWeight: 700, letterSpacing: "0.1em", color: "#64748b", marginBottom: 16, textTransform: "uppercase" },
  label: { display: "block", fontSize: 12, fontWeight: 600, color: "#94a3b8", marginBottom: 6, marginTop: 14, letterSpacing: "0.04em" },
  input: { display: "block", width: "100%", background: "#0f172a", border: "1.5px solid #334155", borderRadius: 10, padding: "11px 13px", fontSize: 15, color: "#f1f5f9", outline: "none", boxSizing: "border-box", colorScheme: "dark" },
  row: { display: "flex", marginTop: 0 },
  resultBox: { marginTop: 20, background: "linear-gradient(135deg, #064e3b 0%, #0f172a 100%)", border: "1.5px solid #34d399", borderRadius: 14, padding: "18px 16px", textAlign: "center", minHeight: 80, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" },
  resultLabel: { fontSize: 10, fontWeight: 700, letterSpacing: "0.14em", color: "#34d399", marginBottom: 4 },
  resultValue: { fontSize: 44, fontWeight: 800, color: "#fff", lineHeight: 1.1 },
  resultUnit: { fontSize: 20, fontWeight: 500, color: "#34d399", marginLeft: 2 },
  resultDezimal: { fontSize: 13, color: "#6ee7b7", marginTop: 4 },
  resultPlaceholder: { color: "#334155", fontSize: 15, fontStyle: "italic" },
  divider: { height: 1, background: "#334155", margin: "22px 0 18px" },
  sectionLabel: { fontSize: 11, fontWeight: 700, letterSpacing: "0.12em", color: "#475569", marginBottom: 12 },
  colLabel: { fontSize: 11, fontWeight: 600, color: "#64748b", marginBottom: 5, letterSpacing: "0.04em" },
  projektRow: { display: "flex", alignItems: "flex-end", marginBottom: 10 },
  removeBtn: { background: "transparent", border: "none", color: "#475569", fontSize: 15, cursor: "pointer", padding: "0 0 0 6px", marginBottom: 2, lineHeight: 1, flexShrink: 0 },
  addBtn: { display: "flex", alignItems: "center", gap: 8, background: "#0f172a", border: "1.5px dashed #334155", borderRadius: 10, padding: "10px 14px", color: "#64748b", fontSize: 14, fontWeight: 600, cursor: "pointer", width: "100%", marginTop: 4 },
  addBtnPlus: { fontSize: 18, color: "#34d399", lineHeight: 1 },
  summeBox: { display: "flex", justifyContent: "space-between", alignItems: "center", background: "#0f172a", border: "1.5px solid #334155", borderRadius: 10, padding: "10px 14px", marginTop: 10 },
  summeLabel: { fontSize: 12, fontWeight: 600, color: "#64748b", letterSpacing: "0.04em" },
  summeWert: { fontSize: 15, fontWeight: 700, color: "#34d399" },
  submitBtn: { marginTop: 20, width: "100%", background: "linear-gradient(135deg, #059669, #34d399)", border: "none", borderRadius: 12, padding: "15px", fontSize: 15, fontWeight: 700, color: "#fff", cursor: "pointer", letterSpacing: "0.02em" },
  summaryBar: { display: "flex", justifyContent: "space-between", alignItems: "center", margin: "20px 16px 4px", padding: "10px 14px", background: "#1e293b", borderRadius: 10 },
  listSection: { margin: "0 16px" },
  listTitle: { fontSize: 11, fontWeight: 700, letterSpacing: "0.1em", color: "#475569", textTransform: "uppercase", margin: "16px 0 10px" },
  entryCard: { background: "#1e293b", borderRadius: 12, padding: "14px 16px", marginBottom: 10 },
  entryHeader: { display: "flex", justifyContent: "space-between", alignItems: "flex-start" },
  entryDate: { fontSize: 15, fontWeight: 600, color: "#e2e8f0" },
  entryMeta: { fontSize: 12, color: "#64748b", marginTop: 3 },
  entryHours: { fontSize: 16, fontWeight: 700, color: "#34d399" },
  deleteBtn: { background: "transparent", border: "none", color: "#475569", fontSize: 15, cursor: "pointer", padding: "0 2px", lineHeight: 1 },
  projektList: { marginTop: 10, borderTop: "1px solid #334155", paddingTop: 10, display: "flex", flexDirection: "column", gap: 4 },
  projektItem: { display: "flex", alignItems: "center", gap: 6 },
  projektDot: { color: "#34d399", fontSize: 14 },
  projektName: { fontSize: 13, color: "#94a3b8", flex: 1 },
  projektStunden: { fontSize: 13, fontWeight: 600, color: "#6ee7b7" },
  empty: { textAlign: "center", color: "#334155", padding: "40px 20px", fontSize: 14 },
  footer: { textAlign: "center", fontSize: 12, color: "#334155", padding: "24px 0 8px" },
  overlay: { position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100, padding: 20 },
  modal: { background: "#1e293b", borderRadius: 18, padding: 24, width: "100%", maxWidth: 400 },
  modalTitle: { fontSize: 17, fontWeight: 700, marginBottom: 20, color: "#f1f5f9" },
  radioGroup: { display: "flex", gap: 10, marginBottom: 4 },
  radioBtn: { flex: 1, padding: "10px", background: "#0f172a", border: "1.5px solid #334155", borderRadius: 10, color: "#94a3b8", fontSize: 14, fontWeight: 600, cursor: "pointer" },
  radioBtnOn: { border: "1.5px solid #34d399", color: "#34d399", background: "#064e3b33" },
  hint: { fontSize: 12, color: "#64748b", marginTop: 8, lineHeight: 1.6 },
  modalActions: { display: "flex", gap: 10, marginTop: 24 },
  cancelBtn: { flex: 1, padding: "12px", background: "#0f172a", border: "1.5px solid #334155", borderRadius: 10, color: "#94a3b8", fontSize: 14, fontWeight: 600, cursor: "pointer" },
  saveBtn: { flex: 1, padding: "12px", background: "#059669", border: "none", borderRadius: 10, color: "#fff", fontSize: 14, fontWeight: 700, cursor: "pointer" },
};
