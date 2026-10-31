import { cn } from "@/lib/utils";

/**
 * Official Jaggy mark — geometric jagged logo.
 * White/ice mark on dark UI; matches the sharp brand identity.
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
    className={cn("inline-flex shrink-0 items-center gap-3", className)}
    aria-label="Jaggy Analyser"
    role="img"
  >
    <span
      className={cn(
        "relative inline-flex shrink-0 items-center justify-center overflow-hidden",
        "rounded-md bg-transparent",
      )}
      style={{ width: size, height: size }}
    >
      <img
        src={`${import.meta.env.BASE_URL}logo-jaggy.png`}
        alt=""
        width={size}
        height={size}
        className="block h-full w-full object-contain"
        onError={(e) => {
          (e.currentTarget as HTMLImageElement).style.display = "none";
        }}
      />
    </span>
    {withWordmark && (
      <span className="flex flex-col leading-none select-none">
        <span className="text-[15px] font-bold tracking-[0.2em] text-foreground">
          JAGGY
        </span>
        <span className="mt-1 text-[9px] font-semibold tracking-[0.28em] text-primary uppercase">
          Analyser
        </span>
      </span>
    )}
  </span>
);

export default BrandLogo;
