import { useEffect, useMemo, useState } from "react";
import { useDaten } from "./api.js";
import {
  addTage, baueWoche, baustellenFarbe, farbeVon, fmtSaldo, fmtStd, heuteStr,
  kalenderwoche, MONATSNAMEN, montagVon, normName, WOCHENTAGE_KURZ,
} from "./logik.js";
import { AUSGEBLENDETE_MITARBEITER } from "./einstellungen.js";
import { fuehreZusammen, useAnordnung, useZiehen, verschiebe } from "./anordnung.js";
import KorrekturDialog from "./KorrekturDialog.jsx";

// Wochenübersicht – reduziertes Design:
// jeder Mitarbeiter hat eine zarte farbige Bahn, die Kacheln liegen weiß darauf.
// Farbe nur dort, wo sie etwas bedeutet: Bahn = Person, Punkt = Baustelle, Orange = hinschauen.

const WOCHENTAGE_LANG = ["Sonntag", "Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag"];

function titelWoche(montag, sonntag) {
  const [, m1, t1] = montag.split("-").map(Number);
  const [, m2, t2] = sonntag.split("-").map(Number);
  return m1 === m2 ? `${t1}. – ${t2}. ${MONATSNAMEN[m2 - 1]}` : `${t1}. ${MONATSNAMEN[m1 - 1]} – ${t2}. ${MONATSNAMEN[m2 - 1]}`;
}

function Saldo({ wert, gross }) {
  if (Math.abs(wert || 0) < 0.005) return null;
  return <span className={`w-saldo ${wert > 0 ? "plus" : "minus"}${gross ? " gross" : ""}`}>{fmtSaldo(wert)}</span>;
}

const bahnStil = (f) => ({ "--bahn": `${f.akzent}17`, "--bahn-text": f.fg });

function zeitText(tag) {
  if (!tag.beginn || !tag.ende) return "ohne Uhrzeit";
  return `${tag.beginn}–${tag.ende}${tag.pause !== null ? ` · ${tag.pause}′` : ""}`;
}

function sonderText(s) {
  return s.gesamt > 0 && s.status !== "Urlaub" ? `${s.status} · ${fmtStd(s.gesamt)} h` : s.status;
}

function Kachel({ z, onOeffnen, aktiv }) {
  if (z.leer) {
    return <div className={`w-kachel leer${z.fehlt ? " fehlt" : ""}`}>{z.fehlt ? "fehlt" : ""}</div>;
  }

  const nurSonder = z.normal.length === 0 && z.projekte.length === 0;
  const klassen = ["w-kachel", nurSonder && "sonder", z.warnungen.length && "warnung", aktiv && "aktiv"].filter(Boolean).join(" ");

  return (
    <button className={klassen} onClick={onOeffnen}>
      {nurSonder ? (
        z.sonder.map((s) => <span key={s.id} className="w-sonder-wort">{sonderText(s)}</span>)
      ) : (
        <>
          {z.normal.length > 0 && <span className="w-zeit">{zeitText(z.normal[0])}</span>}
          {z.sonder.map((s) => <span key={s.id} className="w-zeit">{sonderText(s)}</span>)}
          <span className="w-projekte">
            {z.projekte.map((p) => (
              <span key={p.id} className="w-projekt">
                <span className="w-punkt" style={{ background: baustellenFarbe(p.name) }} />
                <span className="w-projekt-name">{p.name || "(ohne Namen)"}</span>
                <span className={`w-std${z.abweichendeBaustellen.has(normName(p.name)) ? " abweichend" : ""}`}>{fmtStd(p.stunden)}</span>
              </span>
            ))}
          </span>
          {z.normal.length > 0 && (
            <span className="w-summe">
              <span className="w-summe-zahl">{fmtStd(z.gearbeitet)}</span>
              <Saldo wert={z.saldo} />
            </span>
          )}
        </>
      )}
    </button>
  );
}

