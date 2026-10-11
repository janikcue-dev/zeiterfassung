import { useEffect, useState } from "react";
import { farbeVon } from "./logik.js";
import { APP_ADRESSE } from "./einstellungen.js";

// Mitarbeiter & persönliche Links.
// Jeder Link enthält den Namen (zum Zuordnen) und einen geheimen Schlüssel.
// Gebucht wird immer auf den Namen, der zum Schlüssel gehört – den Namen im Link zu ändern bringt nichts.

const FARBEN = [
  ["blue", "Blau"], ["green", "Grün"], ["purple", "Lila"], ["pink", "Rosa"], ["orange", "Orange"],
  ["yellow", "Gelb"], ["red", "Rot"], ["brown", "Braun"], ["gray", "Grau"], ["default", "Standard"],
];

function linkFuer(name, zugang) {
  const azubi = zugang.azubi ? "&azubi=1" : "";
  return `${APP_ADRESSE}/?mitarbeiter=${encodeURIComponent(name)}&k=${zugang.schluessel}${azubi}`;
}

const datumDe = (iso) => (iso ? new Date(iso).toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "numeric" }) : "");
const tageSeit = (iso) => (iso ? Math.floor((Date.now() - new Date(iso + "T12:00:00").getTime()) / 864e5) : 0);

async function kopieren(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    window.prompt("Link kopieren (Strg/Cmd + C):", text);
    return false;
  }
}

function StatusChip({ zugang }) {
  if (!zugang) return <span className="b-chip grau">Noch kein Link</span>;
  if (zugang.status === "Gesperrt") return <span className="b-chip gesperrt">Gesperrt</span>;
  return <span className="b-chip ok">Aktiv</span>;
}

function MitarbeiterKarte({ m, beschaeftigt, ausfuehren }) {
  const [kopiert, setKopiert] = useState(false);
  const f = farbeVon(m.farbe);
  const z = m.zugang;
  const aktiv = z && z.status === "Aktiv";
  const link = aktiv ? linkFuer(m.name, z) : "";
  const alt = aktiv && tageSeit(z.erstellt) > 180;
  const busy = beschaeftigt === m.name;

  async function kopiere() {
    if (await kopieren(link)) {
      setKopiert(true);
      setTimeout(() => setKopiert(false), 2000);
    }
  }

  const whatsapp = `https://wa.me/?text=${encodeURIComponent(`Hallo ${m.name}, hier ist dein persönlicher Link für die Zeiterfassung. Bitte öffnen und zum Home-Bildschirm hinzufügen. Nicht weitergeben!\n${link}`)}`;

  return (
    <li className={`b-ma-karte${z?.status === "Gesperrt" ? " gesperrt" : ""}`}>
      <div className="b-ma-kopf">
        <span className="b-name-chip" style={{ background: f.bg, color: f.fg }}>{m.name}</span>
        <StatusChip zugang={z} />
        {z?.azubi && <span className="b-chip grau">Azubi</span>}
        <span className="b-wachsen" />
        {z && <span className="b-sek klein">Link vom {datumDe(z.erstellt)}</span>}
      </div>

      {aktiv && (
        <div className="b-ma-link">
          <input readOnly value={link} aria-label={`Link für ${m.name}`} onFocus={(e) => e.target.select()} />
          <button className="b-btn" onClick={kopiere}>{kopiert ? "Kopiert ✓" : "Kopieren"}</button>
          <a className="b-btn b-btn-link" href={whatsapp} target="_blank" rel="noreferrer">Per WhatsApp</a>
        </div>
      )}
      {alt && <div className="b-chip warnung">Link ist über 6 Monate alt – ggf. neuen Link erzeugen</div>}

      <div className="b-ma-aktionen">
        {!z && (
          <button className="b-btn b-btn-primaer" disabled={busy} onClick={() => ausfuehren(m.name, "zugangErneuern", { name: m.name })}>
            {busy ? "Erzeugt…" : "Link erzeugen"}
          </button>
        )}
        {aktiv && (
          <button
            className="b-btn"
            disabled={busy}
            onClick={() =>
              window.confirm(`Neuen Link für ${m.name} erzeugen?\n\nDer bisherige Link funktioniert dann nicht mehr. ${m.name} braucht den neuen Link.`) &&
              ausfuehren(m.name, "zugangErneuern", { name: m.name })
            }
          >
            Neuer Link
          </button>
        )}
        {aktiv && (
          <button
            className="b-btn b-btn-gefahr"
            disabled={busy}
            onClick={() =>
              window.confirm(`${m.name} sperren?\n\nDer Link funktioniert dann nicht mehr (spätestens nach 1 Minute). Bisherige Stunden bleiben erhalten.`) &&
              ausfuehren(m.name, "zugangStatus", { name: m.name, status: "Gesperrt" })
            }
          >
            Sperren
          </button>
        )}
        {z?.status === "Gesperrt" && (
          <button className="b-btn" disabled={busy} onClick={() => ausfuehren(m.name, "zugangStatus", { name: m.name, status: "Aktiv" })}>
            Entsperren
          </button>
        )}
        {z && (
          <label className="b-schalter">
            <input type="checkbox" checked={!!z.azubi} disabled={busy} onChange={(e) => ausfuehren(m.name, "zugangAzubi", { name: m.name, azubi: e.target.checked })} />
            <span>Azubi (Schultag in der App)</span>
          </label>
        )}
      </div>
    </li>
  );
}

