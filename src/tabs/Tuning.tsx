import { AnimatePresence, motion } from "motion/react";
import {
  AlertTriangle,
  Check,
  Loader2,
  RotateCcw,
  ShieldAlert,
  ShieldCheck,
  ShieldPlus,
  Wrench,
} from "lucide-react";
import { useState } from "react";
import { Button } from "../components/ui/Button";
import { Modal } from "../components/ui/Modal";
import { TabHeader } from "../components/ui/TabHeader";
import { Toggle } from "../components/ui/Toggle";
import { cn } from "../lib/cn";
import { api } from "../lib/ipc";
import { useTweaks } from "../store/tweaks";

type Zone = "safe" | "danger";

interface TweakMeta {
  id: string;
  name: string;
  desc: string;
  /** Change requires a reboot to fully take effect. */
  reboot?: boolean;
}

const SAFE_TWEAKS: TweakMeta[] = [
  { id: "mmcss_gaming", name: "游戏调度优先级 (MMCSS)", desc: "提升游戏/多媒体的 CPU·GPU 调度优先级与响应度,减少卡顿。" },
  { id: "network_throttling_off", name: "关闭网络限流", desc: "解除多媒体网络节流 (NetworkThrottlingIndex),降低网络延迟。" },
  { id: "foreground_boost", name: "前台程序优先", desc: "Win32PrioritySeparation 偏向前台应用,游戏/当前窗口获得更多 CPU。" },
  { id: "menu_delay_0", name: "菜单零延迟", desc: "去掉菜单弹出延迟,界面操作更跟手。" },
  { id: "ntfs_lastaccess_off", name: "关闭 NTFS 最后访问时间戳", desc: "减少每次读文件的额外磁盘写入,降低 IO 开销。" },
  { id: "telemetry_off", name: "关闭遥测服务", desc: "停用 DiagTrack / dmwappushservice 等遥测,省资源、护隐私。" },
  { id: "ultimate_power_plan", name: "卓越性能电源计划", desc: "启用 Ultimate Performance,减少降频与延迟(台式机推荐)。" },
  { id: "game_dvr_off", name: "关闭 Game DVR / 后台录制", desc: "关闭 Xbox 后台游戏录制,通常能提升游戏帧数。" },
];

const DANGER_TWEAKS: TweakMeta[] = [
  { id: "defender_rt_off", name: "关闭 Defender 实时防护", desc: "明显降低后台占用,但关闭杀毒实时保护。若开启了「篡改防护」可能无法生效。" },
  { id: "vbs_off", name: "关闭内存完整性 (VBS / HVCI)", desc: "可提升数个百分点性能,但降低内核安全防护。", reboot: true },
  { id: "smartscreen_off", name: "关闭 SmartScreen", desc: "去掉下载/应用信誉检查,运行更少拦截 —— 也少了一层防护。" },
  { id: "sysmain_off", name: "关闭 SysMain (Superfetch)", desc: "减少后台预读占用。SSD 上影响很小;机械硬盘请谨慎。" },
  { id: "search_off", name: "关闭 Windows 搜索索引", desc: "省 CPU/磁盘,但开始菜单/资源管理器搜索会变慢。" },
  { id: "auto_update_off", name: "关闭自动更新", desc: "避免更新打断,但长期不更新有安全风险,请定期手动更新。", reboot: false },
];

function getErrorMessage(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return "操作失败";
}

