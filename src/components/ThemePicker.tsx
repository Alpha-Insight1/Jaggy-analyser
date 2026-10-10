import { useEffect, useState } from "react";
import { Palette, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

const STORAGE_KEY = "smc-bg-theme";

// Each preset overrides the `--background` HSL token. Everything else in
// the design system is derived semantically, so contrast stays correct.
type Preset = {
  id: string;
  label: string;
  hsl: string | null; // null = restore default from index.css
  swatch: string;     // CSS color for the swatch dot
};

const PRESETS: Preset[] = [
  { id: "default",  label: "Default Midnight", hsl: null,            swatch: "hsl(224 32% 5%)" },
  { id: "obsidian", label: "Obsidian",         hsl: "0 0% 4%",       swatch: "hsl(0 0% 4%)" },
  { id: "ink",      label: "Deep Ink",         hsl: "222 47% 7%",    swatch: "hsl(222 47% 7%)" },
  { id: "navy",     label: "Royal Navy",       hsl: "220 60% 8%",    swatch: "hsl(220 60% 8%)" },
  { id: "forest",   label: "Forest",           hsl: "150 30% 6%",    swatch: "hsl(150 30% 6%)" },
  { id: "wine",     label: "Wine",             hsl: "350 35% 7%",    swatch: "hsl(350 35% 7%)" },
  { id: "slate",    label: "Slate",            hsl: "215 18% 12%",   swatch: "hsl(215 18% 12%)" },
  { id: "charcoal", label: "Charcoal",         hsl: "30 6% 9%",      swatch: "hsl(30 6% 9%)" },
  { id: "paper",    label: "Paper (Light)",    hsl: "40 25% 96%",    swatch: "hsl(40 25% 96%)" },
];

function applyTheme(p: Preset) {
  const root = document.documentElement;
  if (p.hsl) {
    root.style.setProperty("--background", p.hsl);
    // For light "paper", flip foreground for legibility
    if (p.id === "paper") {
      root.style.setProperty("--foreground", "224 32% 8%");
    } else {
      root.style.removeProperty("--foreground");
    }
  } else {
    root.style.removeProperty("--background");
    root.style.removeProperty("--foreground");
  }
}

export const ThemePicker = () => {
  const [active, setActive] = useState<string>("default");

  useEffect(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    const preset = PRESETS.find((p) => p.id === saved) ?? PRESETS[0];
    setActive(preset.id);
    applyTheme(preset);
  }, []);

  const choose = (p: Preset) => {
    setActive(p.id);
    localStorage.setItem(STORAGE_KEY, p.id);
    applyTheme(p);
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm" variant="outline" className="gap-2" title="Background theme">
          <Palette className="h-4 w-4" />
          <span className="hidden sm:inline">Theme</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel>Background</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {PRESETS.map((p) => (
          <DropdownMenuItem
            key={p.id}
            onClick={() => choose(p)}
            className="flex items-center gap-3 cursor-pointer"
          >
            <span
              className="h-4 w-4 rounded-full border border-border/60 shrink-0"
              style={{ background: p.swatch }}
            />
            <span className="flex-1">{p.label}</span>
            {active === p.id && <Check className="h-4 w-4 text-primary" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
};
