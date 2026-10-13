import { useMemo, useState } from "react";
import { useDaten } from "./api.js";
import { fuehreZusammen, useAnordnung, useZiehen, verschiebe } from "./anordnung.js";
import Griff from "./Griff.jsx";
import { alleMitarbeiter, baueMonat, baustellenFarbe, farbeVon, fmtStd, heuteStr, monatAlsCsv, monatsGrenzen, MONATSNAMEN } from "./logik.js";

// Monatsabschluss – jeder Monat steht für sich:
// Minusstunden werden mit Überstunden desselben Monats aufgefüllt, nichts wird übertragen.

// Zuletzt angesehenen Monat merken (bis der Browser geschlossen wird), sonst Vormonat
const MONAT_KEY = "buero_monat";
function startMonat() {
  try {
    const m = JSON.parse(sessionStorage.getItem(MONAT_KEY) || "null");
    if (m && Number.isInteger(m.jahr) && Number.isInteger(m.monat)) return m;
  } catch {
    /* ignorieren */
  }
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() - 1);
  return { jahr: d.getFullYear(), monat: d.getMonth() };
}

function Std({ wert, betont }) {
  return <span className={`b-zahl${betont ? " b-fett" : ""}`}>{fmtStd(wert)}</span>;
}

// Plus-Werte grün mit "+", Minus-Werte mit "−" wie in der Wochenübersicht; 0 grau ohne Vorzeichen
function Vorzeichen({ wert, art, betont }) {
  if (!wert || Math.abs(wert) < 0.005) return <span className="b-zahl b-sek">0</span>;
  return (
    <span className={`b-zahl ${art === "plus" ? "b-saldo-plus" : "b-saldo-minus"}${betont ? " b-fett" : ""}`}>
      {art === "plus" ? "+" : "−"}{fmtStd(Math.abs(wert))}
    </span>
  );
}

const JAHRE = (() => {
  const jetzt = new Date().getFullYear();
  return Array.from({ length: 5 }, (_, i) => jetzt - 3 + i);
})();

function Abwesenheit({ r }) {
  const teile = [];
  if (r.urlaub) teile.push(`${r.urlaub} Urlaub`);
  if (r.krankTage) teile.push(`${r.krankTage} krank (${fmtStd(r.krankStunden)} h)`);
  if (r.feiertag) teile.push(`${r.feiertag} Feiertag`);
  if (r.schule) teile.push(`${r.schule} Schule`);
  return teile.length ? <span className="klein">{teile.join(" · ")}</span> : <span className="b-sek">–</span>;
}

function Pruefung({ r }) {
  const punkte = [];
  if (r.tageMitWarnung) punkte.push(`${r.tageMitWarnung} ${r.tageMitWarnung === 1 ? "Tag" : "Tage"} mit Hinweis`);
  if (r.fehlendeTage) punkte.push(`${r.fehlendeTage} ohne Eintrag`);
  if (r.summenAbweichung) punkte.push(`Projekte ≠ Arbeitstage (${fmtStd(r.summenAbweichung)} h)`);
  // Ein Punkt statt Chip-Stapel: grün = stimmig, orange = hinschauen (Details beim Darüberfahren)
  return (
    <span className="m-pruefung" title={punkte.join(" · ") || "Alles stimmig"}>
      <span className={`w-dot ${punkte.length ? "orange" : "gruen"}`} />
      <span className="m-pruefung-text">{punkte.length ? punkte[0] + (punkte.length > 1 ? ` +${punkte.length - 1}` : "") : "stimmig"}</span>
    </span>
  );
}

