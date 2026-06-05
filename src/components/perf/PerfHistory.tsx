import { AnimatePresence, motion } from "motion/react";
import { Gamepad2, Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { cn } from "../../lib/cn";
import { hoverPop } from "../../lib/motion";
import { gameDisplayName, type PerfSession } from "../../lib/perf";
import { usePerfHistory } from "../../store/perfHistory";
import { Button } from "../ui/Button";
import { Modal } from "../ui/Modal";
import { PerfReport } from "./PerfReport";
import { ProcIcon } from "../taskmgr/ProcIcon";

const DASH = "—";

/** mm:ss for a duration in seconds. */
function fmtDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** Localized "M/D HH:mm" for an epoch-ms timestamp (compact, for cards). */
function fmtCardDate(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function Badge({ label, value, hue }: { label: string; value: string; hue: number }) {
  return (
    <span
      className="nums inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10.5px] font-medium"
      style={{
        background: `oklch(70% 0.13 ${hue} / 0.14)`,
        color: `oklch(82% 0.13 ${hue})`,
      }}
    >
      <span className="text-dim">{label}</span>
      {value}
    </span>
  );
}

interface SessionCardProps {
  session: PerfSession;
  active: boolean;
  onSelect: () => void;
  onDelete: () => void;
}

function SessionCard({ session, active, onSelect, onDelete }: SessionCardProps) {
  const { summary } = session;
  return (
    <motion.button
      layout
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.96 }}
      whileHover={{ y: -2 }}
      transition={hoverPop}
      onClick={onSelect}
      className={cn(
        "no-drag group relative w-full overflow-hidden rounded-xl border px-3 py-2.5 text-left transition-colors",
        active ? "border-accent/50 bg-accent/10 glow-sm" : "border-line bg-surface2/50 hover:bg-surface3",
      )}
    >
      <div className="flex items-start gap-2.5">
        <span
          className={cn(
            "mt-0.5 grid h-8 w-8 shrink-0 place-items-center overflow-hidden rounded-lg",
            active ? "bg-accent/20 text-accent-bright" : "bg-surface3 text-dim",
          )}
        >
          {session.path ? <ProcIcon exePath={session.path} size={18} /> : <Gamepad2 size={16} />}
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate pr-5 text-[12.5px] font-medium text-ink" title={gameDisplayName(session.exe)}>
            {gameDisplayName(session.exe)}
          </div>
          <div className="nums mt-0.5 text-[10.5px] text-dim">
            {fmtCardDate(session.startedAt)} · {fmtDuration(session.durationSec)}
          </div>
          <div className="mt-1.5 flex flex-wrap gap-1">
            <Badge label="平均" value={summary.avgFps != null ? `${Math.round(summary.avgFps)}` : DASH} hue={158} />
            <Badge label="1% Low" value={summary.low1 != null ? `${Math.round(summary.low1)}` : DASH} hue={85} />
          </div>
        </div>
      </div>
      <span
        role="button"
        tabIndex={-1}
        aria-label="删除报告"
        onClick={(e) => {
          e.stopPropagation();
          onDelete();
        }}
        className="absolute right-2 top-2 grid h-5 w-5 place-items-center rounded-md text-dim opacity-0 transition hover:bg-danger hover:text-white group-hover:opacity-100"
      >
        <X size={12} />
      </span>
    </motion.button>
  );
}

export function PerfHistory() {
  const sessions = usePerfHistory((s) => s.sessions);
  const removeSession = usePerfHistory((s) => s.removeSession);
  const clear = usePerfHistory((s) => s.clear);
  const pendingReportId = usePerfHistory((s) => s.pendingReportId);
  const clearPendingReport = usePerfHistory((s) => s.clearPendingReport);

  const [selectedId, setSelectedId] = useState<string | null>(sessions[0]?.id ?? null);
  const [confirmClear, setConfirmClear] = useState(false);

  // Auto-surface a session requested by the recorder (game just exited): select
  // it, then clear the one-shot pending flag so manual selection isn't overridden.
  useEffect(() => {
    if (pendingReportId === null) return;
    if (sessions.some((s) => s.id === pendingReportId)) {
      setSelectedId(pendingReportId);
    }
    clearPendingReport();
  }, [pendingReportId, sessions, clearPendingReport]);

  // Keep a valid selection as sessions are added/removed (default: newest).
  useEffect(() => {
    if (sessions.length === 0) {
      if (selectedId !== null) setSelectedId(null);
      return;
    }
    if (!sessions.some((s) => s.id === selectedId)) {
      setSelectedId(sessions[0].id);
    }
  }, [sessions, selectedId]);

  if (sessions.length === 0) {
    return (
      <div className="grid flex-1 place-items-center px-6 pb-10">
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
          className="hud-frame glass hairline flex max-w-md flex-col items-center gap-3 rounded-2xl p-8 text-center"
        >
          <span className="grid h-12 w-12 place-items-center rounded-xl bg-accent/15 text-accent glow-sm">
            <Gamepad2 size={22} />
          </span>
          <div className="hud-label text-[12px] text-ink">暂无性能报告</div>
          <p className="text-[12px] leading-relaxed text-dim">
            启动并退出游戏后，CorePilot 会自动记录本次会话并在此生成性能报告。
          </p>
        </motion.div>
      </div>
    );
  }

  const selected = sessions.find((s) => s.id === selectedId) ?? sessions[0];

  return (
    <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 overflow-hidden p-4 lg:grid-cols-[280px_minmax(0,1fr)]">
      {/* Master: session list */}
      <div className="flex min-h-0 flex-col gap-3">
        <div className="flex items-center justify-between">
          <span className="hud-label flex items-center gap-1.5 text-[10px] text-muted">
            报告 <span className="nums text-dim">{sessions.length}</span>
          </span>
          <Button variant="subtle" onClick={() => setConfirmClear(true)} className="px-2 py-1">
            <Trash2 size={13} /> 清空历史
          </Button>
        </div>
        <div className="min-h-0 flex-1 space-y-2 overflow-auto pr-1">
          <AnimatePresence initial={false}>
            {sessions.map((session) => (
              <SessionCard
                key={session.id}
                session={session}
                active={session.id === selected.id}
                onSelect={() => setSelectedId(session.id)}
                onDelete={() => removeSession(session.id)}
              />
            ))}
          </AnimatePresence>
        </div>
      </div>

      {/* Detail: report for the selected session */}
      <div className="min-h-0 overflow-auto pr-1">
        <AnimatePresence mode="wait">
          <PerfReport key={selected.id} session={selected} />
        </AnimatePresence>
      </div>

      <Modal
        open={confirmClear}
        onClose={() => setConfirmClear(false)}
        title="清空性能历史"
        footer={
          <>
            <Button onClick={() => setConfirmClear(false)}>取消</Button>
            <Button
              variant="danger"
              onClick={() => {
                clear();
                setConfirmClear(false);
              }}
            >
              清空
            </Button>
          </>
        }
      >
        <p className="text-[13px] leading-relaxed text-muted">
          将删除全部 <span className="nums text-ink">{sessions.length}</span> 份性能报告，此操作不可撤销。
        </p>
      </Modal>
    </div>
  );
}
