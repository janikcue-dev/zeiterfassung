import { useEffect, useState } from "react";
import { baustellenFarbe, fmtSaldo, fmtStd, MONATSNAMEN, sollStunden } from "./logik.js";

// Ein Fenster für beides:
//   modus "korrektur" – bestehenden Arbeitstag ändern (Zeiten, Datum verschieben, Projekte ändern/löschen/hinzufügen)
//   modus "neu"       – Tag nachtragen (Normal, Urlaub, Krank, Feiertag, Schule)
// Gespeichert wird nur, wenn die Projektsumme zur Arbeitszeit passt – wie in der Mitarbeiter-App.

const zuMinuten = (hhmm) => {
  if (!/^\d{2}:\d{2}$/.test(hhmm || "")) return null;
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
};
const zuUhrzeit = (min) => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
const zahl = (s) => parseFloat(String(s).replace(",", "."));
const runde2 = (n) => Math.round(n * 100) / 100;
const sauber = (n) => String(n || "").replace(/\s+/g, " ").trim();
const komma = (n) => String(n).replace(".", ",");
const WOCHENTAGE = ["Sonntag", "Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag"];
const datumLang = (d) => {
  const [, m, t] = d.split("-").map(Number);
  return `${WOCHENTAGE[new Date(d + "T12:00:00").getDay()]}, ${t}. ${MONATSNAMEN[m - 1]}`;
};

const ARTEN = [
  { key: "normal", label: "Arbeit" },
  { key: "urlaub", label: "Urlaub" },
  { key: "krank", label: "Krank" },
  { key: "feiertag", label: "Feiertag" },
  { key: "schule", label: "Schule" },
];

// Übliche Zeiten passend zum Soll vorschlagen (Mo–Do 8,5 h, Fr 6 h)
function standardZeiten(datum) {
  const soll = sollStunden(datum);
  if (soll === 6) return { beginn: "07:00", ende: "13:30", pause: "30" };
  return { beginn: "07:00", ende: "16:30", pause: "60" };
}

let zeilenNr = 0;
const neueZeile = (name = "", stunden = "") => ({ key: `neu-${++zeilenNr}`, id: null, name, stunden, loeschen: false, alt: null });

