import { AnimatePresence, motion } from "motion/react";
import { Check, Cpu, Loader2, RotateCcw, ShieldAlert, Zap } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "../ui/Button";
import { cn } from "../../lib/cn";
import { useTf } from "../../lib/i18n";
import { api, type SmuStatus } from "../../lib/ipc";

/** Seconds before an unconfirmed Curve-Optimizer apply auto-reverts to 0. */
const REVERT_SECS = 15;

interface PboInputs {
  ppt: string;
  tdc: string;
  edc: string;
  scalar: string;
}

/**
 * SMU tuning — Curve Optimizer (per-core undervolt) + PBO limits, written through
 * the sensord PawnIO host. Gated behind an explicit experimental opt-in. Every CO
 * apply arms an auto-revert watchdog (reverts to 0 after REVERT_SECS unless kept),
 * and nothing is persisted to BIOS — a reboot clears any applied state. Hardware
 * support requires the PawnIO driver + a supported Ryzen part.
 */
export function SmuTuning() {
  const tf = useTf();
  const [enabled, setEnabled] = useState(false);
  const [status, setStatus] = useState<SmuStatus | null>(null);
  const [coMargin, setCoMargin] = useState(0);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<number | null>(null);
  const [note, setNote] = useState<{ msg: string; ok: boolean } | null>(null);
  const [pbo, setPbo] = useState<PboInputs>({ ppt: "", tdc: "", edc: "", scalar: "" });
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Poll SMU status while the panel is enabled.
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    const poll = () => {
      api.smuStatus().then((s) => alive && setStatus(s)).catch(() => {});
    };
    poll();
    const id = setInterval(poll, 3000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [enabled]);

  // Auto-revert countdown after a CO apply (cosmetic mirror of the Rust watchdog).
  useEffect(() => {
    if (pending == null) return;
    tickRef.current = setInterval(() => {
      setPending((p) => {
        if (p == null) return null;
        if (p <= 1) {
          setNote({ msg: tf("未确认 —— 已自动撤销 CO", "Unconfirmed — CO auto-reverted"), ok: false });
          setCoMargin(0);
          return null;
        }
        return p - 1;
      });
    }, 1000);
    return () => {
      if (tickRef.current) clearInterval(tickRef.current);
    };
  }, [pending != null]); // eslint-disable-line react-hooks/exhaustive-deps

  const ready = !!status?.pawnIo && !!status?.loaded;

  async function applyCo() {
    setBusy(true);
    setNote(null);
    try {
      const ok = await api.smuApplyCoAll(coMargin, REVERT_SECS);
      if (ok) setPending(REVERT_SECS);
      else setNote({ msg: tf("应用失败(SMU 未响应)", "Apply failed (SMU did not respond)"), ok: false });
    } catch (e) {
      setNote({ msg: String(e), ok: false });
    } finally {
      setBusy(false);
    }
  }

  async function keep() {
    await api.smuConfirm().catch(() => {});
    setPending(null);
    setNote({ msg: tf(`已保留 CO ${coMargin}`, `Kept CO ${coMargin}`), ok: true });
  }

  async function revert() {
    setBusy(true);
    try {
      await api.smuRevertCo();
      setPending(null);
      setCoMargin(0);
      setNote({ msg: tf("已撤销 CO(归零)", "Reverted CO to 0"), ok: true });
    } finally {
      setBusy(false);
    }
  }

  async function applyPbo() {
    setBusy(true);
    setNote(null);
    try {
      const jobs: Promise<unknown>[] = [];
      const ppt = parseFloat(pbo.ppt);
      const tdc = parseFloat(pbo.tdc);
      const edc = parseFloat(pbo.edc);
      const scalar = parseInt(pbo.scalar, 10);
      if (Number.isFinite(ppt)) jobs.push(api.smuApplyLimit("ppt", ppt));
      if (Number.isFinite(tdc)) jobs.push(api.smuApplyLimit("tdc", tdc));
      if (Number.isFinite(edc)) jobs.push(api.smuApplyLimit("edc", edc));
      if (Number.isFinite(scalar)) jobs.push(api.smuSetScalar(scalar));
      if (jobs.length === 0) {
        setNote({ msg: tf("未填写任何 PBO 值", "No PBO values entered"), ok: false });
        return;
      }
      await Promise.all(jobs);
      setNote({ msg: tf("已应用 PBO 限制", "Applied PBO limits"), ok: true });
    } catch (e) {
      setNote({ msg: String(e), ok: false });
    } finally {
      setBusy(false);
    }
  }

  // ---- gate: explicit experimental opt-in ----------------------------------
  if (!enabled) {
    return (
      <div className="rounded-2xl border border-danger/30 bg-danger/[0.05] p-4">
        <div className="mb-1 flex items-center gap-2 text-[12.5px] font-semibold text-danger">
          <ShieldAlert size={15} /> {tf("SMU 调优(实验性)", "SMU tuning (experimental)")}
        </div>
        <p className="mb-3 max-w-2xl text-[11px] leading-relaxed text-danger/80">
          {tf(
            "Curve Optimizer 撤压与 PBO 限制是内核级 SMU 写入。设置不当可能导致 WHEA 报错、死机或无法开机。CorePilot 不写入 BIOS —— 任何设置重启即清除,且 CO 应用会在未确认时自动撤销。仅在你了解风险时启用,并从小幅(如 -5)逐核验证。",
            "Curve Optimizer undervolt and PBO limits are kernel-level SMU writes. A bad value can cause WHEA errors, hard hangs, or failure to boot. CorePilot never writes to BIOS — anything applied is cleared on reboot, and a CO apply auto-reverts unless confirmed. Enable only if you understand the risk, and validate in small steps (e.g. -5).",
          )}
        </p>
        <Button variant="primary" onClick={() => setEnabled(true)}>
          <ShieldAlert size={14} /> {tf("我了解风险,启用", "I understand the risk, enable")}
        </Button>
      </div>
    );
  }

  return (
    <div className="glass hairline space-y-4 rounded-2xl p-4">
      <div className="flex flex-wrap items-center gap-2 text-[12.5px] font-semibold text-muted">
        <Zap size={15} className="text-accent" /> {tf("SMU 调优", "SMU tuning")}
        <span
          className={cn(
            "rounded px-1.5 py-0.5 text-[10px] font-medium",
            ready ? "bg-ok/15 text-ok" : "bg-warn/15 text-warn",
          )}
        >
          {status == null
            ? tf("检测中…", "probing…")
            : !status.pawnIo
              ? tf("缺少 PawnIO 驱动", "PawnIO driver missing")
              : !status.loaded
                ? tf("SMU 模块未加载", "SMU module not loaded")
                : tf(`已就绪 · SMU ${status.versionStr}`, `ready · SMU ${status.versionStr}`)}
        </span>
        <button className="ml-auto text-[11px] font-normal text-dim hover:text-muted" onClick={() => setEnabled(false)}>
          {tf("收起", "collapse")}
        </button>
      </div>

      {!ready && (
        <p className="text-[11.5px] leading-relaxed text-dim">
          {tf(
            "需要安装 PawnIO 驱动(开源、已签名)才能进行 SMU 写入。安装后重启 CorePilot 即可。",
            "SMU writes require the PawnIO driver (open-source, signed). Install it, then restart CorePilot.",
          )}
        </p>
      )}

      {/* Curve Optimizer (all-core) */}
      <div className={cn("space-y-2", !ready && "pointer-events-none opacity-40")}>
        <div className="flex items-center gap-2 text-[12px] font-medium text-ink">
          <Cpu size={14} className="text-accent" /> {tf("Curve Optimizer · 全核撤压", "Curve Optimizer · all-core")}
        </div>
        <div className="flex items-center gap-3">
          <input
            type="range"
            min={-50}
            max={0}
            step={1}
            value={coMargin}
            disabled={!ready || busy || pending != null}
            onChange={(e) => setCoMargin(parseInt(e.target.value, 10))}
            className="h-1.5 flex-1 cursor-pointer accent-[var(--color-accent)]"
          />
          <span className="w-12 shrink-0 text-right font-mono text-[13px] font-semibold tabular-nums text-ink">{coMargin}</span>
          <Button onClick={() => void applyCo()} disabled={!ready || busy || pending != null}>
            {busy ? <Loader2 size={14} className="animate-spin" /> : <Zap size={14} />} {tf("应用", "Apply")}
          </Button>
          <Button onClick={() => void revert()} disabled={!ready || busy}>
            <RotateCcw size={14} /> {tf("撤销", "Revert")}
          </Button>
        </div>

        <AnimatePresence>
          {pending != null && (
            <motion.div
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              className="flex items-center gap-2 rounded-xl border border-warn/30 bg-warn/[0.06] px-3 py-2 text-[12px] text-warn"
            >
              <Loader2 size={13} className="animate-spin" />
              {tf(`未确认将在 ${pending}s 后自动撤销`, `auto-reverts in ${pending}s unless confirmed`)}
              <Button variant="primary" onClick={() => void keep()} className="ml-auto">
                <Check size={13} /> {tf("稳定,保留", "Stable, keep")}
              </Button>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* PBO limits */}
      <div className={cn("space-y-2", !ready && "pointer-events-none opacity-40")}>
        <div className="text-[12px] font-medium text-ink">{tf("PBO 限制(留空 = 不改)", "PBO limits (blank = unchanged)")}</div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {([
            ["ppt", tf("PPT (W)", "PPT (W)")],
            ["tdc", tf("TDC (A)", "TDC (A)")],
            ["edc", tf("EDC (A)", "EDC (A)")],
            ["scalar", tf("Scalar (1–10)", "Scalar (1–10)")],
          ] as const).map(([key, label]) => (
            <label key={key} className="flex flex-col gap-1">
              <span className="text-[10.5px] text-dim">{label}</span>
              <input
                inputMode="numeric"
                value={pbo[key]}
                disabled={!ready || busy}
                onChange={(e) => setPbo((p) => ({ ...p, [key]: e.target.value }))}
                className="rounded-lg border border-line bg-surface2/40 px-2.5 py-1.5 font-mono text-[12px] text-ink outline-none focus:border-accent/50"
              />
            </label>
          ))}
        </div>
        <Button onClick={() => void applyPbo()} disabled={!ready || busy}>
          {busy ? <Loader2 size={14} className="animate-spin" /> : <Zap size={14} />} {tf("应用 PBO", "Apply PBO")}
        </Button>
      </div>

      <AnimatePresence>
        {note && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className={cn("flex items-center gap-1.5 text-[12px] font-medium", note.ok ? "text-ok" : "text-danger")}
          >
            {note.ok ? <Check size={13} /> : <ShieldAlert size={13} />} {note.msg}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
