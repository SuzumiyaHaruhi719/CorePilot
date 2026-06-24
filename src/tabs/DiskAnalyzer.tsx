import { motion } from "motion/react";
import { HardDrive, Plus, RefreshCw, RotateCw, Scan, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "../components/ui/Button";
import { Modal } from "../components/ui/Modal";
import { TabHeader } from "../components/ui/TabHeader";
import { ClickRipple } from "../components/ui/Ripple";
import { cn } from "../lib/cn";
import { formatBytes } from "../lib/format";
import { useT, useTf, tf } from "../lib/i18n";
import { api, type ScanProgress, type VolumeInfo } from "../lib/ipc";
import { useDiskScan } from "../store/diskScan";
import { DiskWorkspace } from "./disk/DiskWorkspace";

/**
 * Disk Space Analyzer — main-nav `disk` tab (spec §4).
 *
 * PHASE 5 wires the full multi-disk shell:
 *
 *  - **Zone A — picker (landing, no scans yet):** the volume list with multi-select
 *    + a Scan button; single-click a row to scan just that disk.
 *  - **Zone B — per-disk tab strip (once ≥1 scan exists):** a `SecondaryTabs`-style
 *    strip (`layoutId="disk-sec"`), one inner tab per scanned disk with a live
 *    progress % while scanning / total size when done, a leading **"+"** that
 *    reopens the picker as a `Modal` to add more disks, and a per-tab close (×).
 *    Switching inner tabs is O(1) — pure store read (the scan keeps running).
 *  - **Zone C — workspace:** the active disk's `DiskWorkspace` (treemap + drill +
 *    detail + toolbar), driven by the per-disk store view-state.
 *
 * Multi-disk start is concurrent: `disk_scan_start` spawns one dedicated owner
 * thread per requested disk; the coalesced `disk-scan://progress` listener (mounted
 * app-level in `useDiskScanEvents`) feeds per-disk progress into `diskScan.ts`.
 *
 * See docs/superpowers/specs/2026-06-23-disk-space-analyzer-design.md §4.
 */
export function DiskAnalyzer() {
  const t = useT();
  const order = useDiskScan((s) => s.order);
  const active = useDiskScan((s) => s.active);
  const setActive = useDiskScan((s) => s.setActive);
  const openDisks = useDiskScan((s) => s.openDisks);
  const closeDisk = useDiskScan((s) => s.closeDisk);

  const [volumes, setVolumes] = useState<VolumeInfo[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  // The "+" add-disk Modal (over the workspace). The landing picker is inline.
  const [pickerOpen, setPickerOpen] = useState(false);

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

  // Start the real backend scan engine: each requested disk gets its own dedicated
  // owner thread (O(1) kickoff). `disk_scan_start` returns immediately. We register
  // each as a per-disk tab in the store (concurrent multi-disk) and focus the first.
  const startScan = useCallback(
    (scanIds: string[]) => {
      if (scanIds.length === 0) return;
      void api.diskScanStart(scanIds).catch(() => {
        /* engine surfaces failures via the Error status + progress event. */
      });
      const disks = scanIds.map((id) => {
        const vol = (volumes ?? []).find((v) => v.scanId === id);
        // Thread the volume's used bytes so the tab + workspace can show a REAL
        // progress % (scanned alloc / used bytes) instead of an indeterminate "…".
        const usedBytes = vol ? Math.max(0, vol.total - vol.free) : 0;
        return { scanId: id, rootLabel: vol?.letter ?? vol?.root ?? id, usedBytes };
      });
      openDisks(disks);
      setSelected(new Set());
      setPickerOpen(false);
    },
    [volumes, openDisks],
  );

  // On mount (once, after volumes load):
  //  1. RESTORE — persisted disk tabs from a previous session have NO live
  //     backend scan (scans are in-memory and die with the process), so the
  //     treemap shows a dead, empty "暂无可显示的数据" tab. Re-scan them so
  //     reopening the Disk Analyzer lands on a FRESH live scan instead of a
  //     stale husk (this was the core "ui 用不了" — reopening showed empty tabs).
  //  2. DIRECTIVE — a fresh launch via COREPILOT_STARTUP=disk auto-scans the
  //     system drive (a hook for automated verification).
  const autoScanned = useRef(false);
  useEffect(() => {
    if (autoScanned.current || !volumes) return;
    autoScanned.current = true;
    void api.startupDirective().then((d) => {
      // DIRECTIVE (COREPILOT_STARTUP=disk): always start a FRESH scan of the
      // system drive — deterministic, ignores any stale persisted tabs.
      if (d && d.toLowerCase().startsWith("disk")) {
        const sys =
          volumes.find((v) => v.supported && (v.letter ?? "").toUpperCase().startsWith("C")) ??
          volumes.find((v) => v.supported);
        if (sys) {
          startScan([sys.scanId]);
          return;
        }
      }
      // NORMAL launch: re-scan persisted tabs (their in-memory backend scan died
      // on relaunch → empty "no data" husks), so reopening lands on a live scan.
      const restorable = order.filter((id) =>
        volumes.some((v) => v.scanId === id && v.supported),
      );
      if (restorable.length > 0) startScan(restorable);
    });
  }, [volumes, order, startScan]);

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

  // Close one disk tab: cancel + drop its backend tree, then drop the store tab
  // (which re-targets `active`). O(1) from the caller's view.
  const onCloseTab = useCallback(
    (scanId: string) => {
      void api.diskScanCancel(scanId).catch(() => undefined);
      closeDisk(scanId);
    },
    [closeDisk],
  );

  // Rescan the active disk: cancel-if-running + respawn (the store keeps the tab,
  // and the live poller picks the fresh tree up on the next generation).
  const onRescan = useCallback(() => {
    if (active) void api.diskScanStart([active]).catch(() => undefined);
  }, [active]);

  // Zone C (+ Zone B strip) once at least one scan exists.
  if (order.length > 0) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <DiskTabStrip
          order={order}
          active={active}
          onSelect={setActive}
          onClose={onCloseTab}
          onAdd={() => setPickerOpen(true)}
          onRescan={onRescan}
        />

        <div className="flex min-h-0 flex-1 flex-col">
          {active ? (
            <DiskWorkspace key={active} scanId={active} />
          ) : (
            <div className="grid h-full place-items-center text-[13px] text-muted">
              {tf("选择一个磁盘标签页", "Pick a disk tab")}
            </div>
          )}
        </div>

        {/* "+" add-disk picker, over the workspace. */}
        <Modal
          open={pickerOpen}
          onClose={() => setPickerOpen(false)}
          title={t("选择要扫描的磁盘")}
          footer={
            <>
              <Button variant="ghost" onClick={() => setPickerOpen(false)}>
                {t("取消")}
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
        >
          <DiskList
            volumes={volumes}
            selected={selected}
            onToggle={toggle}
            onScan={(id) => startScan([id])}
            loading={loading}
          />
        </Modal>
      </div>
    );
  }

  // Zone A — the landing picker.
  return (
    <div className="flex min-h-0 flex-1 flex-col">
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
        <DiskList
          volumes={volumes}
          selected={selected}
          onToggle={toggle}
          onScan={(id) => startScan([id])}
          loading={loading}
        />
      </div>
    </div>
  );
}

// --- per-disk tab strip (Zone B) -------------------------------------------------

interface DiskTabStripProps {
  order: string[];
  active: string | null;
  onSelect: (scanId: string) => void;
  onClose: (scanId: string) => void;
  onAdd: () => void;
  onRescan: () => void;
}

/**
 * `SecondaryTabs`-style per-disk strip (spec §4.2 Zone B) with the shared
 * `layoutId="disk-sec"` underline. Each tab shows a live progress % while
 * scanning / total size when done, plus a per-tab close (×). A leading "+" opens
 * the add-disk picker; the active tab gets a Rescan action.
 */
function DiskTabStrip({ order, active, onSelect, onClose, onAdd, onRescan }: DiskTabStripProps) {
  const tfL = useTf();
  return (
    <div className="flex items-center gap-1 border-b border-line px-4">
      <button
        type="button"
        onClick={onAdd}
        title={tfL("添加磁盘", "Add disk")}
        className="no-drag mr-1 grid size-7 place-items-center rounded-md border border-line bg-surface2 text-muted transition-colors hover:border-line-strong hover:bg-surface3 hover:text-ink"
      >
        <Plus size={14} />
      </button>

      <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
        {order.map((scanId) => (
          <DiskTab
            key={scanId}
            scanId={scanId}
            active={scanId === active}
            onSelect={() => onSelect(scanId)}
            onClose={() => onClose(scanId)}
          />
        ))}
      </div>

      {active && (
        <button
          type="button"
          onClick={onRescan}
          title={tfL("重新扫描", "Rescan")}
          className="no-drag ml-1 inline-flex items-center gap-1.5 rounded-md border border-line bg-surface2 px-2 py-1.5 text-[11.5px] text-muted transition-colors hover:border-line-strong hover:bg-surface3 hover:text-ink"
        >
          <RotateCw size={13} />
          {tfL("重扫", "Rescan")}
        </button>
      )}
    </div>
  );
}

interface DiskTabProps {
  scanId: string;
  active: boolean;
  onSelect: () => void;
  onClose: () => void;
}

function DiskTab({ scanId, active, onSelect, onClose }: DiskTabProps) {
  const view = useDiskScan((s) => s.views[scanId]);
  const progress = view?.progress ?? null;
  const label = view?.rootLabel ?? scanId;
  const usedBytes = view?.usedBytes ?? 0;
  const status = progress?.status ?? "scanning";
  const scanning = status === "scanning";
  const disconnected = progress?.disconnected ?? false;
  const pct = scanProgressPct(progress, usedBytes);

  return (
    <div
      className={cn(
        "no-drag group relative flex shrink-0 items-center gap-1.5 rounded-md py-2 pl-3 pr-1.5",
        active ? "text-ink" : "text-muted hover:text-ink",
      )}
    >
      <button
        type="button"
        onClick={onSelect}
        className="relative z-10 flex items-center gap-1.5 text-[12.5px] font-medium focus-visible:outline-none"
      >
        <span className="display tracking-wide">{label}</span>
        {scanning ? (
          // A real progress ring when the volume's used bytes are known; an
          // indeterminate pulse otherwise (Phase 6 threads usedBytes from the picker).
          <span className="inline-flex items-center gap-1">
            <ProgressRing pct={pct} />
            {pct != null && <span className="nums text-[10px] text-accent">{pct}%</span>}
          </span>
        ) : status === "done" ? (
          <span className="nums text-[10.5px] text-dim">
            {formatBytes(progress?.bytesAlloc ?? 0)}
          </span>
        ) : status === "error" ? (
          <span className="text-[10.5px] text-warn">
            {disconnected ? tf("已断开", "offline") : tf("错误", "error")}
          </span>
        ) : (
          <span className="text-[10.5px] text-dim">{tf("已取消", "cancelled")}</span>
        )}
      </button>

      <button
        type="button"
        onClick={onClose}
        title={tf("关闭", "Close")}
        aria-label={tf("关闭", "Close")}
        className="relative z-10 grid size-4 place-items-center rounded text-dim opacity-0 transition-opacity hover:text-ink group-hover:opacity-100"
      >
        <X size={12} />
      </button>

      {active && (
        <motion.span
          layoutId="disk-sec"
          className="absolute inset-x-2 bottom-0 h-0.5 rounded-full bg-accent glow-sm"
          transition={{ type: "spring", stiffness: 400, damping: 32 }}
        />
      )}
    </div>
  );
}

/** Scan completion % from scanned alloc bytes vs the disk's used bytes (Phase 6
 *  threads `usedBytes` from the picker). Returns null when no denominator is known
 *  (then the ring shows indeterminate). Clamped to [0,99] while scanning so it
 *  never claims 100% before the walk actually finishes. */
function scanProgressPct(p: ScanProgress | null, usedBytes: number): number | null {
  if (!p) return null;
  if (p.status === "done") return 100;
  if (p.status !== "scanning") return null;
  if (usedBytes <= 0) return null;
  return Math.min(99, Math.max(0, Math.round((p.bytesAlloc / usedBytes) * 100)));
}

/** Tiny inline SVG progress ring for the tab strip. `pct` null → indeterminate
 *  (a spinning arc). Honors reduce-motion: the indeterminate spin is CSS-driven
 *  via `animate-spin`, which the global `data-reduce-motion` block neuters. */
function ProgressRing({ pct }: { pct: number | null }) {
  const r = 6;
  const c = 2 * Math.PI * r;
  const dash = pct != null ? (Math.min(100, Math.max(0, pct)) / 100) * c : c * 0.28;
  return (
    <svg
      width={15}
      height={15}
      viewBox="0 0 16 16"
      className={pct == null ? "animate-spin text-accent" : "text-accent"}
      aria-hidden
    >
      <circle cx="8" cy="8" r={r} fill="none" stroke="currentColor" strokeWidth="2" opacity={0.2} />
      <circle
        cx="8"
        cy="8"
        r={r}
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeDasharray={`${dash} ${c}`}
        transform="rotate(-90 8 8)"
      />
    </svg>
  );
}

// --- volume list (shared by Zone A + the "+" Modal) ------------------------------

interface DiskListProps {
  volumes: VolumeInfo[] | null;
  selected: Set<string>;
  onToggle: (scanId: string) => void;
  onScan: (scanId: string) => void;
  loading: boolean;
}

function DiskList({ volumes, selected, onToggle, onScan, loading }: DiskListProps) {
  const t = useT();
  const scannable = (volumes ?? []).filter((v) => v.supported);
  return (
    <>
      {volumes !== null && scannable.length === 0 && !loading && (
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
            onToggle={() => onToggle(vol.scanId)}
            onScan={() => onScan(vol.scanId)}
          />
        ))}
      </div>
    </>
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