export function Tuning() {
  const { applied, snapshots, setApplied, setSnapshot } = useTweaks();
  const [busyId, setBusyId] = useState<string | null>(null);
  // Optimistic per-row state so a toggle flips (and its spring plays) the instant
  // it's actioned, instead of only after the async apply returns. Reconciled in
  // doApply — on failure the toggle animates back to its real state.
  const [optimistic, setOptimistic] = useState<Record<string, boolean>>({});
  const [status, setStatus] = useState<{ msg: string; ok: boolean } | null>(null);
  const [confirmTweak, setConfirmTweak] = useState<TweakMeta | null>(null);

  async function doApply(meta: TweakMeta, next: boolean) {
    setBusyId(meta.id);
    setOptimistic((o) => ({ ...o, [meta.id]: next }));
    setStatus(null);
    try {
      if (next) {
        // Persist the pre-apply snapshot so a later revert restores the user's
        // real prior values (not an assumed Windows default).
        const snapshot = await api.tweakApply(meta.id);
        setSnapshot(meta.id, snapshot);
      } else {
        await api.tweakRevert(meta.id, snapshots[meta.id] ?? "");
      }
      setApplied(meta.id, next);
      setStatus({
        msg: `${next ? "已应用" : "已还原"}「${meta.name}」${meta.reboot && next ? " · 重启后生效" : ""}`,
        ok: true,
      });
    } catch (e: unknown) {
      setStatus({ msg: getErrorMessage(e), ok: false });
    } finally {
      setBusyId(null);
      setOptimistic((o) => {
        const rest = { ...o };
        delete rest[meta.id];
        return rest;
      });
    }
  }

  function handleToggle(meta: TweakMeta, zone: Zone, next: boolean) {
    // Turning ON a dangerous tweak requires explicit confirmation; reverting is
    // always allowed without a prompt.
    if (next && zone === "danger") {
      setConfirmTweak(meta);
      return;
    }
    void doApply(meta, next);
  }

  async function revertAll() {
    setBusyId("__all__");
    setStatus(null);
    const ids = [...SAFE_TWEAKS, ...DANGER_TWEAKS].filter((t) => applied[t.id]);
    let failed = 0;
    for (const t of ids) {
      try {
        await api.tweakRevert(t.id, snapshots[t.id] ?? "");
        setApplied(t.id, false);
      } catch {
        failed += 1;
      }
    }
    setBusyId(null);
    setStatus({ msg: failed ? `还原完成,${failed} 项失败` : "已全部还原为默认", ok: failed === 0 });
  }

  async function makeRestorePoint() {
    setBusyId("__rp__");
    setStatus(null);
    try {
      await api.createRestorePoint();
      setStatus({ msg: "已创建系统还原点", ok: true });
    } catch (e: unknown) {
      setStatus({ msg: `还原点创建失败(系统默认 24h 限一次):${getErrorMessage(e)}`, ok: false });
    } finally {
      setBusyId(null);
    }
  }

  function TweakRow({ meta, zone }: { meta: TweakMeta; zone: Zone }) {
    const busy = busyId === meta.id;
    const on = optimistic[meta.id] ?? !!applied[meta.id];
    // Lock every toggle while ANY tweak / bulk op is running, so concurrent or
    // conflicting operations can't be triggered.
    const anyBusy = busyId !== null;
    return (
      <div
        className={cn(
          "flex items-center justify-between gap-3 rounded-xl border p-3.5",
          zone === "danger" ? "border-danger/25 bg-danger/[0.04]" : "border-line bg-surface2/40",
        )}
      >
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-[13px] font-medium text-ink">{meta.name}</span>
            {meta.reboot && (
              <span className="rounded bg-warn/15 px-1.5 py-0.5 text-[9.5px] font-medium text-warn">需重启</span>
            )}
          </div>
          <div className="mt-0.5 text-[11px] leading-relaxed text-dim">{meta.desc}</div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {busy && <Loader2 size={14} className="animate-spin text-dim" />}
          <Toggle
            checked={on}
            disabled={anyBusy && !busy}
            label={meta.name}
            onChange={(v) => handleToggle(meta, zone, v)}
          />
        </div>
      </div>
    );
  }

  return (
    <>
      <TabHeader
        icon={Wrench}
        title="深度优化"
        subtitle="可逆的系统性能优化 —— 安全区随便开,危险区谨慎用。每项都可一键还原为系统默认。"
      />

      <div className="min-h-0 flex-1 space-y-4 overflow-auto px-6 pb-6">
        {/* Action bar */}
        <div className="glass hairline flex flex-wrap items-center gap-2 rounded-2xl p-3.5">
          <Button onClick={() => void makeRestorePoint()} disabled={busyId === "__rp__"}>
            {busyId === "__rp__" ? <Loader2 size={14} className="animate-spin" /> : <ShieldPlus size={14} />} 创建系统还原点
          </Button>
          <Button onClick={() => void revertAll()} disabled={busyId === "__all__"}>
            {busyId === "__all__" ? <Loader2 size={14} className="animate-spin" /> : <RotateCcw size={14} />} 全部还原默认
          </Button>
          <AnimatePresence>
            {status && (
              <motion.span
                initial={{ opacity: 0, x: -6 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0 }}
                className={cn(
                  "ml-1 flex items-center gap-1.5 text-[12px] font-medium",
                  status.ok ? "text-ok" : "text-danger",
                )}
              >
                {status.ok ? <Check size={13} /> : <AlertTriangle size={13} />} {status.msg}
              </motion.span>
            )}
          </AnimatePresence>
          <span className="ml-auto text-[11px] text-dim">建议先创建还原点再调整</span>
        </div>

        {/* Safe zone */}
        <div className="glass hairline space-y-3 rounded-2xl p-4">
          <div className="flex items-center gap-2 text-[12.5px] font-semibold text-muted">
            <ShieldCheck size={15} className="text-ok" /> 安全区
            <span className="text-[11px] font-normal text-dim">· 可逆、低风险,放心开</span>
          </div>
          <div className="grid gap-2.5 lg:grid-cols-2">
            {SAFE_TWEAKS.map((t) => (
              <TweakRow key={t.id} meta={t} zone="safe" />
            ))}
          </div>
        </div>

        {/* Danger zone */}
        <div className="rounded-2xl border border-danger/30 bg-danger/[0.05] p-4">
          <div className="mb-1 flex items-center gap-2 text-[12.5px] font-semibold text-danger">
            <ShieldAlert size={15} /> 危险区
            <span className="text-[11px] font-normal text-danger/70">· 性能收益更大,但会削弱系统安全/功能</span>
          </div>
          <p className="mb-3 text-[11px] leading-relaxed text-danger/80">
            以下项目会降低系统安全性或关闭系统功能。仅在你清楚后果时使用,开启需二次确认,且随时可一键还原。
          </p>
          <div className="grid gap-2.5 lg:grid-cols-2">
            {DANGER_TWEAKS.map((t) => (
              <TweakRow key={t.id} meta={t} zone="danger" />
            ))}
          </div>
        </div>

        <div className="flex items-start gap-2 text-[11px] leading-relaxed text-dim">
          <AlertTriangle size={13} className="mt-0.5 shrink-0 text-warn/70" />
          <p>
            所有优化均为<strong className="text-muted">可逆</strong>操作:还原会写回 Windows 文档化的默认值。部分项(内存完整性等)<strong className="text-muted">需重启</strong>才完全生效。CorePilot 不做删除系统组件等破坏性操作。
          </p>
        </div>
      </div>

      <Modal
        open={confirmTweak !== null}
        onClose={() => setConfirmTweak(null)}
        title="确认开启危险优化"
        footer={
          <>
            <Button onClick={() => setConfirmTweak(null)}>取消</Button>
            <Button
              variant="primary"
              onClick={() => {
                const t = confirmTweak;
                setConfirmTweak(null);
                if (t) void doApply(t, true);
              }}
            >
              我了解风险,开启
            </Button>
          </>
        }
      >
        {confirmTweak && (
          <div className="space-y-2">
            <div className="text-[13.5px] font-semibold text-ink">{confirmTweak.name}</div>
            <p className="text-[12px] leading-relaxed text-dim">{confirmTweak.desc}</p>
            {confirmTweak.reboot && (
              <p className="text-[11.5px] text-warn">该项需要重启电脑后才完全生效。</p>
            )}
            <p className="text-[11.5px] text-danger/80">可随时在本页关闭开关一键还原。</p>
          </div>
        )}
      </Modal>
    </>
  );
}
