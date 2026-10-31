import { cn } from "@/lib/utils";

/**
 * Official Jaggy mark — uses the branded jagged logo asset.
 * Falls back to a compact monogram if the image fails to load.
 */
export const BrandLogo = ({
  className,
  size = 40,
  withWordmark = false,
}: {
  className?: string;
  size?: number;
  withWordmark?: boolean;
}) => (
  <span
    className={cn("inline-flex shrink-0 items-center gap-2.5", className)}
    aria-label="Jaggy Analyser"
    role="img"
  >
    <span
      className={cn(
        "relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-xl",
        "bg-background/80 shadow-[0_0_0_1px_hsl(var(--border)/0.55),0_8px_24px_-12px_rgba(0,0,0,0.55)]",
      )}
      style={{ width: size, height: size }}
    >
      <img
        src={`${import.meta.env.BASE_URL}logo-jaggy.png`}
        alt=""
        width={size}
        height={size}
        className="block h-full w-full object-contain p-1"
        onError={(e) => {
          // Hide broken image; parent still reserves space
          (e.currentTarget as HTMLImageElement).style.display = "none";
        }}
      />
    </span>
    {withWordmark && (
      <span className="flex flex-col leading-none">
        <span className="text-[15px] font-semibold tracking-[0.14em] text-foreground">
          JAGGY
        </span>
        <span className="mt-0.5 text-[10px] font-medium tracking-[0.22em] text-muted-foreground uppercase">
          Analyser
        </span>
      </span>
    )}
  </span>
);

export default BrandLogo;
