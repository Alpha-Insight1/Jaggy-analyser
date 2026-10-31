import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

interface Props {
  icon: LucideIcon;
  title: string;
  subtitle?: string;
  right?: ReactNode;
}

export const SectionHeader = ({ icon: Icon, title, subtitle, right }: Props) => (
  <div className="mb-4 flex items-end justify-between gap-4 border-b border-border/50 pb-3">
    <div className="flex items-center gap-3">
      <div className="flex h-8 w-8 items-center justify-center rounded-md border border-primary/20 bg-primary/5">
        <Icon className="h-4 w-4 text-primary" />
      </div>
      <div>
        <h2 className="text-sm font-semibold tracking-tight">{title}</h2>
        {subtitle && <p className="text-xs text-muted-foreground">{subtitle}</p>}
      </div>
    </div>
    {right && <div className="flex items-center gap-2 text-xs text-muted-foreground">{right}</div>}
  </div>
);
