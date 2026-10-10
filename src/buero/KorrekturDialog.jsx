import { useEffect, useState } from "react";
import { baustellenFarbe, datumKurz, fmtSaldo, fmtStd, sollStunden, WOCHENTAGE_KURZ } from "./logik.js";

// Korrektur eines Arbeitstags: Uhrzeiten + Projektstunden werden gemeinsam geändert.
// Gespeichert wird nur, wenn die Projektsumme zur Arbeitszeit passt – wie in der Mitarbeiter-App.

const zuMinuten = (hhmm) => {
  if (!/^\d{2}:\d{2}$/.test(hhmm || "")) return null;
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
};
const zuUhrzeit = (min) => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
const zahl = (s) => parseFloat(String(s).replace(",", "."));
const runde2 = (n) => Math.round(n * 100) / 100;

export default function KorrekturDialog({ api, zelle, mitarbeiter, datum, onAbbrechen, onGespeichert }) {
  const tag = zelle.normal[0];
  const [beginn, setBeginn] = useState(tag.beginn);
  const [ende, setEnde] = useState(tag.ende);
  const [pause, setPause] = useState(String(tag.pause ?? 0));
  const [stunden, setStunden] = useState(() => Object.fromEntries(zelle.projekte.map((p) => [p.id, String(p.stunden).replace(".", ",")])));
  const [speichert, setSpeichert] = useState(false);
  const [fehler, setFehler] = useState("");

  useEffect(() => {
    const onKey = (e) => e.key === "Escape" && !speichert && onAbbrechen();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onAbbrechen, speichert]);

  const b = zuMinuten(beginn);
  const e = zuMinuten(ende);
  const p = Number(pause) || 0;
  const netto = b !== null && e !== null && e > b && e - b - p >= 0 ? runde2((e - b - p) / 60) : null;
  const werte = zelle.projekte.map((pr) => zahl(stunden[pr.id]));
  const werteOk = werte.every((w) => Number.isFinite(w) && w >= 0 && w <= 24);
  const summe = werteOk ? runde2(werte.reduce((a, w) => a + w, 0)) : null;
  const passt = netto !== null && summe !== null && Math.abs(summe - netto) <= 0.01;
  const differenz = netto !== null && summe !== null ? runde2(summe - netto) : null;
  const soll = sollStunden(datum);

  // Vorschlag: Ende so setzen, dass die Arbeitszeit genau der Projektsumme entspricht
  const vorschlagEnde = !passt && b !== null && summe !== null && summe > 0 ? b + p + Math.round(summe * 60) : null;
  const geaendert =
    beginn !== tag.beginn || ende !== tag.ende || p !== (tag.pause ?? 0) ||
    zelle.projekte.some((pr, i) => Math.abs((werte[i] || 0) - pr.stunden) > 0.001);

  async function speichern() {
    setSpeichert(true);
    setFehler("");
    try {
      await api("korrektur", {
        arbeitstagId: tag.id,
        arbeitsbeginn: beginn,
        arbeitsende: ende,
        pauseMinuten: p,
        projekte: zelle.projekte.map((pr, i) => ({ id: pr.id, stunden: werte[i] })),
      });
      onGespeichert();
    } catch (err) {
      setFehler(err.message);
      setSpeichert(false);
    }
  }

  const wt = WOCHENTAGE_KURZ[new Date(datum + "T12:00:00").getDay()];

  return (
    <div className="b-overlay" role="presentation" onMouseDown={(ev) => ev.target === ev.currentTarget && !speichert && onAbbrechen()}>
      <div className="b-dialog" role="dialog" aria-modal="true" aria-labelledby="korrektur-titel">
        <div className="b-ueberzeile">Korrektur</div>
        <h2 id="korrektur-titel">{mitarbeiter} · {wt}, {datumKurz(datum)}{datum.slice(0, 4)}</h2>

        <div className="b-dialog-spalten">
          <div className="b-block">
            <h3>Arbeitstag</h3>
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
            <h3>Projektstunden</h3>
            {zelle.projekte.map((pr) => (
              <label key={pr.id} className="b-projektzeile">
                <span className="b-quadrat" style={{ background: baustellenFarbe(pr.name) }} />
                <span className="b-projekt-name">{pr.name}{pr.notiz ? <span className="b-sek klein"> – {pr.notiz}</span> : null}</span>
                <input
                  type="text"
                  inputMode="decimal"
                  aria-label={`Stunden ${pr.name}`}
                  value={stunden[pr.id]}
                  onChange={(ev) => setStunden((s) => ({ ...s, [pr.id]: ev.target.value }))}
                />
                <span className="b-sek">h</span>
              </label>
            ))}
            <p className="b-sek klein">Neue Projekte oder andere Baustellen bitte weiterhin in Notion ergänzen.</p>
          </div>
        </div>

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
                <button className="b-btn" onClick={() => setEnde(zuUhrzeit(vorschlagEnde))}>
                  Ende auf {zuUhrzeit(vorschlagEnde)} setzen
                </button>
              )}
            </>
          )}
        </div>

        {fehler && <div className="b-fehler">{fehler}</div>}

        <div className="b-dialog-aktionen">
          <button className="b-btn" onClick={onAbbrechen} disabled={speichert}>Abbrechen</button>
          <button className="b-btn b-btn-primaer" onClick={speichern} disabled={!passt || !geaendert || speichert}>
            {speichert ? "Speichert…" : "Speichern & nach Notion"}
          </button>
        </div>
      </div>
    </div>
  );
}
