import { useEffect, useState } from "react";

// Verbindung zu /api/buero – das Passwort geht bei jedem Aufruf im Header mit.

const PASSWORT_KEY = "buero_passwort";

export function gespeichertesPasswort() {
  try {
    return localStorage.getItem(PASSWORT_KEY) || "";
  } catch {
    return "";
  }
}

export function merkePasswort(passwort) {
  try {
    if (passwort) localStorage.setItem(PASSWORT_KEY, passwort);
    else localStorage.removeItem(PASSWORT_KEY);
  } catch {
    /* privates Fenster o. Ä. – dann eben ohne Merken */
  }
}

export class NichtAngemeldet extends Error {}

export async function bueroApi(action, daten, passwort) {
  let res;
  try {
    res = await fetch("/api/buero", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // encodeURIComponent, damit auch Umlaute im Passwort funktionieren
        "x-buero-passwort": encodeURIComponent(passwort || ""),
      },
      body: JSON.stringify({ action, ...(daten || {}) }),
    });
  } catch {
    throw new Error("Keine Verbindung – bitte Internet prüfen");
  }
  const json = await res.json().catch(() => ({}));
  if (res.status === 401) throw new NichtAngemeldet(json.message || "Passwort falsch");
  if (!res.ok) throw new Error(json.message || `Fehler ${res.status}`);
  return json;
}

// Lädt Arbeitstage + Projekte für einen Zeitraum. neuLaden() holt die Daten erneut.
export function useDaten(api, von, bis) {
  const [version, setVersion] = useState(0);
  const [stand, setStand] = useState({ zeitraum: null, version: -1, daten: null, fehler: null });
  const zeitraum = `${von}|${bis}`;

  useEffect(() => {
    let aktiv = true;
    api("daten", { von, bis })
      .then((daten) => aktiv && setStand({ zeitraum, version, daten, fehler: null }))
      .catch((e) => aktiv && setStand((s) => ({
        zeitraum,
        version,
        daten: s.zeitraum === zeitraum ? s.daten : null,
        fehler: e.message,
      })));
    return () => {
      aktiv = false;
    };
  }, [api, von, bis, zeitraum, version]);

  const passend = stand.zeitraum === zeitraum;
  return {
    daten: passend ? stand.daten : null,
    fehler: passend ? stand.fehler : null,
    laedt: !passend || stand.version !== version,
    neuLaden: () => setVersion((v) => v + 1),
  };
}
