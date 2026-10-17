import { useEffect, useMemo, useState } from "react";
import BaustellenBalken from "./BaustellenBalken.jsx";
import { fmtStd, heuteStr, MONATSNAMEN, normName, stundenProBaustelle, toDateStr } from "./logik.js";

// Stunden pro Baustelle über einen frei wählbaren Zeitraum (z. B. dieses Jahr).
// Zuordnung über den Baustellennamen – gleiche Namen in verschiedenen Jahren werden im Zeitraum zusammengezählt.

const ZEITRAUM_KEY = "buero_baustellen_zeitraum";

function zeitraumVon(art, frei) {
  const heute = new Date();
  const j = heute.getFullYear();
  const m = heute.getMonth();
  const d = (y, mo, t) => toDateStr(new Date(y, mo, t, 12));
  switch (art) {
    case "monat": return { von: d(j, m, 1), bis: heuteStr() };
    case "vormonat": return { von: d(j, m - 1, 1), bis: d(j, m, 0) };
    case "drei": return { von: d(j, m - 2, 1), bis: heuteStr() };
    case "jahr": return { von: d(j, 0, 1), bis: heuteStr() };
    case "vorjahr": return { von: d(j - 1, 0, 1), bis: d(j - 1, 11, 31) };
    default: return frei;
  }
}

const ARTEN = [
  ["monat", "Dieser Monat"],
  ["vormonat", "Letzter Monat"],
  ["drei", "Letzte 3 Monate"],
  ["jahr", "Dieses Jahr"],
  ["vorjahr", "Letztes Jahr"],
  ["frei", "Von – bis"],
];

function gemerkt() {
  try {
    const g = JSON.parse(sessionStorage.getItem(ZEITRAUM_KEY) || "null");
    if (g && ARTEN.some(([k]) => k === g.art) && g.frei?.von && g.frei?.bis) return g;
  } catch {
    /* ignorieren */
  }
  const j = new Date().getFullYear();
  return { art: "jahr", frei: { von: `${j}-01-01`, bis: heuteStr() } };
}

const datumText = (d) => {
  const [y, m, t] = d.split("-").map(Number);
  return `${t}. ${MONATSNAMEN[m - 1].slice(0, 3)}. ${y}`;
};