export default function TagDialog({ api, modus, zelle, mitarbeiter, datum: startDatum, onAbbrechen, onGespeichert }) {
  const korrektur = modus === "korrektur";
  const tag = korrektur ? zelle.normal[0] : null;
  const start = korrektur ? { beginn: tag.beginn, ende: tag.ende, pause: String(tag.pause ?? 0) } : standardZeiten(startDatum);

  const [datum, setDatum] = useState(startDatum);
  const [art, setArt] = useState("normal");
  const [beginn, setBeginn] = useState(start.beginn);
  const [ende, setEnde] = useState(start.ende);
  const [pause, setPause] = useState(start.pause);
  const [zeilen, setZeilen] = useState(() =>
    korrektur
      ? zelle.projekte.map((p) => ({ key: p.id, id: p.id, name: p.name, stunden: komma(p.stunden), loeschen: false, alt: p }))
      : [neueZeile()]
  );
  const [vorschlaege, setVorschlaege] = useState([]);
  const [speichert, setSpeichert] = useState(false);
  const [fehler, setFehler] = useState("");

  // Baustellen-Liste für die Namensvorschläge (laufende zuerst, dann Archiv)
  useEffect(() => {
    let aktiv = true;
    api("baustellen")
      .then((d) => aktiv && setVorschlaege([...d.laufend, ...d.archiv].map((b) => b.name)))
      .catch(() => { /* ohne Vorschläge geht's auch */ });
    return () => {
      aktiv = false;
    };
  }, [api]);

  useEffect(() => {
    const onKey = (e) => e.key === "Escape" && !speichert && onAbbrechen();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onAbbrechen, speichert]);

  const istArbeit = korrektur || art === "normal";
  const b = zuMinuten(beginn);
  const e = zuMinuten(ende);
  const p = Number(pause) || 0;
  const netto = b !== null && e !== null && e > b && e - b - p >= 0 ? runde2((e - b - p) / 60) : null;
  const aktiv = zeilen.filter((z) => !z.loeschen);
  const werte = aktiv.map((z) => zahl(z.stunden));
  const werteOk = werte.every((w) => Number.isFinite(w) && w >= 0 && w <= 24);
  const summe = werteOk ? runde2(werte.reduce((a, w) => a + w, 0)) : null;
  const passt = netto !== null && summe !== null && Math.abs(summe - netto) <= 0.01;
  const differenz = netto !== null && summe !== null ? runde2(summe - netto) : null;
  const namenOk = aktiv.every((z) => sauber(z.name).length > 0);
  const soll = sollStunden(datum);
  const datumOk = /^\d{4}-\d{2}-\d{2}$/.test(datum);

  // Vorschlag: Ende so setzen, dass die Arbeitszeit genau der Projektsumme entspricht
  const vorschlagEnde = !passt && b !== null && summe !== null && summe > 0 ? b + p + Math.round(summe * 60) : null;

  const geaendert = !korrektur || datum !== startDatum || beginn !== tag.beginn || ende !== tag.ende || p !== (tag.pause ?? 0) ||
    zeilen.some((z) => !z.id || z.loeschen || sauber(z.name) !== z.alt.name || Math.abs((zahl(z.stunden) || 0) - z.alt.stunden) > 0.001);

  const speicherbar = datumOk && !speichert && geaendert && (!istArbeit || (passt && namenOk && aktiv.length > 0));

  function aendere(key, feld, wert) {
    setZeilen((zs) => zs.map((z) => (z.key === key ? { ...z, [feld]: wert } : z)));
  }
  function entferne(z) {
    if (z.id) aendere(z.key, "loeschen", true);
    else setZeilen((zs) => zs.filter((x) => x.key !== z.key));
  }
  function hinzufuegen() {
    const rest = netto !== null && summe !== null && netto - summe > 0 ? komma(runde2(netto - summe)) : "";
    setZeilen((zs) => [...zs, neueZeile("", rest)]);
  }

  async function speichern() {
    setSpeichert(true);
    setFehler("");
    try {
      const projekte = zeilen
        .filter((z) => z.id || !z.loeschen)
        .map((z) => (z.loeschen ? { id: z.id, loeschen: true } : { id: z.id || undefined, name: sauber(z.name), stunden: zahl(z.stunden) }));
      if (korrektur) {
        await api("korrektur", { arbeitstagId: tag.id, datum, arbeitsbeginn: beginn, arbeitsende: ende, pauseMinuten: p, projekte });
      } else {
        await api("neuerTag", {
          mitarbeiter, datum, art,
          ...(art === "normal" ? { arbeitsbeginn: beginn, arbeitsende: ende, pauseMinuten: p, projekte } : {}),
        });
      }
      onGespeichert(datum);
    } catch (err) {
      setFehler(err.message);
      setSpeichert(false);
    }
  }

  const SONDER_TEXT = {
    urlaub: "Der Tag wird als Urlaub eingetragen (0 h, keine Minusstunden).",
    krank: `Der Tag wird als Krankheit mit ${fmtStd(soll)} h eingetragen.`,
    feiertag: `Der Tag wird als Feiertag mit ${fmtStd(soll)} h eingetragen.`,
    schule: "Der Tag wird als Schultag eingetragen (für Azubis).",
  };

  return (
    <div className="b-overlay" role="presentation" onMouseDown={(ev) => ev.target === ev.currentTarget && !speichert && onAbbrechen()}>
      <div className="b-dialog" role="dialog" aria-modal="true" aria-labelledby="tag-titel">
        <div className="b-ueberzeile">{korrektur ? "Korrektur" : "Tag eintragen"}</div>
        <h2 id="tag-titel">{mitarbeiter}</h2>

        <div className="t-datumzeile">
          <label className="b-feld">
            <span>Datum</span>
            <input type="date" value={datum} onChange={(ev) => setDatum(ev.target.value)} />
          </label>
          <span className="t-datum-text">
            {datumOk && datumLang(datum)}
            {korrektur && datumOk && datum !== startDatum && <b className="t-verschieben"> · wird von {datumLang(startDatum)} hierher verschoben</b>}
          </span>
        </div>

        {!korrektur && (
          <div className="t-arten" role="tablist" aria-label="Art des Tages">
            {ARTEN.map((a) => (
              <button key={a.key} role="tab" aria-selected={art === a.key} className={art === a.key ? "an" : ""} onClick={() => setArt(a.key)}>
                {a.label}
              </button>
            ))}
          </div>
        )}

        {!istArbeit && <p className="t-sonder">{SONDER_TEXT[art]}</p>}

        {istArbeit && (
          <div className="b-dialog-spalten">
            <div className="b-block">
              <h3>Arbeitszeit</h3>
              <div className="b-feldgitter">
                <label className="b-feld"><span>Beginn</span><input type="time" value={beginn} onChange={(ev) => setBeginn(ev.target.value)} /></label>
                <label className="b-feld"><span>Ende</span><input type="time" value={ende} onChange={(ev) => setEnde(ev.target.value)} /></label>
                <label className="b-feld"><span>Pause (min)</span><input type="number" min="0" max="600" step="5" value={pause} onChange={(ev) => setPause(ev.target.value)} /></label>
                <div className="b-feld">
                  <span>Arbeitszeit</span>
                  <div className="b-wertfeld b-zahl">{netto !== null ? `${fmtStd(netto)} h` : "–"}</div>
                </div>
              </div>
              <p className="b-sek klein">
                Soll an diesem Tag: {fmtStd(soll)} h
                {netto !== null && <> · Saldo danach <b>{fmtSaldo(netto - soll)}</b></>}
              </p>
            </div>

            <div className="b-block">
              <h3>Baustellen</h3>
              {zeilen.map((z, i) => {
                const umbenannt = z.alt && !z.loeschen && sauber(z.name) !== z.alt.name;
                return (
                  <div key={z.key} className={`b-projektzeile${umbenannt ? " geaendert" : ""}${z.loeschen ? " geloescht" : ""}${!z.id ? " neu" : ""}`}>
                    <span className="b-quadrat" style={{ background: baustellenFarbe(z.name) }} />
                    <input
                      className="b-projekt-eingabe"
                      type="text"
                      list="tag-baustellen"
                      placeholder="Baustelle"
                      aria-label={`Projekt ${i + 1}`}
                      value={z.name}
                      disabled={z.loeschen}
                      onChange={(ev) => aendere(z.key, "name", ev.target.value)}
                    />
                    <input
                      type="text"
                      inputMode="decimal"
                      aria-label={`Stunden Projekt ${i + 1}`}
                      value={z.stunden}
                      disabled={z.loeschen}
                      onChange={(ev) => aendere(z.key, "stunden", ev.target.value)}
                    />
                    <span className="b-sek">h</span>
                    {z.loeschen ? (
                      <button className="t-mini" onClick={() => aendere(z.key, "loeschen", false)}>Rückgängig</button>
                    ) : (
                      <button className="t-mini t-weg" aria-label={`Projekt ${i + 1} löschen`} title="Projekt löschen" onClick={() => entferne(z)}>×</button>
                    )}
                    {(umbenannt || z.loeschen || z.alt?.notiz) && (
                      <span className="b-projektzeile-info b-sek klein">
                        {z.loeschen ? "wird gelöscht" : umbenannt ? <>vorher: {z.alt.name}</> : null}
                        {z.alt?.notiz && <>{(umbenannt || z.loeschen) && " · "}Notiz: {z.alt.notiz}</>}
                      </span>
                    )}
                  </div>
                );
              })}
              <button className="t-hinzu" onClick={hinzufuegen}>+ Baustelle hinzufügen</button>
              <datalist id="tag-baustellen">
                {vorschlaege.map((n) => <option key={n} value={n} />)}
              </datalist>
            </div>
          </div>
        )}

        {istArbeit && (
          <div className={`b-pruefbox ${passt ? "ok" : "warnung"}`}>
            <div className="b-pruefbox-zeile b-zahl">
              <span>Projektsumme <b>{summe !== null ? `${fmtStd(summe)} h` : "–"}</b></span>
              <span>Arbeitszeit <b>{netto !== null ? `${fmtStd(netto)} h` : "–"}</b></span>
              {!passt && differenz !== null && <b>Differenz {fmtSaldo(differenz)} h</b>}
              {passt && <b>Passt</b>}
            </div>
            {!passt && (
              <>
                <p className="klein">Speichern geht erst, wenn beide Summen gleich sind.</p>
                {vorschlagEnde !== null && vorschlagEnde < 24 * 60 && (
                  <button className="b-btn" onClick={() => setEnde(zuUhrzeit(vorschlagEnde))}>Ende auf {zuUhrzeit(vorschlagEnde)} setzen</button>
                )}
              </>
            )}
            {aktiv.length === 0 && <p className="klein">Mindestens eine Baustelle muss bleiben – sonst im Detailfenster den ganzen Tag löschen.</p>}
          </div>
        )}

        {fehler && <div className="b-fehler">{fehler}</div>}

        <div className="b-dialog-aktionen">
          <button className="b-btn" onClick={onAbbrechen} disabled={speichert}>Abbrechen</button>
          <button className="b-btn b-btn-primaer" onClick={speichern} disabled={!speicherbar}>
            {speichert ? "Speichert…" : korrektur ? "Speichern & nach Notion" : "Eintragen"}
          </button>
        </div>
      </div>
    </div>
  );
}
