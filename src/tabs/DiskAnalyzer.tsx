import { motion } from "motion/react";
import { HardDrive, RefreshCw, Scan } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Button } from "../components/ui/Button";
import { TabHeader } from "../components/ui/TabHeader";
import { ClickRipple } from "../components/ui/Ripple";
import { cn } from "../lib/cn";
import { formatBytes } from "../lib/format";
import { useT, tf } from "../lib/i18n";
import { api, type VolumeInfo } from "../lib/ipc";

/**
 * Disk Space Analyzer — main-nav `disk` tab.
 *
 * PHASE 0 (Skeleton & nav) ships ONLY Zone A: the disk-picker landing. It lists
 * fixed + removable volumes (via `disk_list_volumes`) with size/usage, a
 * multi-select checkbox, and a primary Scan button. Single-click on a row body
 * scans just that disk. The actual scan engine, per-disk `SecondaryTabs`, the
 * treemap, and the `diskScan.ts` store arrive in Phase 1+; `startScan` is a stub
 * here so the picker interaction is complete but inert.
 *
 * See docs/superpowers/specs/2026-06-23-disk-space-analyzer-design.md §4.2.
 */
export function DiskAnalyzer() {
  const t = useT();
  const [volumes, setVolumes] = useState<VolumeInfo[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(() => {
    setLoading(true);
    api
      .diskListVolumes()
      .then((vols) => setVolumes(vols))
      .catch(() => setVolumes([]))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Phase 1 wires the real backend scan + per-disk tab strip here. For Phase 0
  // this is an inert stub so the picker interaction is fully present but no scan
  // runs yet.
  const startScan = useCallback((_scanIds: string[]) => {
    // intentionally no-op until Phase 1 (backend scan engine core).
  }, []);

  const toggle = useCallback((scanId: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(scanId)) next.delete(scanId);
      else next.add(scanId);
      return next;
    });
  }, []);

  const scannable = (volumes ?? []).filter((v) => v.supported);
  const selectedScannable = scannable.filter((v) => selected.has(v.scanId)).map((v) => v.scanId);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <TabHeader
        icon={HardDrive}
        title="磁盘空间分析"
        subtitle="选择磁盘后扫描,以树图查看占用空间"
        actions={
          <>
            <Button variant="ghost" onClick={refresh} ariaLabel={t("刷新")}>
              <RefreshCw size={14} className={loading ? "animate-spin" : undefined} />
              {t("刷新")}
            </Button>
            <Button
              variant="primary"
              disabled={selectedScannable.length === 0}
              onClick={() => startScan(selectedScannable)}
            >
              <Scan size={14} />
              {t("扫描")}
            </Button>
          </>
        }
      />

      <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6">
        <p className="mb-3 text-[12.5px] text-muted">{t("选择要扫描的磁盘")}</p>

        {volumes !== null && scannable.length === 0 && (
          <div className="grid place-items-center rounded-xl border border-line bg-surface2/40 py-16 text-[13px] text-muted">
            {t("未检测到可扫描的磁盘")}
          </div>
        )}

        <div className="flex flex-col gap-2.5">
          {(volumes ?? []).map((vol) => (
            <VolumeRow
              key={vol.scanId}
              vol={vol}
              checked={selected.has(vol.scanId)}
              onToggle={() => toggle(vol.scanId)}
              onScan={() => startScan([vol.scanId])}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

interface VolumeRowProps {
  vol: VolumeInfo;
  checked: boolean;
  onToggle: () => void;
  onScan: () => void;
}

function VolumeRow({ vol, checked, onToggle, onScan }: VolumeRowProps) {
  const t = useT();
  const used = Math.max(0, vol.total - vol.free);
  const usedPct = vol.total > 0 ? Math.min(100, (used / vol.total) * 100) : 0;
  const nearFull = usedPct > 85;

  return (
    <div
      className={cn(
        "group relative flex items-center gap-4 rounded-xl border border-line bg-surface2 px-4 py-3.5 transition-colors",
        vol.supported ? "hover:border-line-strong hover:bg-surface3" : "opacity-45",
      )}
    >
      {/* Multi-select checkbox (leading). */}
      <input
        type="checkbox"
        checked={checked}
        disabled={!vol.supported}
        onChange={onToggle}
        aria-label={`${vol.letter} ${tf("已选", "select")}`}
        className="size-4 shrink-0 cursor-pointer accent-accent disabled:cursor-not-allowed"
      />

      {/* Row body — single-click scans just this disk. */}
      <button
        type="button"
        disabled={!vol.supported}
        onClick={onScan}
        className={cn(
          "no-drag relative flex min-w-0 flex-1 items-center gap-4 overflow-hidden text-left",
          vol.supported ? "cursor-pointer" : "cursor-not-allowed",
        )}
      >
        <motion.div
          whileHover={vol.supported ? { scale: 1.06 } : undefined}
          className="grid size-11 shrink-0 place-items-center rounded-lg border border-line bg-base/40 text-accent"
        >
          <HardDrive size={20} strokeWidth={2.1} />
        </motion.div>

        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="display text-[15px] font-bold tracking-wide text-ink">{vol.letter}</span>
            {vol.label && <span className="truncate text-[12.5px] text-muted">{vol.label}</span>}
            {vol.fileSystem && (
              <span className="rounded border border-line bg-base/40 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-dim">
                {vol.fileSystem}
              </span>
            )}
          </div>

          {/* Usage bar — warn-tint when >85% full. */}
          <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-surface3">
            <motion.div
              initial={{ width: 0 }}
              animate={{ width: `${usedPct}%` }}
              transition={{ type: "spring", stiffness: 160, damping: 26 }}
              className={cn("h-full rounded-full", nearFull ? "bg-warn" : "grad-accent")}
            />
          </div>

          <div className="mt-1.5 flex items-center gap-3 text-[11.5px] text-muted">
            {vol.supported ? (
              <>
                <span>
                  {t("已用")} <span className="nums text-ink">{formatBytes(used)}</span>
                </span>
                <span className="text-dim">/</span>
                <span>
                  {t("可用")} <span className="nums text-ink">{formatBytes(vol.free)}</span>
                </span>
                <span className="text-dim">·</span>
                <span className="nums">{formatBytes(vol.total)}</span>
              </>
            ) : (
              <span className="text-dim">{t("无法读取")}</span>
            )}
          </div>
        </div>
        {vol.supported && <ClickRipple />}
      </button>
    </div>
  );
}