export default function Mitarbeiter({ api }) {
  const [stand, setStand] = useState(null);
  const [fehler, setFehler] = useState("");
  const [beschaeftigt, setBeschaeftigt] = useState(null);
  const [neu, setNeu] = useState({ name: "", farbe: "blue", azubi: false });

  useEffect(() => {
    let aktiv = true;
    api("zugaenge")
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
    if (await ausfuehren("neu", "mitarbeiterAnlegen", neu)) setNeu({ name: "", farbe: "blue", azubi: false });
  }

  const uebergangAktiv = stand?.uebergangBis && new Date(stand.uebergangBis) > new Date();
  const ohneLink = stand ? stand.mitarbeiter.filter((m) => !m.zugang).length : 0;
  const liste = stand
    ? [...stand.mitarbeiter].sort((a, b) => (a.zugang?.status === "Gesperrt") - (b.zugang?.status === "Gesperrt"))
    : [];

  return (
    <section className="b-seite b-schmal">
      <div className="b-kopf">
        <div>
          <div className="b-ueberzeile">Mitarbeiter</div>
          <h1>Mitarbeiter & Links</h1>
          <p className="b-sek">Jeder Mitarbeiter bekommt einen eigenen Link mit geheimem Schlüssel. Nur damit kann er Zeiten eintragen.</p>
        </div>
      </div>

      {stand && uebergangAktiv && (
        <div className="b-banner warnung">
          <b>Übergangswoche:</b> Alte Links ohne Schlüssel funktionieren noch bis <b>{datumDe(stand.uebergangBis)}</b>.
          Bitte allen Mitarbeitern bis dahin ihren neuen Link schicken.
          {ohneLink > 0 && <> Noch ohne Link: <b>{ohneLink}</b>.</>}
        </div>
      )}
      {stand && !uebergangAktiv && (
        <div className="b-banner ok">Alte Links ohne Schlüssel sind abgeschaltet – nur noch persönliche Links funktionieren.</div>
      )}

      <form className="b-karte b-neu" onSubmit={anlegen}>
        <label className="b-feld b-wachsen">
          <span>Neuer Mitarbeiter</span>
          <input value={neu.name} maxLength={60} placeholder="Vorname (so erscheint er in Notion)" onChange={(e) => setNeu({ ...neu, name: e.target.value })} />
        </label>
        <label className="b-feld">
          <span>Farbe</span>
          <select className="b-auswahl" value={neu.farbe} onChange={(e) => setNeu({ ...neu, farbe: e.target.value })}>
            {FARBEN.map(([wert, label]) => <option key={wert} value={wert}>{label}</option>)}
          </select>
        </label>
        <label className="b-schalter b-schalter-form">
          <input type="checkbox" checked={neu.azubi} onChange={(e) => setNeu({ ...neu, azubi: e.target.checked })} />
          <span>Azubi</span>
        </label>
        <button className="b-btn b-btn-primaer" type="submit" disabled={!neu.name.trim() || beschaeftigt === "neu"}>
          {beschaeftigt === "neu" ? "Legt an…" : "Anlegen"}
        </button>
      </form>

      {fehler && <div className="b-fehler">{fehler}</div>}
      {!stand && !fehler && <div className="b-laden">Mitarbeiter werden geladen…</div>}

      {stand && (
        <ul className="b-ma-liste">
          {liste.map((m) => (
            <MitarbeiterKarte key={m.name} m={m} beschaeftigt={beschaeftigt} ausfuehren={ausfuehren} />
          ))}
        </ul>
      )}

      <p className="b-legende b-sek">
        Sperren und „Neuer Link“ wirken spätestens nach einer Minute. Gesperrte Mitarbeiter verschwinden aus der
        Wochenübersicht, bleiben aber im Monatsabschluss, solange sie Stunden haben. Die Links stehen auch in Notion
        in der Datenbank „Zugänge Zeiterfassung“ – dort bitte nichts von Hand ändern.
      </p>
    </section>
  );
}
