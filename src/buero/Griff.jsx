// Kleines Griff-Symbol: zeigt an, dass man das Element ziehen kann
export default function Griff() {
  return (
    <svg className="b-griff" width="10" height="16" viewBox="0 0 10 16" aria-hidden="true">
      {[3, 8, 13].map((y) => (
        <g key={y}>
          <circle cx="2.5" cy={y} r="1.4" />
          <circle cx="7.5" cy={y} r="1.4" />
        </g>
      ))}
    </svg>
  );
}
