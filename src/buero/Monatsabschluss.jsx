import { useMemo, useState } from "react";
import { useDaten } from "./api.js";
import { baueMonat, baustellenFarbe, farbeVon, fmtStd, heuteStr, monatAlsCsv, monatsGrenzen, MONATSNAMEN } from "./logik.js";

// Monatsabschluss – jeder Monat steht für sich:
// Minusstunden werden mit Überstunden desselben Monats aufgefüllt, nichts wird übertragen.

function vormonat() {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() - 1);
  return { jahr: d.getFullYear(), monat: d.getMonth() };
}

function Std({ wert, betont }) {
  return <span className={`b-zahl${betont ? " b-fett" : ""}`}>{fmtStd(wert)}</span>;
}

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
  if (!punkte.length) return <span className="b-chip ok">Stimmig</span>;
  return (
    <div className="b-chipspalte">
      {punkte.map((p) => <span key={p} className="b-chip warnung">{p}</span>)}
    </div>
  );
}

export default function Monatsabschluss({ api }) {
  const [auswahl, setAuswahl] = useState(vormonat);
  const { von, bis } = monatsGrenzen(auswahl.jahr, auswahl.monat);
  const { daten, fehler, laedt, neuLaden } = useDaten(api, von, bis);
  const titel = `${MONATSNAMEN[auswahl.monat]} ${auswahl.jahr}`;

  const monat = useMemo(() => (daten ? baueMonat(daten, auswahl.jahr, auswahl.monat, heuteStr()) : null), [daten, auswahl]);

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

  const offen = monat ? monat.zeilen.filter((r) => r.tageMitWarnung || r.fehlendeTage || r.summenAbweichung).length : 0;
  const maxBaustelle = monat?.baustellen[0]?.stunden || 1;

  return (
    <section className="b-seite">
      <div className="b-kopf">
        <div>
          <div className="b-ueberzeile">Monatsabschluss</div>
          <h1>{titel}</h1>
        </div>
        <div className="b-knopfreihe nicht-drucken">
          <button className="b-btn b-btn-icon" aria-label="Vorheriger Monat" onClick={() => blaettern(-1)}>‹</button>
          <button className="b-btn b-btn-icon" aria-label="Nächster Monat" onClick={() => blaettern(1)}>›</button>
          <button className="b-btn" onClick={neuLaden} disabled={laedt}>{laedt ? "Lädt…" : "↻ Aktualisieren"}</button>
          <button className="b-btn" onClick={csvLaden} disabled={!monat}>CSV (Excel)</button>
          <button className="b-btn b-btn-primaer" onClick={() => window.print()} disabled={!monat}>Drucken / PDF</button>
        </div>
      </div>

      {fehler && <div className="b-fehler">{fehler}</div>}
      {!monat && !fehler && <div className="b-laden">Daten werden aus Notion geladen…</div>}

      {monat && offen > 0 && (
        <div className="b-banner warnung">
          <b>Bei {offen} {offen === 1 ? "Mitarbeiter" : "Mitarbeitern"} gibt es offene Punkte</b> – vor dem Abschluss in der Wochenübersicht prüfen.
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
                  <th className="r">Verbleibende<br />Plusstunden</th>
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
                    <tr key={r.mitarbeiter.name}>
                      <td>
                        <span className="b-name-chip" style={{ background: f.bg, color: f.fg }}>{r.mitarbeiter.name}</span>
                      </td>
                      <td className="r"><Std wert={r.gesamt} betont /></td>
                      <td className="r"><Std wert={r.ueberBrutto} /></td>
                      <td className="r">{r.minus ? <Std wert={r.minus} /> : <span className="b-sek">0</span>}</td>
                      <td className="r"><Std wert={r.inRegulaer} /></td>
                      <td className="r"><Std wert={r.regulaerNachAuffuellen} /></td>
                      <td className="r">
                        <span className={`b-zahl b-fett ${r.verbleibendPlus > 0 ? "b-saldo-plus" : ""}`}>
                          {r.verbleibendPlus > 0 ? "+" : ""}{fmtStd(r.verbleibendPlus)}
                        </span>
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
