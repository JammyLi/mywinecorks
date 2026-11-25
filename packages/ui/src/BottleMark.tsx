/** Brand bottle mark (logo set 1d), drawn from the official favicon geometry. */
export function BottleMark({ size = 32, dark = true }: { size?: number; dark?: boolean }) {
  const stroke = dark ? '#d4a560' : '#b68235';
  return (
    <svg width={size} height={size} viewBox="0 0 170 170" aria-hidden="true">
      <g transform="translate(85,85) rotate(45) translate(-35,-88)">
        <path
          d="M30,34 L30,57 C30,67 16,71 16,85 L16,160 Q16,164 20,164 L50,164 Q54,164 54,160 L54,85 C54,71 40,67 40,57 L40,34 Z"
          fill="#5e1a24" stroke={stroke} strokeWidth="6" strokeLinejoin="round" />
        <rect x="28.5" y="30" width="13" height="5" rx="1" fill="#5e1a24" stroke={stroke} strokeWidth="6" />
        <rect x="31" y="10" width="8" height="20" rx="1.5" fill="#e6d2ac" stroke={stroke} strokeWidth="6" />
        <rect x="16" y="104" width="38" height="30" fill={dark ? '#e6e0d6' : '#f3f2f2'} stroke={stroke} strokeWidth="4" />
      </g>
    </svg>
  );
}

/** "My Wine / Corks" wordmark as in the lockup. */
export function Wordmark({ tagline }: { tagline?: string }) {
  return (
    <div className="word">
      <i>My Wine</i>Corks
      {tagline && <div className="tagline" style={{ marginTop: 10 }}>{tagline}</div>}
    </div>
  );
}
