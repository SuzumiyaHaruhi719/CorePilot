import { CheckCircle2, Download, ExternalLink, Loader2, RefreshCw, XCircle } from "lucide-react";
import { motion } from "motion/react";
import { Button } from "../ui/Button";
import { Toggle } from "../ui/Toggle";
import { cn } from "../../lib/cn";
import { useT, useTf } from "../../lib/i18n";
import { api } from "../../lib/ipc";
import { checkForUpdate, installUpdate } from "../../hooks/useUpdateCheck";
import { useSettings } from "../../store/settings";
import { useUpdate } from "../../store/update";
import { BlockerList, ReleaseNotes, UpdateProgress } from "./UpdateShared";

/** "刚刚" / "3 小时前" / a date — the last-checked line. */
function agoLabel(ts: number, en: boolean): string {
  if (!ts) return en ? "never" : "从未";
  const mins = Math.floor((Date.now() - ts) / 60000);
  if (mins < 1) return en ? "just now" : "刚刚";
  if (mins < 60) return en ? `${mins} min ago` : `${mins} 分钟前`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return en ? `${hrs} h ago` : `${hrs} 小时前`;
  return new Date(ts).toLocaleDateString();
}

/**
 * Settings → 更新. The manual half of the update feature: check on demand, see
 * what the last check found, and turn the automatic launch check off.
 *
 * Shares `useUpdate` with the launch prompt, so whichever ran last is what both
 * show — no chance of the card claiming "已是最新" while a prompt sits open.
 */
export function UpdateCard() {
  const t = useT();
  const tf = useTf();
  const en = useSettings((s) => s.language) === "en";
  const autoCheckUpdates = useSettings((s) => s.autoCheckUpdates);
  const lastUpdateCheck = useSettings((s) => s.lastUpdateCheck);
  const updateSettings = useSettings((s) => s.update);
  const { info, checking, installing, error, phase, downloaded, total } = useUpdate();

  const blocked = info?.blockers.some((b) => b.severity === "block") ?? false;
  const releasesUrl = info?.releasesUrl ?? "https://github.com/SuzumiyaHaruhi719/CorePilot/releases/latest";

  const runCheck = async () => {
    const result = await checkForUpdate();
    // Only a COMPLETED check moves the debounce anchor — a failed one must not
    // buy four hours of silence.
    if (result) updateSettings({ lastUpdateCheck: Date.now() });
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1], delay: 0.09 }}
      className="glass hairline mx-auto mt-4 max-w-2xl rounded-2xl px-5 py-4"
    >
      <div className="flex items-center gap-2 border-b border-line/60 py-3">
        <Download size={13} className="text-accent-bright" />
        <span className="hud-label text-[10.5px] text-dim">{t("更新 · UPDATES")}</span>
        <span className="h-px flex-1 bg-line/50" />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 py-3">
        <div className="min-w-0">
          <div className="text-[13px] font-medium text-ink">
            {info
              ? tf(`当前版本 ${info.currentVersion}`, `Version ${info.currentVersion}`)
              : t("检查 GitHub 上是否有新版本")}
          </div>
          <div className="mt-0.5 text-[11.5px] text-dim">
            {tf(`上次检查:${agoLabel(lastUpdateCheck, en)}`, `Last checked: ${agoLabel(lastUpdateCheck, en)}`)}
          </div>
        </div>
        <div className="no-drag flex items-center gap-2">
          <button
            onClick={() => void api.openExternal(releasesUrl).catch(() => undefined)}
            className="flex cursor-pointer items-center gap-1.5 rounded-lg border border-line bg-surface2 px-2.5 py-1.5 text-[12px] text-muted transition-colors hover:bg-surface3 hover:text-ink"
          >
            <ExternalLink size={13} /> 打开发布页
          </button>
          <Button variant="primary" onClick={() => void runCheck()} disabled={checking || installing}>
            {checking ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
            {checking ? "检查中…" : "检查更新"}
          </Button>
        </div>
      </div>

      {/* Result of the last check: new version, already current, or the reason
          the check couldn't answer. Never a bare "failed". */}
      {info && !checking && (
        <div
          className={cn(
            "flex items-start gap-1.5 rounded-lg border px-3 py-2 text-[11.5px] leading-relaxed",
            info.available ? "border-accent/40 bg-accent/10 text-accent-bright" : "border-ok/40 bg-ok/10 text-ok",
          )}
        >
          <CheckCircle2 size={13} className="mt-0.5 shrink-0" />
          <span className="min-w-0">
            {info.available
              ? tf(`发现新版本 ${info.latestVersion}`, `Version ${info.latestVersion} available`)
              : "已是最新版本。"}
          </span>
        </div>
      )}

      {error && !checking && (
        <div className="flex items-start gap-1.5 break-all rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-[11.5px] leading-relaxed text-danger">
          <XCircle size={13} className="mt-0.5 shrink-0" />
          <span className="min-w-0">{error}</span>
        </div>
      )}

      {info?.available && (
        <>
          <ReleaseNotes notes={info.notes} />
          <BlockerList blockers={info.blockers} />
          <UpdateProgress phase={phase} downloaded={downloaded} total={total} />
          <div className="mt-3 flex justify-end">
            <Button variant="primary" onClick={() => void installUpdate()} disabled={installing || blocked}>
              {installing ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
              {installing ? "更新中…" : "下载并安装"}
            </Button>
          </div>
        </>
      )}

      <div className="mt-1 flex items-center justify-between gap-6 border-t border-line/60 pt-3.5">
        <div>
          <div className="text-[13.5px] font-medium text-ink">{t("启动时自动检查更新")}</div>
          <div className="text-[12px] text-dim">
            {t("每次启动检查一次(最快 4 小时一次),发现新版本时询问是否更新;游戏运行中不打扰。")}
          </div>
        </div>
        <div className="no-drag shrink-0">
          <Toggle
            checked={autoCheckUpdates}
            onChange={(value) => updateSettings({ autoCheckUpdates: value })}
          />
        </div>
      </div>
    </motion.div>
  );
}
