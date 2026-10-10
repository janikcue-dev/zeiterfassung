import { useMemo, useState } from "react";
import { useDaten } from "./api.js";
import {
  addTage, baueWoche, baustellenFarbe, datumKurz, farbeVon, fmtSaldo, fmtStd, heuteStr,
  kalenderwoche, montagVon, normName, WOCHENTAGE_KURZ,
} from "./logik.js";
import { AUSGEBLENDETE_MITARBEITER } from "./einstellungen.js";
import KorrekturDialog from "./KorrekturDialog.jsx";

function WarnIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3 2 20h20L12 3z" />
      <path d="M12 10v4" />
      <path d="M12 17h.01" />
    </svg>
  );
}

function SaldoText({ wert, gross }) {
  const klasse = wert > 0.004 ? "plus" : wert < -0.004 ? "minus" : "null";
  return <span className={`b-saldo b-saldo-${klasse}${gross ? " gross" : ""}`}>{fmtSaldo(wert)}</span>;
}

function SonderBadge({ eintrag }) {
  const stunden = eintrag.gesamt > 0 && eintrag.status !== "Urlaub" ? ` · ${fmtStd(eintrag.gesamt)} h` : "";
  return <span className="b-badge-sonder">{eintrag.status}{stunden}</span>;
}

function Kachel({ z, farbe, onKorrektur }) {
  if (z.leer) {
    return (
      <div className={`b-kachel b-kachel-leer${z.fehlt ? " fehlt" : ""}`}>
        {z.fehlt ? "Kein Eintrag" : ""}
      </div>
    );
  }

  const tag = z.normal[0];
  const warnung = z.warnungen.length > 0;
  const link = tag?.url || z.sonder[0]?.url || z.projekte[0]?.url;

  return (
    <div className={`b-kachel${warnung ? " warnung" : ""}`} style={{ borderTopColor: farbe.akzent }}>
      {z.sonder.length > 0 && (
        <div className="b-kachel-sonder">
          {z.sonder.map((s) => <SonderBadge key={s.id} eintrag={s} />)}
        </div>
      )}

      {z.normal.length > 0 && (
        <div className="b-kachel-zeit">
          <span className="b-zahl">{tag.beginn && tag.ende ? `${tag.beginn} – ${tag.ende}` : "ohne Uhrzeit"}</span>
          {tag.pause !== null && tag.beginn && <span className="b-sek">Pause {tag.pause} min</span>}
        </div>
      )}

      {z.projekte.length > 0 && (
        <ol className="b-projekte">
          {z.projekte.map((p, i) => (
            <li key={p.id} className={z.abweichendeBaustellen.has(normName(p.name)) ? "abweichend" : ""} title={p.notiz || undefined}>
              <span className="b-nr">{p.reihenfolge ?? i + 1}.</span>
              <span className="b-quadrat" style={{ background: baustellenFarbe(p.name) }} />
              <span className="b-projekt-name">{p.name || "(ohne Namen)"}</span>
              <span className="b-zahl b-fett">{fmtStd(p.stunden)} h</span>
            </li>
          ))}
        </ol>
      )}

      {warnung && (
        <ul className="b-warnungen">
          {z.warnungen.map((w, i) => (
            <li key={i}><WarnIcon /> {w.text}</li>
          ))}
        </ul>
      )}

      {z.normal.length > 0 && (
        <div className="b-kachel-fuss">
          <span className="b-sek">Gesamt</span>
          <span className="b-zahl b-fett">
            {fmtStd(z.gearbeitet)} h <SaldoText wert={z.saldo} />
          </span>
        </div>
      )}

      <div className="b-kachel-aktionen">
        {z.korrigierbar && <button className="b-btn-klein" onClick={onKorrektur}>Korrigieren</button>}
        {link && <a className="b-btn-klein leise" href={link} target="_blank" rel="noreferrer">In Notion</a>}
      </div>
    </div>
  );
}

function SonderZusammenfassung({ sonder }) {
  const teile = Object.entries(sonder).map(([status, n]) => `${n}× ${status}`);
  return teile.length ? <span className="b-sek klein">{teile.join(" · ")}</span> : <span className="b-sek klein">Soll 40 h</span>;
}

