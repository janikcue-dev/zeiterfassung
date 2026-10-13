import { useEffect, useMemo, useState } from "react";
import { useDaten } from "./api.js";
import {
  addTage, baueWoche, baustellenFarbe, farbeVon, fmtSaldo, fmtStd, heuteStr,
  kalenderwoche, MONATSNAMEN, montagVon, normName, WOCHENTAGE_KURZ,
} from "./logik.js";
import { AUSGEBLENDETE_MITARBEITER } from "./einstellungen.js";
import { fuehreZusammen, useAnordnung, useZiehen, verschiebe } from "./anordnung.js";
import TagDialog from "./TagDialog.jsx";

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

// Zuletzt angesehene Woche merken (bis der Browser geschlossen wird)
const WOCHE_KEY = "buero_woche_montag";
function gemerkteWoche() {
  try {
    const w = sessionStorage.getItem(WOCHE_KEY);
    if (w && /^\d{4}-\d{2}-\d{2}$/.test(w)) return montagVon(w);
  } catch {
    /* ignorieren */
  }
  return montagVon(heuteStr());
}

const bahnStil = (f) => ({ "--bahn": `${f.akzent}17`, "--bahn-text": f.fg });

function zeitText(tag) {
  if (!tag.beginn || !tag.ende) return "ohne Uhrzeit";
  return `${tag.beginn}–${tag.ende}${tag.pause !== null ? ` · ${tag.pause}′` : ""}`;
}

function sonderText(s) {
  return s.gesamt > 0 && s.status !== "Urlaub" ? `${s.status} · ${fmtStd(s.gesamt)} h` : s.status;
}

function Kachel({ z, onOeffnen, onNeu, aktiv, name }) {
  if (z.leer) {
    // Leere Kachel: Klick trägt einen Tag nach
    return (
      <button className={`w-kachel leer${z.fehlt ? " fehlt" : ""}`} onClick={onNeu} aria-label={`Tag für ${name} eintragen`}>
        <span className="w-leer-text">{z.fehlt ? "fehlt" : ""}</span>
        <span className="w-plus">+ eintragen</span>
      </button>
    );
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
function Detail({ auswahl, onSchliessen, onKorrektur, onLoeschen, loescht }) {
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
  if (!z.korrigierbar && z.normal.length > 1) grund = "Für diesen Tag gibt es zwei Arbeitstag-Einträge – den Tag löschen und neu eintragen, oder in Notion bereinigen.";
  else if (!z.korrigierbar && tag && !tag.beginn) grund = "Teilweise krank: diesen Tag bitte direkt in Notion korrigieren.";
  else if (!tag) grund = "Abwesenheiten lassen sich hier löschen und neu eintragen.";

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
          <button className="w-link w-gefahr" disabled={loescht} onClick={onLoeschen}>{loescht ? "Löscht…" : "Ganzen Tag löschen"}</button>
        </div>
      </aside>
    </>
  );
}

export default function Wochenuebersicht({ api }) {
  const [montag, setMontagRoh] = useState(gemerkteWoche);
  const [auswahl, setAuswahl] = useState(null);
  const [dialog, setDialog] = useState(null); // { modus: "korrektur" | "neu", z, mitarbeiter, datum }
  const [loescht, setLoescht] = useState(false);
  const [aktionsFehler, setAktionsFehler] = useState("");
  const setMontag = (m) => {
    setMontagRoh(m);
    try {
      sessionStorage.setItem(WOCHE_KEY, m);
    } catch {
      /* ignorieren */
    }
  };
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
      {aktionsFehler && <div className="b-fehler">{aktionsFehler}</div>}

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
                        name={m.name}
                        aktiv={auswahl?.key === key}
                        onOeffnen={() => setAuswahl({ key, z, mitarbeiter: m.name, datum: zeile.datum })}
                        onNeu={() => setDialog({ modus: "neu", mitarbeiter: m.name, datum: zeile.datum })}
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
          loescht={loescht}
          onKorrektur={() => {
            setDialog({ modus: "korrektur", ...auswahl });
            setAuswahl(null);
          }}
          onLoeschen={async () => {
            const { z, mitarbeiter, datum } = auswahl;
            const was = [z.normal.length && "Arbeitszeit", z.projekte.length && `${z.projekte.length} Baustelle(n)`, ...z.sonder.map((s) => s.status)].filter(Boolean).join(", ");
            if (!window.confirm(`Den ganzen Tag von ${mitarbeiter} am ${datum.split("-").reverse().join(".")} löschen?\n\n${was}\n\nDie Einträge landen im Notion-Papierkorb und lassen sich dort 30 Tage lang wiederherstellen.`)) return;
            setLoescht(true);
            setAktionsFehler("");
            try {
              await api("tagLoeschen", {
                arbeitstagIds: [...z.normal, ...z.sonder].map((a) => a.id),
                projektIds: z.projekte.map((pr) => pr.id),
              });
              setAuswahl(null);
              neuLaden();
            } catch (e) {
              setAktionsFehler(e.message);
            } finally {
              setLoescht(false);
            }
          }}
        />
      )}

      {dialog && (
        <TagDialog
          api={api}
          modus={dialog.modus}
          zelle={dialog.z}
          mitarbeiter={dialog.mitarbeiter}
          datum={dialog.datum}
          onAbbrechen={() => setDialog(null)}
          onGespeichert={(neuesDatum) => {
            setDialog(null);
            // Tag in eine andere Woche verschoben/eingetragen → dorthin springen
            if (neuesDatum && montagVon(neuesDatum) !== montag) setMontag(montagVon(neuesDatum));
            else neuLaden();
          }}
        />
      )}
    </section>
  );
}
