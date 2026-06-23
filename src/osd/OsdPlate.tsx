import { cn } from "../lib/cn";
import { osdCategoryColor, osdPlateAccent } from "../lib/osdPalette";
import { OSD_CATEGORY_ORDER, OSD_METRICS, type OsdCategory, type OsdData } from "../lib/osd";
import { rawOf, stateOf, thresholdKind } from "../lib/osdThresholds";

/** The metrics plate, shared by the live overlay window and the config preview.
 *  Metrics are grouped strictly by category (one group per device, in a fixed
 *  order) so e.g. all GPU readings stay in a single "GPU" group regardless of
 *  the order they were enabled. */

// Metric label colors come from the per-theme OSD palette (osdPalette.ts) — the
// SAME source the native injected overlay uses, so every OSD surface matches the
// active theme (e.g. cyberpunk = yellow + electric cyan/blue, never green).
const CAT_LABEL: Record<OsdCategory, string> = {
  fps: "FPS",
  cpu: "CPU",
  gpu: "GPU",
  mem: "RAM",
  disk: "DISK",
  net: "NET",
};

export interface OsdPlateProps {
  metrics: string[];
  style: "horizontal" | "vertical";
  scale: number;
  opacity: number;
  rounded: boolean;
  data: OsdData;
  /** Render in taskbar-dock mode (lets the color skin engage). Purely additive:
   *  when false the plate renders byte-identical to before. */
  taskbar?: boolean;
  /** Master switch for the taskbar color skin (solid bg + label/value colors +
   *  threshold-driven value states). Only honored when `taskbar` is also true. */
  tbColorsEnabled?: boolean;
  tbBg?: string;
  tbLabel?: string;
  tbSafe?: string;
  tbWarn?: string;
  tbCrit?: string;
  tbWarnLoad?: number;
  tbCritLoad?: number;
  tbWarnTemp?: number;
  tbCritTemp?: number;
}

export function OsdPlate({
  metrics,
  style,
  scale,
  opacity,
  rounded,
  data,
  taskbar = false,
  tbColorsEnabled = false,
  tbBg = "#D2D2D2",
  tbLabel = "#141414",
  tbSafe = "#008040",
  tbWarn = "#B57500",
  tbCrit = "#C03030",
  tbWarnLoad = 60,
  tbCritLoad = 85,
  tbWarnTemp = 50,
  tbCritTemp = 70,
}: OsdPlateProps) {
  const enabled = new Set(metrics);
  const groups = OSD_CATEGORY_ORDER.map((cat) => ({
    cat,
    items: OSD_METRICS.filter((m) => m.cat === cat && enabled.has(m.key)),
  })).filter((g) => g.items.length > 0);

  const vertical = style === "vertical";
  // The taskbar color skin is fully gated behind `taskbar && tbColorsEnabled`; in
  // every other mode (corners, free, taskbar-with-skin-off) the original
  // themed/glass look renders unchanged.
  const skin = taskbar && tbColorsEnabled;

  /** Threshold-driven value color for a metric key in the skinned taskbar plate.
   *  Load/temp metrics map their state (safe/warn/crit) to the configured colors;
   *  metrics with no threshold kind always render in the safe color. */
  const valueColor = (key: string): string => {
    const kind = thresholdKind(key);
    if (kind === null) return tbSafe;
    const raw = rawOf(key, data);
    const st =
      kind === "temp"
        ? stateOf(raw, tbWarnTemp, tbCritTemp)
        : stateOf(raw, tbWarnLoad, tbCritLoad);
    return st === 2 ? tbCrit : st === 1 ? tbWarn : tbSafe;
  };

  return (
    <div
      className={cn(
        "inline-flex font-semibold leading-none text-white",
        vertical ? "flex-col items-start gap-1.5" : "flex-nowrap items-center gap-x-3 gap-y-1",
        skin ? "rounded-none" : rounded ? "rounded-lg" : "rounded-[3px]",
      )}
      style={{
        // Lay out at the plate's natural content size so the overlay window
        // (which is sized from getBoundingClientRect) fits it exactly and the
        // horizontal row never wraps inside the tiny initial window.
        width: "max-content",
        maxWidth: "none",
        whiteSpace: "nowrap",
        fontSize: `${Math.round(13 * scale)}px`,
        // Taskbar skin: a flat, opaque block color-matched to the bar (no glass
        // translucency). Otherwise the original glass bg driven by `opacity`.
        background: skin ? tbBg : `rgba(6, 9, 16, ${opacity})`,
        padding: `${Math.round(6 * scale)}px ${Math.round(10 * scale)}px`,
        // Flat skin: no drop-shadow on text (it sits on a solid light block).
        textShadow: skin ? "none" : "0 1px 3px rgba(0,0,0,0.92)",
        // Themed accent edge (CP2077 cyan/yellow, terminal green, …) so the plate
        // reads as the active theme instead of a flat black slab. ~35% alpha keeps
        // it subtle; the window is content-sized so an outer glow would be clipped.
        // The flat taskbar skin has no border (it blends into the bar).
        border: skin ? "none" : opacity > 0.05 ? `1px solid ${osdPlateAccent()}59` : "none",
      }}
    >
      {groups.map((g) => (
        <div key={g.cat} className={cn("flex items-center gap-1.5", vertical && "w-full")}>
          <span
            className="nums font-bold uppercase tracking-wide"
            style={{ color: skin ? tbLabel : osdCategoryColor(g.cat) }}
          >
            {CAT_LABEL[g.cat]}
          </span>
          {g.items.map((def) => (
            <span
              key={def.key}
              className={cn("nums tabular-nums font-semibold", !skin && "text-white/95")}
              style={skin ? { color: valueColor(def.key) } : undefined}
            >
              {def.value(data) ?? "—"}
            </span>
          ))}
        </div>
      ))}
      {groups.length === 0 &&
        (skin ? (
          <span className="nums" style={{ color: tbLabel }}>CorePilot OSD</span>
        ) : (
          <span className="nums text-white/70">CorePilot OSD</span>
        ))}
    </div>
  );
}
