import { baustellenFarbe, fmtStd } from "./logik.js";

// Ein Balken pro Baustelle: kräftig = Gesellen, im selben Farbton blasser = Helfer/Azubis.
// Beschriftung sitzt über dem jeweiligen Balkenstück.
export default function BaustellenBalken({ baustellen }) {
  const max = Math.max(1, ...baustellen.map((b) => b.stunden));
  const mitHelfer = baustellen.some((b) => b.helfer > 0);
  return (
    <div className="bb-liste">
      {mitHelfer && (
        <div className="bb-legende">
          <span><span className="bb-muster voll" />Gesellen</span>
          <span><span className="bb-muster blass" />Helfer &amp; Azubis</span>
        </div>
      )}
      {baustellen.map((b) => {
        const farbe = baustellenFarbe(b.name);
        const pg = (b.gesellen / max) * 100;
        const ph = (b.helfer / max) * 100;
        return (
          <div key={b.name} className="bb-zeile">
            <div className="bb-kopf">
              <span className="bb-gesellen" style={{ width: `max(${pg}%, 260px)` }}>
                <span className="bb-name">{b.name}</span>
                {b.gesellen > 0 && <span className="bb-std" style={{ color: farbe }}>{fmtStd(b.gesellen)} h</span>}
              </span>
              {b.helfer > 0 && (
                <span className="bb-helfer" style={{ color: farbe, boxShadow: `inset 1.5px 0 0 ${farbe}40` }}>
                  <span className="bb-helfer-label">Helfer</span>
                  <span className="bb-std klein">{fmtStd(b.helfer)} h</span>
                </span>
              )}
              <span className="bb-gesamt">{fmtStd(b.stunden)} h</span>
            </div>
            <div className="bb-spur">
              <div style={{ width: `${pg}%`, background: farbe }} />
              <div style={{ width: `${ph}%`, background: `${farbe}47` }} />
            </div>
            <div className="bb-leute">
              {b.gesellenNamen.join(", ")}
              {b.helferNamen.length > 0 && <>{b.gesellenNamen.length ? " · " : ""}Helfer: {b.helferNamen.join(", ")}</>}
            </div>
          </div>
        );
      })}
    </div>
  );
}
