export function OpenCodeIcon({ size = 24, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 240 300"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
    >
      <mask id="oc-mask" style={{ maskType: "luminance" }} maskUnits="userSpaceOnUse" x="0" y="0" width="240" height="300">
        <path d="M240 0H0V300H240V0Z" fill="white" />
      </mask>
      <g mask="url(#oc-mask)">
        <path d="M180 240H60V120H180V240Z" fill="#CFCECD" />
        <path d="M180 60H60V240H180V60ZM240 300H0V0H240V300Z" fill="#211E1E" />
      </g>
    </svg>
  );
}