// Seitenfenster mit Details zu einer Kachel – hier liegen die Aktionen
function Detail({ auswahl, onSchliessen, onKorrektur }) {
  const { z, mitarbeiter, datum } = auswahl;
  const tag = z.normal[0];
  const notionLinks = [
    ...z.normal.map((a) => ({ url: a.url, text: "Arbeitstag in Notion" })),
    ...z.sonder.map((a) => ({ url: a.url, text: `${a.status} in Notion` })),
  ];

  useEffect(() => {
    const onKey = (e) => e.key === "Escape" && onSchliessen();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onSchliessen]);

  const wt = WOCHENTAGE_LANG[new Date(datum + "T12:00:00").getDay()];
  const [, m, t] = datum.split("-").map(Number);

  let grund = "";
  if (!z.korrigierbar && z.normal.length > 1) grund = "Für diesen Tag gibt es zwei Arbeitstag-Einträge – bitte zuerst in Notion bereinigen.";
  else if (!z.korrigierbar && tag && !tag.beginn) grund = "Teilweise krank: diesen Tag bitte direkt in Notion korrigieren.";
  else if (!z.korrigierbar && z.projekte.length === 0 && tag) grund = "Keine Projekte eingetragen – bitte in Notion ergänzen.";

  return (
    <>
      <div className="w-schleier" onClick={onSchliessen} />
      <aside className="w-detail" role="dialog" aria-modal="true" aria-labelledby="w-detail-titel">
        <div className="w-detail-kopf">
          <div>
            <div className="w-detail-datum">{wt}, {t}. {MONATSNAMEN[m - 1]}</div>
            <h2 id="w-detail-titel">{mitarbeiter}</h2>
          </div>
          <button className="w-rund" onClick={onSchliessen} aria-label="Schließen">×</button>
        </div>

        {z.warnungen.length > 0 && (
          <ul className="w-detail-hinweise">
            {z.warnungen.map((w, i) => <li key={i}><span className="w-dot orange" />{w.text}</li>)}
          </ul>
        )}

        {tag && (
          <div className="w-detail-block">
            <span className="w-label">Arbeitszeit</span>
            <span className="w-detail-wert">
              {zeitText(tag)} · {fmtStd(z.gearbeitet)} h <Saldo wert={z.saldo} />
            </span>
          </div>
        )}
        {z.sonder.length > 0 && (
          <div className="w-detail-block">
            <span className="w-label">Abwesenheit</span>
            {z.sonder.map((s) => <span key={s.id} className="w-detail-wert">{sonderText(s)}</span>)}
          </div>
        )}
        {z.projekte.length > 0 && (
          <div className="w-detail-block">
            <span className="w-label">Baustellen</span>
            {z.projekte.map((p) => (
              <div key={p.id} className="w-detail-projekt">
                <span className="w-punkt" style={{ background: baustellenFarbe(p.name) }} />
                <span className="w-projekt-name">
                  {p.name}
                  {p.notiz && <span className="w-notiz">{p.notiz}</span>}
                </span>
                <span className={`w-std${z.abweichendeBaustellen.has(normName(p.name)) ? " abweichend" : ""}`}>{fmtStd(p.stunden)} h</span>
              </div>
            ))}
          </div>
        )}

        <div className="w-detail-aktionen">
          {grund && <p className="w-grund">{grund}</p>}
          {z.korrigierbar && <button className="w-haupt" onClick={onKorrektur}>Korrigieren</button>}
          {notionLinks.map((l) => (
            <a key={l.url} className="w-link" href={l.url} target="_blank" rel="noreferrer">{l.text} öffnen</a>
          ))}
        </div>
      </aside>
    </>
  );
}