export default function Wochenuebersicht({ api }) {
  const [montag, setMontag] = useState(() => montagVon(heuteStr()));
  const [korrektur, setKorrektur] = useState(null);
  const sonntag = addTage(montag, 6);
  const { daten, fehler, laedt, neuLaden } = useDaten(api, montag, sonntag);

  const woche = useMemo(
    () => (daten ? baueWoche(daten, montag, heuteStr(), AUSGEBLENDETE_MITARBEITER) : null),
    [daten, montag]
  );

  const spalten = woche ? woche.mitarbeiter.length : 0;

  return (
    <section className="b-seite">
      <div className="b-kopf">
        <div>
          <div className="b-ueberzeile">Wochenübersicht · KW {kalenderwoche(montag)}</div>
          <h1>{datumKurz(montag)} – {datumKurz(sonntag)}{sonntag.slice(0, 4)}</h1>
        </div>
        <div className="b-knopfreihe">
          <button className="b-btn b-btn-icon" aria-label="Vorherige Woche" onClick={() => setMontag(addTage(montag, -7))}>‹</button>
          <button className="b-btn" onClick={() => setMontag(montagVon(heuteStr()))}>Diese Woche</button>
          <button className="b-btn b-btn-icon" aria-label="Nächste Woche" onClick={() => setMontag(addTage(montag, 7))}>›</button>
          <button className="b-btn" onClick={neuLaden} disabled={laedt}>{laedt ? "Lädt…" : "↻ Aktualisieren"}</button>
        </div>
      </div>

      {fehler && <div className="b-fehler">{fehler}</div>}

      {woche && (
        <div className="b-hinweisleiste">
          {woche.warnungen > 0 ? (
            <span className="b-chip warnung"><WarnIcon /> {woche.warnungen} {woche.warnungen === 1 ? "Kachel" : "Kacheln"} mit Hinweis</span>
          ) : (
            <span className="b-chip ok">Keine Abweichungen</span>
          )}
          {woche.fehlend > 0 && <span className="b-chip grau">{woche.fehlend} fehlende {woche.fehlend === 1 ? "Eintrag" : "Einträge"}</span>}
        </div>
      )}

      {!woche && !fehler && <div className="b-laden">Daten werden aus Notion geladen…</div>}

      {woche && (
        <div className={`b-gitter-scroll${laedt ? " laedt" : ""}`}>
          <div className="b-gitter" style={{ gridTemplateColumns: `76px repeat(${spalten}, minmax(210px, 1fr))` }}>
            <div />
            {woche.mitarbeiter.map((m) => {
              const f = farbeVon(m.farbe);
              return (
                <div key={m.name} className="b-spaltenkopf" style={{ background: f.bg, color: f.fg }}>
                  <span className="b-punkt" style={{ background: f.akzent }} />
                  {m.name}
                </div>
              );
            })}

            {woche.zeilen.map((zeile) => {
              const wt = new Date(zeile.datum + "T12:00:00").getDay();
              return [
                <div key={zeile.datum} className="b-tagkopf">
                  <div className="b-tagkopf-wt">{WOCHENTAGE_KURZ[wt]}</div>
                  <div className="b-sek">{datumKurz(zeile.datum)}</div>
                </div>,
                ...zeile.zellen.map((z, i) => {
                  const m = woche.mitarbeiter[i];
                  return (
                    <Kachel
                      key={`${zeile.datum}-${m.name}`}
                      z={z}
                      farbe={farbeVon(m.farbe)}
                      onKorrektur={() => setKorrektur({ z, mitarbeiter: m.name, datum: zeile.datum })}
                    />
                  );
                }),
              ];
            })}

            <div className="b-tagkopf b-tagkopf-summe">Woche</div>
            {woche.summen.map((s, i) => {
              const f = farbeVon(woche.mitarbeiter[i].farbe);
              return (
                <div key={woche.mitarbeiter[i].name} className="b-summe" style={{ background: f.bg }}>
                  <div className="b-summe-zahl">
                    <span className="b-zahl">{fmtStd(s.gearbeitet)} h</span>
                    <SaldoText wert={s.saldo} gross />
                  </div>
                  <SonderZusammenfassung sonder={s.sonder} />
                </div>
              );
            })}
          </div>
        </div>
      )}

      <p className="b-legende b-sek">
        Gesamt = gearbeitete Stunden · Plus/Minus = Über-/Minusstunden aus Notion (Soll Mo–Do 8,5 h, Fr 6 h) ·
        Orange = gleiche Baustelle mit bis zu 1 h Unterschied zwischen Kollegen, Projektsumme passt nicht oder doppelter Eintrag.
      </p>

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
