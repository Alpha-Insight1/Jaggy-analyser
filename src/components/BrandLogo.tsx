import { cn } from "@/lib/utils";

/**
 * Professional Jaggy Analyser mark.
 * Inline SVG so the logo still shows if /logo.svg fails to load (CDN/path issues).
 */
export const BrandLogo = ({
  className,
  size = 36,
}: {
  className?: string;
  size?: number;
}) => (
  <span
    className={cn(
      "inline-flex shrink-0 items-center justify-center overflow-hidden rounded-lg",
      "shadow-[0_0_0_1px_hsl(var(--border)/0.45)]",
      className,
    )}
    style={{ width: size, height: size }}
    aria-label="Jaggy Analyser"
    role="img"
  >
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 64 64"
      width={size}
      height={size}
      className="block"
      aria-hidden
    >
      <defs>
        <linearGradient id="jaggyGold" x1="8" y1="8" x2="56" y2="56" gradientUnits="userSpaceOnUse">
          <stop stopColor="#E8C36A" />
          <stop offset="1" stopColor="#C9A227" />
        </linearGradient>
      </defs>
      <rect width="64" height="64" rx="14" fill="#0B0D12" />
      <rect
        x="1.5"
        y="1.5"
        width="61"
        height="61"
        rx="12.5"
        stroke="url(#jaggyGold)"
        strokeWidth="1.5"
        opacity="0.9"
        fill="none"
      />
      {/* J */}
      <path
        d="M18 42 V22 h6.5 c6.2 0 10.2 3.2 10.2 9.2 0 6.1-4 9.3-10.2 9.3H18z"
        fill="url(#jaggyGold)"
      />
      <path
        d="M24.5 27.2h0.2c2.6 0 4.2 1.4 4.2 3.9s-1.6 4-4.2 4h-0.2v-7.9z"
        fill="#0B0D12"
      />
      {/* A */}
      <path
        d="M38 22 h6.2 v14.2 c0 4.6 2.4 6.6 6.3 6.6.6 0 1.3-.05 1.9-.15v5.1c-.8.2-1.8.3-2.9.3-7.1 0-11.5-3.9-11.5-11.7V22z"
        fill="url(#jaggyGold)"
      />
      {/* chart accent */}
      <path
        d="M14 48 L24 40 L32 44 L42 32 L50 36"
        stroke="url(#jaggyGold)"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity="0.55"
        fill="none"
      />
    </svg>
  </span>
);

export default BrandLogo;
