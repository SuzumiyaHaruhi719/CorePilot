import { AnimatePresence, motion } from "motion/react";
import { Ban, CircleCheck, Gamepad2, Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { cn, FOCUS_RING } from "../../lib/cn";
import { easeOut } from "../../lib/motion";
import { useTf } from "../../lib/i18n";
import { gameDisplayName } from "../../lib/perf";
import type { PerfSessionMeta } from "../../lib/perfSamples";
import { usePerfHistory } from "../../store/perfHistory";
import { useRecordTargets, type RecordListKind } from "../../store/recordTargets";
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

interface SessionCardProps {
  session: PerfSessionMeta;
  active: boolean;
  /** Which record list this exe is on (white/black), or null. */
  listKind: RecordListKind | null;
  onSelect: () => void;
  onDelete: () => void;
  onWhite: () => void;
  onBlack: () => void;
}

function SessionCard({ session, active, listKind, onSelect, onDelete, onWhite, onBlack }: SessionCardProps) {
  const { summary } = session;
  return (
    // The shell is a plain <div>, not the clickable element: the card carries
    // three quick actions of its own, and nesting them inside a <button> (as
    // <span role="button" tabIndex={-1}>) is invalid interactive content that
    // Tab can never reach — the white/black-list toggles and the delete were
    // mouse-only. Body + actions are siblings now, so each is focusable and
    // no click needs stopPropagation.
    <motion.div
      layout="position"
      initial={{ opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: "auto" }}
      exit={{ opacity: 0, height: 0 }}
      transition={{ duration: 0.2, ease: easeOut }}
      className={cn(
        "no-drag group relative w-full overflow-hidden rounded-lg transition-colors duration-150",
        active ? "bg-surface2" : "hover:bg-surface2/50",
      )}
    >
      {/* Card body = "open this session's report". The focus ring is inset: the
          body fills the shell, and the shell clips overflow, so a ring drawn
          outside the border box would be invisible. */}
      <button
        type="button"
        onClick={onSelect}
        aria-pressed={active}
        className={cn("block w-full rounded-lg px-2.5 py-2 text-left", FOCUS_RING, "focus-visible:ring-inset")}
      >
        <div className="flex items-start gap-2.5">
          <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center overflow-hidden rounded-md bg-surface3 text-dim">
            {session.path ? <ProcIcon exePath={session.path} size={18} /> : <Gamepad2 size={16} />}
          </span>
          <div className="min-w-0 flex-1">
            <div className="truncate pr-16 text-[13px] font-medium text-ink" title={gameDisplayName(session.exe)}>
              {gameDisplayName(session.exe)}
            </div>
            <div className="nums mt-0.5 text-[11.5px] text-dim">
              {fmtCardDate(session.startedAt)} · {fmtDuration(session.durationSec)}
            </div>
            <div className="nums mt-1 flex items-baseline gap-3 text-[12px]">
              <span>
                <span className={active ? "text-ink" : "text-muted"}>{summary.avgFps != null ? Math.round(summary.avgFps) : DASH}</span>
                <span className="ml-1 text-[11px] text-dim">FPS</span>
              </span>
              <span>
                <span className="text-muted">{summary.low1 != null ? Math.round(summary.low1) : DASH}</span>
                <span className="ml-1 text-[11px] text-dim">1% Low</span>
              </span>
            </div>
          </div>
        </div>
      </button>
      {/* Quick record white/black-list toggles (always visible; highlighted when
          active) + a hover-reveal delete. The row sits on top of the body
          button, so it stays pointer-events-none and only the buttons themselves
          take clicks — otherwise the 4px gaps between them would become dead
          zones that no longer select the card. */}
      <div className="pointer-events-none absolute right-2 top-2 flex items-center gap-1">
        <button
          type="button"
          aria-label="加入白名单（强制录制）"
          aria-pressed={listKind === "white"}
          title="白名单 · 强制录制此程序"
          onClick={onWhite}
          className={cn(
            "pointer-events-auto grid h-6 w-6 cursor-pointer place-items-center rounded-md transition-colors",
            FOCUS_RING,
            listKind === "white" ? "bg-ok/14 text-ok" : "text-dim opacity-0 hover:bg-surface3 hover:text-ok focus-visible:opacity-100 group-hover:opacity-100",
          )}
        >
          <CircleCheck size={13} />
        </button>
        <button
          type="button"
          aria-label="加入黑名单（不录制）"
          aria-pressed={listKind === "black"}
          title="黑名单 · 不录制此程序"
          onClick={onBlack}
          className={cn(
            "pointer-events-auto grid h-6 w-6 cursor-pointer place-items-center rounded-md transition-colors",
            FOCUS_RING,
            listKind === "black" ? "bg-danger/14 text-danger" : "text-dim opacity-0 hover:bg-surface3 hover:text-danger focus-visible:opacity-100 group-hover:opacity-100",
          )}
        >
          <Ban size={13} />
        </button>
        <button
          type="button"
          aria-label="删除报告"
          onClick={onDelete}
          // opacity-0 until the card is hovered; the focus-visible /
          // group-focus-within pair is what keeps it from being an invisible
          // stop in the Tab order once it is keyboard-reachable.
          className={cn(
            "pointer-events-auto grid h-6 w-6 cursor-pointer place-items-center rounded-md text-dim opacity-0 transition-[opacity,color,background-color] duration-150 hover:bg-danger/12 hover:text-danger focus-visible:opacity-100 group-focus-within:opacity-100 group-hover:opacity-100",
            FOCUS_RING,
          )}
        >
          <X size={13} />
        </button>
      </div>
    </motion.div>
  );
}

export function PerfHistory() {
  const tf = useTf();
  const sessions = usePerfHistory((s) => s.sessions);
  const removeSession = usePerfHistory((s) => s.removeSession);
  const clear = usePerfHistory((s) => s.clear);
  const pendingReportId = usePerfHistory((s) => s.pendingReportId);
  const clearPendingReport = usePerfHistory((s) => s.clearPendingReport);
  const targets = useRecordTargets((s) => s.targets);
  const addTarget = useRecordTargets((s) => s.addTarget);
  const removeTarget = useRecordTargets((s) => s.removeTarget);
  const setTargetList = useRecordTargets((s) => s.setTargetList);

  // Toggle an exe on the record white/black list: same list again clears it,
  // a different list switches, otherwise it's added.
  function toggleList(exe: string, kind: RecordListKind) {
    const name = exe.trim().toLowerCase();
    const cur = targets.find((t) => t.name === name)?.list ?? null;
    if (cur === kind) removeTarget(name);
    else if (cur) setTargetList(name, kind);
    else addTarget(name, kind);
  }

  const [selectedId, setSelectedId] = useState<string | null>(sessions[0]?.id ?? null);
  const [confirmClear, setConfirmClear] = useState(false);
  // Id of the single session pending a delete confirmation (null = no prompt).
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

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
        <div className="flex max-w-sm flex-col items-center text-center">
          <Gamepad2 size={22} className="text-dim" />
          <div className="mt-3 text-[14px] font-semibold text-ink">暂无性能报告</div>
          <p className="mt-1.5 text-[12.5px] leading-relaxed text-muted">
            启动并退出游戏后，CorePilot 会自动记录本次会话并在此生成性能报告。
          </p>
        </div>
      </div>
    );
  }

  const selected = sessions.find((s) => s.id === selectedId) ?? sessions[0];
  const pendingDelete = confirmDeleteId
    ? sessions.find((s) => s.id === confirmDeleteId) ?? null
    : null;

  return (
    <div className="grid min-h-0 flex-1 grid-cols-1 gap-5 overflow-hidden px-6 pb-6 lg:grid-cols-[264px_minmax(0,1fr)]">
      {/* Master: session list */}
      <div className="flex min-h-0 flex-col gap-2">
        <div className="flex items-center justify-between px-2.5">
          <span className="text-[11.5px] text-dim">{tf(`${sessions.length} 份报告`, `${sessions.length} reports`)}</span>
          <Button variant="subtle" size="sm" onClick={() => setConfirmClear(true)} className="hover:text-danger">
            <Trash2 size={13} /> 清空历史
          </Button>
        </div>
        <div className="min-h-0 flex-1 space-y-0.5 overflow-auto">
          <AnimatePresence initial={false}>
            {sessions.map((session) => {
              const name = session.exe.trim().toLowerCase();
              const listKind = targets.find((t) => t.name === name)?.list ?? null;
              return (
                <SessionCard
                  key={session.id}
                  session={session}
                  active={session.id === selected.id}
                  listKind={listKind}
                  onSelect={() => setSelectedId(session.id)}
                  onDelete={() => setConfirmDeleteId(session.id)}
                  onWhite={() => toggleList(session.exe, "white")}
                  onBlack={() => toggleList(session.exe, "black")}
                />
              );
            })}
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

      <Modal
        open={pendingDelete !== null}
        onClose={() => setConfirmDeleteId(null)}
        title="删除性能报告"
        footer={
          <>
            <Button onClick={() => setConfirmDeleteId(null)}>取消</Button>
            <Button
              variant="danger"
              onClick={() => {
                if (confirmDeleteId) removeSession(confirmDeleteId);
                setConfirmDeleteId(null);
              }}
            >
              删除
            </Button>
          </>
        }
      >
        <p className="text-[13px] leading-relaxed text-muted">
          将删除
          <span className="text-ink">
            {pendingDelete ? `“${gameDisplayName(pendingDelete.exe)}”` : ""}
          </span>
          的这份性能报告，此操作不可撤销。
        </p>
      </Modal>
    </div>
  );
}
