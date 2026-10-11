import { useMemo, useState } from "react";
import { AUSGEBLENDETE_MITARBEITER } from "./einstellungen.js";

// Eigene Reihenfolge und ausgeblendete Mitarbeiter für die Büro-Ansicht.
// Gespeichert im Browser (pro Gerät) – Notion bleibt unverändert.

const KEY = "buero_mitarbeiter_anordnung";

function lade() {
  try {
    const roh = JSON.parse(localStorage.getItem(KEY) || "null");
    if (roh && Array.isArray(roh.reihenfolge) && Array.isArray(roh.ausgeblendet)) return roh;
  } catch {
    /* ignorieren */
  }
  return { reihenfolge: [], ausgeblendet: [] };
}

export function useAnordnung() {
  const [anordnung, setAnordnung] = useState(lade);

  function speichere(neu) {
    setAnordnung(neu);
    try {
      localStorage.setItem(KEY, JSON.stringify(neu));
    } catch {
      /* privates Fenster – gilt dann nur bis zum Schließen */
    }
  }

  // Ausgeblendet = in der App gewählt + fest in einstellungen.js eingetragen
  const ausgeblendet = useMemo(
    () => [...new Set([...anordnung.ausgeblendet, ...AUSGEBLENDETE_MITARBEITER])],
    [anordnung.ausgeblendet]
  );
  return { reihenfolge: anordnung.reihenfolge, ausgeblendet, eigeneAusgeblendet: anordnung.ausgeblendet, speichere };
}

// Neue Reihenfolge aus dem Dialog mit der alten zusammenführen
// (Namen, die im aktuellen Zeitraum nicht vorkamen, behalten ihren Platz hinten)
export function fuehreZusammen(alteReihenfolge, neueListe) {
  const neu = new Set(neueListe);
  return [...neueListe, ...alteReihenfolge.filter((n) => !neu.has(n))];
}

// Einen Namen vor/hinter einen anderen setzen
export function verschiebe(liste, name, zielName, nachher) {
  if (name === zielName) return liste;
  const ohne = liste.filter((n) => n !== name);
  let i = ohne.indexOf(zielName);
  if (i < 0) return liste;
  if (nachher) i++;
  ohne.splice(i, 0, name);
  return ohne;
}

// Ziehen & Ablegen (Maus). achse "x" = Spalten nebeneinander, "y" = Zeilen untereinander.
// Mit der Tastatur: Element anklicken/fokussieren und Pfeiltasten benutzen.
export function useZiehen(achse, sichtbar, onVerschiebe) {
  const [gezogen, setGezogen] = useState(null);
  const [ziel, setZiel] = useState(null);

  function ende() {
    setGezogen(null);
    setZiel(null);
  }

  function props(name) {
    const zurueck = achse === "x" ? "ArrowLeft" : "ArrowUp";
    const vor = achse === "x" ? "ArrowRight" : "ArrowDown";
    return {
      draggable: true,
      tabIndex: 0,
      "aria-roledescription": "verschiebbar",
      title: achse === "x" ? "Zum Verschieben nach links oder rechts ziehen" : "Zum Verschieben nach oben oder unten ziehen",
      onDragStart: (e) => {
        setGezogen(name);
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", name);
      },
      onDragOver: (e) => {
        if (!gezogen) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        const r = e.currentTarget.getBoundingClientRect();
        const nachher = achse === "x" ? e.clientX > r.left + r.width / 2 : e.clientY > r.top + r.height / 2;
        if (!ziel || ziel.name !== name || ziel.nachher !== nachher) setZiel({ name, nachher });
      },
      onDrop: (e) => {
        e.preventDefault();
        if (gezogen && ziel && gezogen !== ziel.name) onVerschiebe(gezogen, ziel.name, ziel.nachher);
        ende();
      },
      onDragEnd: ende,
      onKeyDown: (e) => {
        if (e.target !== e.currentTarget || (e.key !== zurueck && e.key !== vor)) return;
        e.preventDefault();
        const i = sichtbar.indexOf(name);
        const j = e.key === vor ? i + 1 : i - 1;
        if (i < 0 || j < 0 || j >= sichtbar.length) return;
        onVerschiebe(name, sichtbar[j], e.key === vor);
      },
    };
  }

  function klasse(name) {
    if (gezogen === name) return " wird-gezogen";
    if (gezogen && ziel?.name === name) return ziel.nachher ? " ziel-nach" : " ziel-vor";
    return "";
  }

  return { props, klasse };
}
