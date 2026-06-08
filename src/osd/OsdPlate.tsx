import { cn } from "../lib/cn";
import { osdCategoryColor, osdPlateAccent } from "../lib/osdPalette";
import { OSD_CATEGORY_ORDER, OSD_METRICS, type OsdCategory, type OsdData } from "../lib/osd";

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
}

export function OsdPlate({ metrics, style, scale, opacity, rounded, data }: OsdPlateProps) {
  const enabled = new Set(metrics);
  const groups = OSD_CATEGORY_ORDER.map((cat) => ({
    cat,
    items: OSD_METRICS.filter((m) => m.cat === cat && enabled.has(m.key)),
  })).filter((g) => g.items.length > 0);

  const vertical = style === "vertical";

  return (
    <div
      className={cn(
        "inline-flex font-semibold leading-none text-white",
        vertical ? "flex-col items-start gap-1.5" : "flex-nowrap items-center gap-x-3 gap-y-1",
        rounded ? "rounded-lg" : "rounded-[3px]",
      )}
      style={{
        // Lay out at the plate's natural content size so the overlay window
        // (which is sized from getBoundingClientRect) fits it exactly and the
        // horizontal row never wraps inside the tiny initial window.
        width: "max-content",
        maxWidth: "none",
        whiteSpace: "nowrap",
        fontSize: `${Math.round(13 * scale)}px`,
        background: `rgba(6, 9, 16, ${opacity})`,
        padding: `${Math.round(6 * scale)}px ${Math.round(10 * scale)}px`,
        textShadow: "0 1px 3px rgba(0,0,0,0.92)",
        // Themed accent edge (CP2077 cyan/yellow, terminal green, …) so the plate
        // reads as the active theme instead of a flat black slab. ~35% alpha keeps
        // it subtle; the window is content-sized so an outer glow would be clipped.
        border: opacity > 0.05 ? `1px solid ${osdPlateAccent()}59` : "none",
      }}
    >
      {groups.map((g) => (
        <div key={g.cat} className={cn("flex items-center gap-1.5", vertical && "w-full")}>
          <span className="nums font-bold uppercase tracking-wide" style={{ color: osdCategoryColor(g.cat) }}>
            {CAT_LABEL[g.cat]}
          </span>
          {g.items.map((def) => (
            <span key={def.key} className="nums tabular-nums font-semibold text-white/95">
              {def.value(data) ?? "—"}
            </span>
          ))}
        </div>
      ))}
      {groups.length === 0 && <span className="nums text-white/70">CorePilot OSD</span>}
    </div>
  );
}
