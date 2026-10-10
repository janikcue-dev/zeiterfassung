import { useEffect, useState } from "react";
import { farbeVon } from "./logik.js";

// Mitarbeiter-Reihenfolge ändern und (nur Wochenübersicht) Mitarbeiter ausblenden.

export default function AnordnungDialog({ mitarbeiter, ausgeblendet, festAusgeblendet, mitAusblenden, onSpeichern, onZuruecksetzen, onSchliessen }) {
  const [liste, setListe] = useState(() => mitarbeiter.map((m) => m.name));
  const [versteckt, setVersteckt] = useState(() => new Set(ausgeblendet));
  const farben = Object.fromEntries(mitarbeiter.map((m) => [m.name, farbeVon(m.farbe)]));
  const fest = new Set(festAusgeblendet);

  useEffect(() => {
    const onKey = (e) => e.key === "Escape" && onSchliessen();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onSchliessen]);

  function verschiebe(i, richtung) {
    const j = i + richtung;
    if (j < 0 || j >= liste.length) return;
    const neu = [...liste];
    [neu[i], neu[j]] = [neu[j], neu[i]];
    setListe(neu);
  }

  function umschalten(name) {
    setVersteckt((v) => {
      const neu = new Set(v);
      if (neu.has(name)) neu.delete(name);
      else neu.add(name);
      return neu;
    });
  }

  return (
    <div className="b-overlay" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && onSchliessen()}>
      <div className="b-dialog b-dialog-schmal" role="dialog" aria-modal="true" aria-labelledby="anordnung-titel">
        <div className="b-ueberzeile">Ansicht</div>
        <h2 id="anordnung-titel">Mitarbeiter anordnen</h2>
        <p className="b-sek klein">
          Gilt für Wochenübersicht und Monatsabschluss auf diesem Gerät.
          {mitAusblenden && " Ausgeblendete Mitarbeiter erscheinen nicht als Spalte in der Wochenübersicht – im Monatsabschluss bleiben sie, sobald sie Stunden haben."}
        </p>

        <ol className="b-anordnung">
          {liste.map((name, i) => {
            const f = farben[name];
            const aus = versteckt.has(name) || fest.has(name);
            return (
              <li key={name} className={aus ? "aus" : ""}>
                <span className="b-anordnung-nr">{i + 1}.</span>
                <span className="b-name-chip" style={{ background: f.bg, color: f.fg }}>{name}</span>
                <span className="b-wachsen" />
                {mitAusblenden && (
                  <label className="b-schalter">
                    <input type="checkbox" checked={!aus} disabled={fest.has(name)} onChange={() => umschalten(name)} />
                    <span>{fest.has(name) ? "fest ausgeblendet" : "anzeigen"}</span>
                  </label>
                )}
                <button className="b-btn b-btn-icon" aria-label={`${name} nach oben`} disabled={i === 0} onClick={() => verschiebe(i, -1)}>↑</button>
                <button className="b-btn b-btn-icon" aria-label={`${name} nach unten`} disabled={i === liste.length - 1} onClick={() => verschiebe(i, 1)}>↓</button>
              </li>
            );
          })}
        </ol>

        <div className="b-dialog-aktionen">
          <button className="b-btn b-btn-leise" onClick={onZuruecksetzen}>Reihenfolge wie in Notion</button>
          <span className="b-wachsen" />
          <button className="b-btn" onClick={onSchliessen}>Abbrechen</button>
          <button className="b-btn b-btn-primaer" onClick={() => onSpeichern(liste, [...versteckt])}>Übernehmen</button>
        </div>
      </div>
    </div>
  );
}
