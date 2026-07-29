import { Download, SkipForward, X } from "lucide-react";
import { Button } from "../ui/Button";
import { Modal } from "../ui/Modal";
import { useTf } from "../../lib/i18n";
import { installUpdate } from "../../hooks/useUpdateCheck";
import { useSettings } from "../../store/settings";
import { useUpdate } from "../../store/update";
import { BlockerList, ReleaseNotes, UpdateProgress } from "./UpdateShared";

/**
 * The launch-time "new version available" dialog.
 *
 * Only ever opened by `useUpdateCheck` (which decides *whether* to interrupt —
 * see `shouldPrompt`) or by the Settings card. Three ways out, because "later"
 * and "never this one" are genuinely different answers and collapsing them into
 * a single dismiss is what makes update prompts nag.
 */
export function UpdatePrompt() {
  const tf = useTf();
  const { info, promptOpen, closePrompt, installing, error, phase, downloaded, total } = useUpdate();
  const updateSettings = useSettings((s) => s.update);

  if (!info?.available || !info.latestVersion) return null;

  const blocked = info.blockers.some((b) => b.severity === "block");
  const version = info.latestVersion;

  const skip = () => {
    updateSettings({ skippedVersion: version });
    closePrompt();
  };

  return (
    <Modal
      open={promptOpen}
      onClose={closePrompt}
      title={tf(`发现新版本 ${version}`, `Version ${version} available`)}
      footer={
        <>
          <Button onClick={skip} disabled={installing}>
            <SkipForward size={14} /> 跳过此版本
          </Button>
          <Button onClick={closePrompt} disabled={installing}>
            <X size={14} /> 稍后提醒
          </Button>
          <Button variant="primary" onClick={() => void installUpdate()} disabled={installing || blocked}>
            <Download size={14} /> {installing ? "更新中…" : "立即更新"}
          </Button>
        </>
      }
    >
      <p className="text-[13px] leading-relaxed text-ink">
        {tf(
          `当前 ${info.currentVersion} → 最新 ${version}`,
          `Current ${info.currentVersion} → latest ${version}`,
        )}
      </p>
      <p className="mt-1 text-[11.5px] text-dim">
        {info.flavor === "portable"
          ? "便携版:下载后就地替换程序文件并自动重启。设置与历史记录不受影响。"
          : "安装版:下载后运行安装程序并自动重启。设置与历史记录不受影响。"}
      </p>

      <ReleaseNotes notes={info.notes} />
      <BlockerList blockers={info.blockers} />
      <UpdateProgress phase={phase} downloaded={downloaded} total={total} />

      {error && (
        <div className="mt-3 break-all rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-[11.5px] leading-relaxed text-danger">
          {error}
        </div>
      )}
    </Modal>
  );
}
