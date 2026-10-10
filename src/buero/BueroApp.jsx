import { useCallback, useEffect, useState } from "react";
import "./buero.css";
import { bueroApi, gespeichertesPasswort, merkePasswort, NichtAngemeldet } from "./api.js";
import Wochenuebersicht from "./Wochenuebersicht.jsx";
import Monatsabschluss from "./Monatsabschluss.jsx";
import Baustellen from "./Baustellen.jsx";

// =====================================================================
// Büro-Bereich – erreichbar unter  /?buero
// Passwortschutz läuft auf dem Server (/api/buero, Variable BUERO_PASSWORT).
// =====================================================================

const ANSICHTEN = [
  { key: "woche", label: "Wochenübersicht" },
  { key: "monat", label: "Monatsabschluss" },
  { key: "baustellen", label: "Baustellen" },
];

function ansichtAusHash() {
  const h = window.location.hash.replace("#", "");
  return ANSICHTEN.some((a) => a.key === h) ? h : "woche";
}

function Logo() {
  const [fehlt, setFehlt] = useState(false);
  if (fehlt) return <span className="b-logo-text">Malermeister Cürten</span>;
  return <img src="/logo.png" alt="Malermeister Cürten" className="b-logo" onError={() => setFehlt(true)} />;
}

function Anmeldung({ onAngemeldet, hinweis }) {
  const [eingabe, setEingabe] = useState("");
  const [fehler, setFehler] = useState(hinweis || "");
  const [laedt, setLaedt] = useState(false);

  async function anmelden(e) {
    e.preventDefault();
    if (!eingabe) return;
    setLaedt(true);
    setFehler("");
    try {
      await bueroApi("pruefen", {}, eingabe);
      merkePasswort(eingabe);
      onAngemeldet(eingabe);
    } catch (err) {
      setFehler(err.message);
      setLaedt(false);
    }
  }

  return (
    <div className="b-login">
      <form className="b-login-karte" onSubmit={anmelden}>
        <Logo />
        <h1>Büro</h1>
        <p className="b-sek">Bitte das Büro-Passwort eingeben.</p>
        <label className="b-feld">
          <span>Passwort</span>
          <input type="password" autoFocus autoComplete="current-password" value={eingabe} onChange={(e) => setEingabe(e.target.value)} />
        </label>
        {fehler && <div className="b-fehler">{fehler}</div>}
        <button className="b-btn b-btn-primaer" type="submit" disabled={laedt || !eingabe}>
          {laedt ? "Prüfe…" : "Anmelden"}
        </button>
      </form>
    </div>
  );
}

export default function BueroApp() {
  const [passwort, setPasswort] = useState(gespeichertesPasswort);
  const [geprueft, setGeprueft] = useState(false);
  const [hinweis, setHinweis] = useState("");
  const [ansicht, setAnsicht] = useState(ansichtAusHash);

  useEffect(() => {
    document.title = "Büro – Malermeister Cürten";
    document.body.classList.add("b-body");
    const onHash = () => setAnsicht(ansichtAusHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const abmelden = useCallback((meldung = "") => {
    merkePasswort("");
    setPasswort("");
    setGeprueft(false);
    setHinweis(meldung);
  }, []);

  // Gemerktes Passwort beim Start einmal prüfen
  useEffect(() => {
    if (!passwort || geprueft) return;
    let aktiv = true;
    bueroApi("pruefen", {}, passwort)
      .then(() => aktiv && setGeprueft(true))
      .catch((e) => aktiv && abmelden(e instanceof NichtAngemeldet ? "Bitte erneut anmelden." : e.message));
    return () => {
      aktiv = false;
    };
  }, [passwort, geprueft, abmelden]);

  const api = useCallback(
    (action, daten) =>
      bueroApi(action, daten, passwort).catch((e) => {
        if (e instanceof NichtAngemeldet) abmelden("Passwort wurde geändert – bitte neu anmelden.");
        throw e;
      }),
    [passwort, abmelden]
  );

  if (!passwort) {
    return (
      <Anmeldung
        hinweis={hinweis}
        onAngemeldet={(p) => {
          setPasswort(p);
          setGeprueft(true);
          setHinweis("");
        }}
      />
    );
  }
  if (!geprueft) return <div className="b-laden-voll">Wird geladen…</div>;

  return (
    <div className="b-app">
      <header className="b-header">
        <div className="b-marke">
          <Logo />
          <span className="b-marke-sub">Büro</span>
        </div>
        <nav className="b-nav" aria-label="Bereiche">
          {ANSICHTEN.map((a) => (
            <a key={a.key} href={`#${a.key}`} className={ansicht === a.key ? "aktiv" : ""} aria-current={ansicht === a.key ? "page" : undefined}>
              {a.label}
            </a>
          ))}
        </nav>
        <button className="b-btn b-btn-leise" onClick={() => abmelden()}>Abmelden</button>
      </header>

      <main className="b-main">
        {ansicht === "woche" && <Wochenuebersicht api={api} />}
        {ansicht === "monat" && <Monatsabschluss api={api} />}
        {ansicht === "baustellen" && <Baustellen api={api} />}
      </main>
    </div>
  );
}
