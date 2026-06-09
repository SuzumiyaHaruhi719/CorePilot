import { AnimatePresence, motion } from "motion/react";
import { Check, Cpu, Loader2, RotateCcw, ShieldAlert, Zap } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "../ui/Button";
import { cn } from "../../lib/cn";
import { useTf } from "../../lib/i18n";
import { api, type SmuStatus } from "../../lib/ipc";

interface PboInputs {
  ppt: string;
  tdc: string;
  edc: string;
  scalar: string;
}

/**
 * SMU tuning — Curve Optimizer (undervolt) + PBO limits, written through the
 * sensord PawnIO host. Only mounted when the AMD tab's master safety switch is on.
 *
 * Writes are a deliberate, LIVE override and are NEVER auto-reverted — auto-zeroing
 * would wipe a user's existing BIOS Curve-Optimizer offsets. All-core CO overrides
 * the BIOS per-core curve for the current boot; a reboot re-applies the BIOS values
 * (CorePilot never writes BIOS). "Force stock" is an explicit, separate action.
 */
export function SmuTuning() {
  const tf = useTf();
  const [status, setStatus] = useState<SmuStatus | null>(null);
  const [coMargin, setCoMargin] = useState(0);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ msg: string; ok: boolean } | null>(null);
  const [pbo, setPbo] = useState<PboInputs>({ ppt: "", tdc: "", edc: "", scalar: "" });

  useEffect(() => {
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
  }, []);

  const ready = !!status?.pawnIo && !!status?.loaded;

  async function applyCo() {
    setBusy(true);
    setNote(null);
    try {
      const ok = await api.smuApplyCoAll(coMargin);
      setNote(
        ok
          ? { msg: tf(`已实时应用 CO ${coMargin} · 重启恢复 BIOS 设置`, `Applied CO ${coMargin} live · reboot restores BIOS`), ok: true }
          : { msg: tf("应用失败(SMU 未响应)", "Apply failed (SMU did not respond)"), ok: false },
      );
    } catch (e) {
      setNote({ msg: String(e), ok: false });
    } finally {
      setBusy(false);
    }
  }

  async function forceStock() {
    setBusy(true);
    setNote(null);
    try {
      await api.smuForceStock();
      setCoMargin(0);
      setNote({ msg: tf("已强制归零(stock)· 重启恢复 BIOS 撤压", "Forced stock (0) · reboot restores your BIOS undervolt"), ok: true });
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
      setNote({ msg: tf("已应用 PBO 限制 · 重启恢复 BIOS", "Applied PBO limits · reboot restores BIOS"), ok: true });
    } catch (e) {
      setNote({ msg: String(e), ok: false });
    } finally {
      setBusy(false);
    }
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
      </div>

      {/* Always-on warning: CO here is all-core + overrides BIOS; reboot restores. */}
      <div className="flex items-start gap-2 rounded-xl border border-warn/30 bg-warn/[0.06] px-3 py-2 text-[11.5px] leading-relaxed text-warn">
        <ShieldAlert size={14} className="mt-0.5 shrink-0" />
        <span>
          {tf(
            "全核 Curve Optimizer 会覆盖 BIOS 的逐核 CO 设置(仅本次开机有效),不写入 BIOS。要恢复你在 BIOS 里调好的撤压,直接重启即可。CorePilot 永不自动归零。",
            "All-core Curve Optimizer overrides your BIOS per-core CO for this boot only — it is never written to BIOS. To restore the undervolt you set in BIOS, just reboot. CorePilot never auto-zeros.",
          )}
        </span>
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
            disabled={!ready || busy}
            onChange={(e) => setCoMargin(parseInt(e.target.value, 10))}
            className="h-1.5 flex-1 cursor-pointer accent-[var(--color-accent)]"
          />
          <span className="w-12 shrink-0 text-right font-mono text-[13px] font-semibold tabular-nums text-ink">{coMargin}</span>
          <Button onClick={() => void applyCo()} disabled={!ready || busy}>
            {busy ? <Loader2 size={14} className="animate-spin" /> : <Zap size={14} />} {tf("应用", "Apply")}
          </Button>
          <Button onClick={() => void forceStock()} disabled={!ready || busy} title={tf("覆盖为 stock(0),会盖掉 BIOS;重启恢复", "Override to stock (0); reboot restores BIOS")}>
            <RotateCcw size={14} /> {tf("强制归零", "Force stock")}
          </Button>
        </div>
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