export default function Wochenuebersicht({ api }) {
  const [montag, setMontag] = useState(() => montagVon(heuteStr()));
  const [auswahl, setAuswahl] = useState(null);
  const [korrektur, setKorrektur] = useState(null);
  const anordnung = useAnordnung();
  const sonntag = addTage(montag, 6);
  const { daten, fehler, laedt, neuLaden } = useDaten(api, montag, sonntag);

  const woche = useMemo(
    () => (daten
      ? baueWoche(daten, montag, heuteStr(), {
        // gesperrte (gekündigte) Mitarbeiter automatisch ausblenden
        ausgeblendet: [...anordnung.ausgeblendet, ...(daten.gesperrt || [])],
        reihenfolge: anordnung.reihenfolge,
      })
      : null),
    [daten, montag, anordnung.ausgeblendet, anordnung.reihenfolge]
  );

  const spalten = woche ? woche.mitarbeiter.length : 0;
  const sichtbar = woche ? woche.mitarbeiter.map((m) => m.name) : [];
  const fest = new Set(AUSGEBLENDETE_MITARBEITER);

  function speichere(reihenfolge, ausgeblendet) {
    anordnung.speichere({ reihenfolge, ausgeblendet });
  }
  const ziehen = useZiehen("x", sichtbar, (name, ziel, nachher) => {
    const alle = woche.alle.map((m) => m.name);
    speichere(fuehreZusammen(anordnung.reihenfolge, verschiebe(alle, name, ziel, nachher)), anordnung.eigeneAusgeblendet);
  });
  const ausblenden = (name) => speichere(anordnung.reihenfolge, [...anordnung.eigeneAusgeblendet, name]);
  const einblenden = (name) => speichere(anordnung.reihenfolge, anordnung.eigeneAusgeblendet.filter((n) => n !== name));

  // Ein Satz statt Chip-Leiste
  let hinweis = null;
  if (woche) {
    const teile = [];
    if (woche.warnungen) teile.push(`${woche.warnungen} ${woche.warnungen === 1 ? "Tag braucht" : "Tage brauchen"} deinen Blick`);
    if (woche.fehlend) teile.push(`${woche.fehlend} ${woche.fehlend === 1 ? "Eintrag fehlt" : "Einträge fehlen"}`);
    if (woche.ausgeblendetMitEintrag.length) teile.push(`ausgeblendet, aber mit Einträgen: ${woche.ausgeblendetMitEintrag.join(", ")}`);
    hinweis = { ok: teile.length === 0, text: teile.length ? teile.join(" · ") : "Alles stimmig" };
  }

  return (
    <section className="b-seite w-seite">
      <div className="w-kopf">
        <div>
          <div className="w-kw">KW {kalenderwoche(montag)} · {sonntag.slice(0, 4)}</div>
          <h1 className="w-titel">{titelWoche(montag, sonntag)}</h1>
        </div>
        <div className="w-steuerung">
          <button className="w-rund" aria-label="Vorherige Woche" onClick={() => setMontag(addTage(montag, -7))}>‹</button>
          <button className="w-textknopf" onClick={() => setMontag(montagVon(heuteStr()))}>Heute</button>
          <button className="w-rund" aria-label="Nächste Woche" onClick={() => setMontag(addTage(montag, 7))}>›</button>
          <label className="w-datum" title="Zu einer Woche springen">
            <span className="b-unsichtbar">Zu einer Woche springen</span>
            <input type="date" value={montag} onChange={(e) => e.target.value && setMontag(montagVon(e.target.value))} />
          </label>
          <button className="w-rund" aria-label="Aktualisieren" title="Aktualisieren" onClick={neuLaden} disabled={laedt}>
            <span className={laedt ? "w-dreht" : ""}>↻</span>
          </button>
        </div>
      </div>

      {fehler && <div className="b-fehler">{fehler}</div>}

      {hinweis && (
        <div className="w-hinweis">
          <span className={`w-dot ${hinweis.ok ? "gruen" : "orange"}`} />
          <span>{hinweis.text}</span>
          <span className="b-wachsen" />
          {anordnung.eigeneAusgeblendet.map((n) => (
            <button key={n} className="w-textknopf klein" onClick={() => einblenden(n)} title={`${n} wieder anzeigen`}>{n} einblenden</button>
          ))}
          {anordnung.reihenfolge.length > 0 && (
            <button className="w-textknopf klein" onClick={() => speichere([], anordnung.eigeneAusgeblendet)}>Reihenfolge wie in Notion</button>
          )}
        </div>
      )}

      {!woche && !fehler && <div className="b-laden">Daten werden aus Notion geladen…</div>}

      {woche && (
        <div className={`w-scroll${laedt ? " laedt" : ""}`}>
          <div className="w-gitter" style={{ gridTemplateColumns: `64px repeat(${spalten}, minmax(196px, 1fr))` }}>
            <div />
            {woche.mitarbeiter.map((m) => {
              const f = farbeVon(m.farbe);
              return (
                <div key={m.name} className={`w-bahn kopf${ziehen.klasse(m.name)}`} style={bahnStil(f)} {...ziehen.props(m.name)}>
                  <span className="w-name">{m.name}</span>
                  {!fest.has(m.name) && (
                    <button className="w-aus" draggable={false} aria-label={`${m.name} ausblenden`} title="Ausblenden" onClick={() => ausblenden(m.name)}>×</button>
                  )}
                </div>
              );
            })}

            {woche.zeilen.map((zeile) => {
              const wt = new Date(zeile.datum + "T12:00:00").getDay();
              const [, mo, ta] = zeile.datum.split("-").map(Number);
              return [
                <div key={zeile.datum} className="w-tag">
                  <span className="w-tag-wt">{WOCHENTAGE_KURZ[wt]}</span>
                  <span className="w-tag-datum">{ta}.{mo}.</span>
                </div>,
                ...zeile.zellen.map((z, i) => {
                  const m = woche.mitarbeiter[i];
                  const key = `${zeile.datum}-${m.name}`;
                  return (
                    <div key={key} className="w-bahn" style={bahnStil(farbeVon(m.farbe))}>
                      <Kachel
                        z={z}
                        aktiv={auswahl?.key === key}
                        onOeffnen={() => setAuswahl({ key, z, mitarbeiter: m.name, datum: zeile.datum })}
                      />
                    </div>
                  );
                }),
              ];
            })}

            <div className="w-tag summe">Woche</div>
            {woche.summen.map((s, i) => {
              const m = woche.mitarbeiter[i];
              const teile = Object.entries(s.sonder).map(([status, n]) => `${n}× ${status}`);
              return (
                <div key={m.name} className="w-bahn fuss" style={bahnStil(farbeVon(m.farbe))}>
                  <span className="w-wochen-zahl">
                    {fmtStd(s.gearbeitet)}<span className="w-einheit">h</span>
                    <Saldo wert={s.saldo} gross />
                  </span>
                  <span className="w-wochen-notiz">{teile.length ? teile.join(" · ") : "Soll 40 h"}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {auswahl && (
        <Detail
          auswahl={auswahl}
          onSchliessen={() => setAuswahl(null)}
          onKorrektur={() => {
            setKorrektur(auswahl);
            setAuswahl(null);
          }}
        />
      )}

      {korrektur && (
        <KorrekturDialog
          api={api}
          zelle={korrektur.z}
          mitarbeiter={korrektur.mitarbeiter}
          datum={korrektur.datum}
          onAbbrechen={() => setKorrektur(null)}
          onGespeichert={() => {
            setKorrektur(null);
            neuLaden();
          }}
        />
      )}
    </section>
  );
}
