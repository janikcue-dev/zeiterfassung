// Einstellungen für den Büro-Bereich – hier kannst du ohne Programmierkenntnisse anpassen.

// Mitarbeiter, die in der Wochenübersicht NICHT als Spalte erscheinen sollen
// (z. B. ehemalige Mitarbeiter, die noch als Auswahl in Notion stehen).
// Schreibweise genau wie in Notion, z. B. ["Max", "Azubi 2024"]
export const AUSGEBLENDETE_MITARBEITER = [];

// Hinweis "gleiche Baustelle, unterschiedliche Stunden" nur bei kleinen Unterschieden.
// Typischer Fehler: einer schreibt 0,5 h mehr auf als der Kollege. Große Unterschiede sind
// meist echt (einer war nur vormittags dort) und würden sonst ständig warnen.
// Wert in Stunden; null = bei jedem Unterschied warnen.
export const BAUSTELLEN_HINWEIS_BIS_STUNDEN = 1;
