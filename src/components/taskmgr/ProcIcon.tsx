import { Box } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../../lib/ipc";

/**
 * Module-level icon cache shared by every <ProcIcon>. Icons are stable per exe
 * path, so once resolved (to a data URL or `null` for "no icon") we never ask
 * the backend again. In-flight requests are deduped so N rows of the same exe
 * trigger one IPC call.
 */
const ICON_CACHE = new Map<string, string | null>();
const INFLIGHT = new Map<string, Promise<string | null>>();

function loadIcon(exePath: string): Promise<string | null> {
  const cached = ICON_CACHE.get(exePath);
  if (cached !== undefined) return Promise.resolve(cached);
  const existing = INFLIGHT.get(exePath);
  if (existing) return existing;
  const req = api
    .processIcon(exePath)
    .then((url) => {
      const value = url ?? null;
      ICON_CACHE.set(exePath, value);
      INFLIGHT.delete(exePath);
      return value;
    })
    .catch(() => {
      ICON_CACHE.set(exePath, null);
      INFLIGHT.delete(exePath);
      return null;
    });
  INFLIGHT.set(exePath, req);
  return req;
}

interface ProcIconProps {
  /** Full exe path; `null`/empty renders the generic fallback glyph. */
  exePath: string | null | undefined;
  /** Pixel size of the rendered icon box. */
  size?: number;
}

/**
 * Renders a process's real shell icon (fetched lazily from the backend and
 * cached per exe path). Falls back to a neutral generic glyph while loading or
 * when the executable exposes no icon.
 */
export function ProcIcon({ exePath, size = 16 }: ProcIconProps) {
  const [src, setSrc] = useState<string | null>(() =>
    exePath ? (ICON_CACHE.get(exePath) ?? null) : null,
  );

  useEffect(() => {
    if (!exePath) {
      setSrc(null);
      return;
    }
    let alive = true;
    void loadIcon(exePath).then((url) => {
      if (alive) setSrc(url);
    });
    return () => {
      alive = false;
    };
  }, [exePath]);

  if (src) {
    return (
      <img
        src={src}
        alt=""
        width={size}
        height={size}
        className="shrink-0 rounded-[3px] object-contain"
        style={{ width: size, height: size }}
        draggable={false}
      />
    );
  }

  return (
    <span
      className="grid shrink-0 place-items-center rounded-[3px] text-dim/70"
      style={{ width: size, height: size }}
    >
      <Box size={Math.round(size * 0.8)} strokeWidth={1.75} />
    </span>
  );
}
