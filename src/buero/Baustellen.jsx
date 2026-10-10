import { useEffect, useState } from "react";
import { baustellenFarbe } from "./logik.js";

// Baustellen = Unterseiten von "Laufende Baustellen" in Notion.
// Archivieren verschiebt die Seite in die Unterseite "Archiv" – die Mitarbeiter-App schlägt sie dann nicht mehr vor.

export default function Baustellen({ api }) {
  const [stand, setStand] = useState(null);
  const [fehler, setFehler] = useState("");
  const [name, setName] = useState("");
  const [beschaeftigt, setBeschaeftigt] = useState(null); // id oder "neu"
  const [suche, setSuche] = useState("");

  useEffect(() => {
    let aktiv = true;
    api("baustellen")
      .then((d) => aktiv && setStand(d))
      .catch((e) => aktiv && setFehler(e.message));
    return () => {
      aktiv = false;
    };
  }, [api]);

  async function ausfuehren(kennung, action, daten) {
    setBeschaeftigt(kennung);
    setFehler("");
    try {
      setStand(await api(action, daten));
      return true;
    } catch (e) {
      setFehler(e.message);
      return false;
    } finally {
      setBeschaeftigt(null);
    }
  }

  async function anlegen(e) {
    e.preventDefault();
    if (!name.trim()) return;
    if (await ausfuehren("neu", "baustelleAnlegen", { name })) setName("");
  }

  const filter = (liste) => liste.filter((b) => b.name.toLowerCase().includes(suche.trim().toLowerCase()));

  return (
    <section className="b-seite b-schmal">
      <div className="b-kopf">
        <div>
          <div className="b-ueberzeile">Baustellen</div>
          <h1>Laufende Baustellen</h1>
          <p className="b-sek">Diese Namen bekommen die Mitarbeiter in der App vorgeschlagen.</p>
        </div>
      </div>

      <form className="b-karte b-neu" onSubmit={anlegen}>
        <label className="b-feld b-wachsen">
          <span>Neue Baustelle (Kundenname)</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="z. B. Müller – Hauptstraße 12" maxLength={120} />
        </label>
        <button className="b-btn b-btn-primaer" type="submit" disabled={!name.trim() || beschaeftigt === "neu"}>
          {beschaeftigt === "neu" ? "Legt an…" : "Anlegen"}
        </button>
      </form>

      {fehler && <div className="b-fehler">{fehler}</div>}
      {!stand && !fehler && <div className="b-laden">Baustellen werden geladen…</div>}

      {stand && (
        <>
          <label className="b-feld b-suche">
            <span>Suchen</span>
            <input value={suche} onChange={(e) => setSuche(e.target.value)} placeholder="Name eingeben…" />
          </label>

          <div className="b-karte">
            <h2>Laufend <span className="b-sek">({stand.laufend.length})</span></h2>
            {filter(stand.laufend).length === 0 && <p className="b-sek">Keine laufenden Baustellen.</p>}
            <ul className="b-bliste">
              {filter(stand.laufend).map((b) => (
                <li key={b.id}>
                  <span className="b-quadrat" style={{ background: baustellenFarbe(b.name) }} />
                  <span className="b-wachsen">{b.name}</span>
                  <button className="b-btn" disabled={!!beschaeftigt} onClick={() => ausfuehren(b.id, "baustelleVerschieben", { id: b.id, ziel: "archiv" })}>
                    {beschaeftigt === b.id ? "Verschiebt…" : "Ins Archiv"}
                  </button>
                </li>
              ))}
            </ul>
          </div>

          <details className="b-karte">
            <summary><h2>Archiv <span className="b-sek">({stand.archiv.length})</span></h2></summary>
            {filter(stand.archiv).length === 0 && <p className="b-sek">Das Archiv ist leer.</p>}
            <ul className="b-bliste">
              {filter(stand.archiv).map((b) => (
                <li key={b.id}>
                  <span className="b-quadrat grau" />
                  <span className="b-wachsen b-sek">{b.name}</span>
                  <button className="b-btn" disabled={!!beschaeftigt} onClick={() => ausfuehren(b.id, "baustelleVerschieben", { id: b.id, ziel: "laufend" })}>
                    {beschaeftigt === b.id ? "Verschiebt…" : "Wieder aktivieren"}
                  </button>
                </li>
              ))}
            </ul>
          </details>
        </>
      )}
    </section>
  );
}
