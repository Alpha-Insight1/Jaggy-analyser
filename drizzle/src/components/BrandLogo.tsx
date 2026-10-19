import { cn } from "@/lib/utils";

/** Professional Jaggy Analyser mark — gold monogram on dark tile. */
export const BrandLogo = ({
  className,
  size = 36,
}: {
  className?: string;
  size?: number;
}) => (
  <img
    src={`${import.meta.env.BASE_URL}logo.svg`}
    alt="Jaggy Analyser"
    width={size}
    height={size}
    className={cn("rounded-lg shadow-[0_0_0_1px_hsl(var(--border)/0.4)]", className)}
    draggable={false}
  />
);

export default BrandLogo;