export default function Monatsabschluss({ api }) {
  const [auswahl, setAuswahlRoh] = useState(startMonat);
  const setAuswahl = (wert) =>
    setAuswahlRoh((alt) => {
      const neu = typeof wert === "function" ? wert(alt) : wert;
      try {
        sessionStorage.setItem(MONAT_KEY, JSON.stringify(neu));
      } catch {
        /* ignorieren */
      }
      return neu;
    });
  const anordnung = useAnordnung();
  const { von, bis } = monatsGrenzen(auswahl.jahr, auswahl.monat);
  const { daten, fehler, laedt, neuLaden } = useDaten(api, von, bis);
  const titel = `${MONATSNAMEN[auswahl.monat]} ${auswahl.jahr}`;

  const monat = useMemo(
    () => (daten ? baueMonat(daten, auswahl.jahr, auswahl.monat, heuteStr(), { reihenfolge: anordnung.reihenfolge }) : null),
    [daten, auswahl, anordnung.reihenfolge]
  );

  function blaettern(n) {
    setAuswahl(({ jahr, monat: m }) => {
      const d = new Date(jahr, m + n, 1, 12);
      return { jahr: d.getFullYear(), monat: d.getMonth() };
    });
  }

  function csvLaden() {
    const blob = new Blob([monatAlsCsv(monat, titel)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `Monatsabschluss_${auswahl.jahr}-${String(auswahl.monat + 1).padStart(2, "0")}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  const sichtbar = monat ? monat.zeilen.map((r) => r.mitarbeiter.name) : [];
  const ziehen = useZiehen("y", sichtbar, (name, ziel, nachher) => {
    const alle = alleMitarbeiter(daten, anordnung.reihenfolge).map((m) => m.name);
    anordnung.speichere({
      reihenfolge: fuehreZusammen(anordnung.reihenfolge, verschiebe(alle, name, ziel, nachher)),
      ausgeblendet: anordnung.eigeneAusgeblendet,
    });
  });

  const offen = monat ? monat.zeilen.filter((r) => r.tageMitWarnung || r.fehlendeTage || r.summenAbweichung).length : 0;
  const maxBaustelle = monat?.baustellen[0]?.stunden || 1;

  return (
    <section className="b-seite">
      <div className="w-kopf">
        <div>
          <div className="w-kw">Monatsabschluss</div>
          <h1 className="w-titel">{titel}</h1>
        </div>
        <div className="w-steuerung nicht-drucken">
          <button className="w-rund" aria-label="Vorheriger Monat" onClick={() => blaettern(-1)}>‹</button>
          <select
            className="w-select"
            aria-label="Monat"
            value={auswahl.monat}
            onChange={(e) => setAuswahl((a) => ({ ...a, monat: Number(e.target.value) }))}
          >
            {MONATSNAMEN.map((n, i) => <option key={n} value={i}>{n}</option>)}
          </select>
          <select
            className="w-select"
            aria-label="Jahr"
            value={auswahl.jahr}
            onChange={(e) => setAuswahl((a) => ({ ...a, jahr: Number(e.target.value) }))}
          >
            {[...new Set([...JAHRE, auswahl.jahr])].sort().map((j) => <option key={j} value={j}>{j}</option>)}
          </select>
          <button className="w-rund" aria-label="Nächster Monat" onClick={() => blaettern(1)}>›</button>
          <button className="w-rund" aria-label="Aktualisieren" title="Aktualisieren" onClick={neuLaden} disabled={laedt}>
            <span className={laedt ? "w-dreht" : ""}>↻</span>
          </button>
          <button className="w-textknopf" onClick={csvLaden} disabled={!monat}>CSV</button>
          <button className="w-textknopf" onClick={() => window.print()} disabled={!monat}>Drucken</button>
        </div>
      </div>

      {fehler && <div className="b-fehler">{fehler}</div>}
      {!monat && !fehler && <div className="b-laden">Daten werden aus Notion geladen…</div>}

      {monat && monat.zeilen.length > 0 && (
        <div className="w-hinweis nicht-drucken">
          <span className={`w-dot ${offen ? "orange" : "gruen"}`} />
          <span>{offen ? `Bei ${offen} ${offen === 1 ? "Mitarbeiter" : "Mitarbeitern"} vor dem Abschluss noch hinschauen` : "Alles stimmig – bereit zum Abschluss"}</span>
        </div>
      )}

      {monat && (
        <>
          <div className={`b-tabelle-scroll${laedt ? " laedt" : ""}`}>
            <table className="b-tabelle">
              <thead>
                <tr>
                  <th>Mitarbeiter</th>
                  <th className="r">Gesamt<br />Baustellen</th>
                  <th className="r">Überstunden<br />brutto</th>
                  <th className="r">Minus-<br />stunden</th>
                  <th className="r">In regulärer<br />Zeit</th>
                  <th className="r">Regulär nach<br />Auffüllen</th>
                  <th className="r m-hervor">Verbleibende<br />Plusstunden</th>
                  <th>Abwesenheit (Tage)</th>
                  <th className="nicht-drucken">Prüfung</th>
                </tr>
              </thead>
              <tbody>
                {monat.zeilen.length === 0 && (
                  <tr><td colSpan={9} className="b-sek">Für diesen Monat gibt es noch keine Einträge.</td></tr>
                )}
                {monat.zeilen.map((r) => {
                  const f = farbeVon(r.mitarbeiter.farbe);
                  return (
                    <tr key={r.mitarbeiter.name} className={`b-ziehzeile${ziehen.klasse(r.mitarbeiter.name)}`} {...ziehen.props(r.mitarbeiter.name)}>
                      <td>
                        <span className="b-zeilengriff nicht-drucken"><Griff /></span>
                        <span className="m-name" style={{ background: `${f.akzent}1f`, color: f.fg }}>{r.mitarbeiter.name}</span>
                      </td>
                      <td className="r"><Std wert={r.gesamt} betont /></td>
                      <td className="r"><Vorzeichen wert={r.ueberBrutto} art="plus" /></td>
                      <td className="r"><Vorzeichen wert={r.minus} art="minus" /></td>
                      <td className="r"><Std wert={r.inRegulaer} /></td>
                      <td className="r"><Std wert={r.regulaerNachAuffuellen} /></td>
                      <td className="r m-hervor">
                        <Vorzeichen wert={r.verbleibendPlus} art="plus" betont />
                        {r.nichtAusgeglichen > 0 && (
                          <div className="b-saldo-minus klein">−{fmtStd(r.nichtAusgeglichen)} nicht ausgeglichen</div>
                        )}
                      </td>
                      <td><Abwesenheit r={r} /></td>
                      <td className="nicht-drucken"><Pruefung r={r} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <p className="b-legende b-sek">
            Alle Werte in Stunden. In regulärer Zeit = Gesamt − Überstunden brutto. Minusstunden werden aus den
            Überstunden desselben Monats aufgefüllt; übrig bleiben die verbleibenden Plusstunden. Kein Übertrag in den Folgemonat.
            Reihenfolge ändern: Zeile festhalten und nach oben oder unten ziehen.
          </p>

          {monat.baustellen.length > 0 && (
            <div className="b-karte">
              <h2>Stunden pro Baustelle</h2>
              <div className="b-balkenliste">
                {monat.baustellen.map((b) => (
                  <div key={b.name} className="b-balken">
                    <div className="b-balken-kopf">
                      <span className="b-balken-name">
                        <span className="b-quadrat" style={{ background: baustellenFarbe(b.name) }} />
                        {b.name}
                      </span>
                      <span className="b-zahl b-fett">{fmtStd(b.stunden)} h</span>
                    </div>
                    <div className="b-balken-spur">
                      <div className="b-balken-fuell" style={{ width: `${Math.max((b.stunden / maxBaustelle) * 100, 2)}%`, background: baustellenFarbe(b.name) }} />
                    </div>
                    <div className="b-sek klein">{b.mitarbeiter.join(", ")}</div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </section>
  );
}