export default function BaustellenStunden({ api }) {
  const [auswahl, setAuswahlRoh] = useState(gemerkt);
  const [stand, setStand] = useState({ schluessel: null, daten: null, fehler: null });
  const [version, setVersion] = useState(0);
  const [suche, setSuche] = useState("");
  const [offen, setOffen] = useState(null);

  const setAuswahl = (neu) => {
    setAuswahlRoh(neu);
    try {
      sessionStorage.setItem(ZEITRAUM_KEY, JSON.stringify(neu));
    } catch {
      /* ignorieren */
    }
  };

  const { von, bis } = zeitraumVon(auswahl.art, auswahl.frei);
  const gueltig = /^\d{4}-\d{2}-\d{2}$/.test(von) && /^\d{4}-\d{2}-\d{2}$/.test(bis) && von <= bis;
  const schluessel = `${von}|${bis}|${version}`;

  useEffect(() => {
    if (!gueltig) return;
    let aktiv = true;
    api("baustellenStunden", { von, bis })
      .then((daten) => aktiv && setStand({ schluessel, daten, fehler: null }))
      .catch((e) => aktiv && setStand({ schluessel, daten: null, fehler: e.message }));
    return () => {
      aktiv = false;
    };
  }, [api, von, bis, gueltig, schluessel]);

  const laedt = gueltig && stand.schluessel !== schluessel;
  const daten = stand.schluessel?.startsWith(`${von}|${bis}|`) ? stand.daten : null;

  const baustellen = useMemo(() => (daten ? stundenProBaustelle(daten.projekte, daten.azubis) : []), [daten]);
  const gefiltert = baustellen.filter((b) => b.name.toLowerCase().includes(suche.trim().toLowerCase()));
  const summe = gefiltert.reduce((a, b) => a + b.stunden, 0);
  const helfer = gefiltert.reduce((a, b) => a + b.helfer, 0);

  // Aufschlüsselung einer Baustelle: Stunden je Mitarbeiter, erster und letzter Tag
  function detail(b) {
    const k = normName(b.name);
    const eintraege = daten.projekte.filter((p) => normName(p.name) === k);
    const proMa = new Map();
    for (const p of eintraege) proMa.set(p.mitarbeiter, (proMa.get(p.mitarbeiter) || 0) + p.stunden);
    const tage = eintraege.map((p) => p.datum).sort();
    const azubis = new Set(daten.azubis);
    return (
      <div className="bs-detail">
        <span className="b-sek klein">
          {tage.length ? `${datumText(tage[0])} – ${datumText(tage[tage.length - 1])} · ${new Set(tage).size} Arbeitstage` : ""}
        </span>
        <div className="bs-detail-liste">
          {[...proMa.entries()].sort((a, b2) => b2[1] - a[1]).map(([name, h]) => (
            <span key={name} className="bs-detail-ma">
              <span>{name}{azubis.has(name) ? <span className="b-sek"> · Helfer</span> : null}</span>
              <b>{fmtStd(h)} h</b>
            </span>
          ))}
        </div>
      </div>
    );
  }

  return (
    <section className="b-seite w-seite">
      <div className="w-kopf">
        <div>
          <div className="w-kw">{gueltig ? `${datumText(von)} – ${datumText(bis)}` : "Zeitraum wählen"}</div>
          <h1 className="w-titel">Stunden pro Baustelle</h1>
        </div>
        <div className="w-steuerung">
          <button className="w-rund" aria-label="Aktualisieren" title="Aktualisieren" onClick={() => setVersion((v) => v + 1)} disabled={laedt}>
            <span className={laedt ? "w-dreht" : ""}>↻</span>
          </button>
        </div>
      </div>

      <div className="bs-auswahl">
        <div className="t-arten bs-arten" role="tablist" aria-label="Zeitraum">
          {ARTEN.map(([k, label]) => (
            <button key={k} role="tab" aria-selected={auswahl.art === k} className={auswahl.art === k ? "an" : ""} onClick={() => setAuswahl({ ...auswahl, art: k })}>
              {label}
            </button>
          ))}
        </div>
        {auswahl.art === "frei" && (
          <div className="bs-frei">
            <label className="b-feld"><span>Von</span><input type="date" value={auswahl.frei.von} onChange={(e) => setAuswahl({ ...auswahl, frei: { ...auswahl.frei, von: e.target.value } })} /></label>
            <label className="b-feld"><span>Bis</span><input type="date" value={auswahl.frei.bis} onChange={(e) => setAuswahl({ ...auswahl, frei: { ...auswahl.frei, bis: e.target.value } })} /></label>
          </div>
        )}
      </div>

      {!gueltig && <div className="b-fehler">Bitte einen gültigen Zeitraum wählen („Von“ vor „Bis“).</div>}
      {stand.fehler && stand.schluessel === schluessel && <div className="b-fehler">{stand.fehler}</div>}
      {gueltig && !daten && !stand.fehler && <div className="b-laden">Stunden werden aus Notion geladen… bei langen Zeiträumen kann das ein paar Sekunden dauern.</div>}

      {daten && (
        <div className={`b-karte bs-karte${laedt ? " laedt" : ""}`}>
          <div className="bs-kopfzeile">
            <span className="bs-summe">
              <b>{fmtStd(summe)} h</b> auf {gefiltert.length} {gefiltert.length === 1 ? "Baustelle" : "Baustellen"}
              {helfer > 0 && <span className="b-sek"> · davon Helfer {fmtStd(helfer)} h</span>}
            </span>
            <label className="bs-suche">
              <span className="b-unsichtbar">Baustelle suchen</span>
              <input value={suche} onChange={(e) => setSuche(e.target.value)} placeholder="Baustelle suchen…" />
            </label>
          </div>
          {gefiltert.length === 0 ? (
            <p className="b-sek">Keine Stunden in diesem Zeitraum{suche ? " für diese Suche" : ""}.</p>
          ) : (
            <BaustellenBalken baustellen={gefiltert} offen={offen} onAuswahl={(name) => setOffen(offen === name ? null : name)} detail={detail} />
          )}
        </div>
      )}

      <p className="b-legende">
        Baustellen werden über ihren Namen zusammengefasst. Arbeitet ihr später wieder beim selben Kunden, am besten einen
        neuen Namen vergeben (z. B. „Müller – Treppenhaus 2027“) oder den Zeitraum passend wählen. Eintrag anklicken für die
        Aufteilung nach Mitarbeitern.
      </p>
    </section>
  );
}
