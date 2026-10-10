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
