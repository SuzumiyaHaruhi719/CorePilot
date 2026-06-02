import { Settings as SettingsIcon } from "lucide-react";
import { motion } from "motion/react";
import type { ReactNode } from "react";
import { Segmented } from "../components/ui/Segmented";
import { TabHeader } from "../components/ui/TabHeader";
import { Toggle } from "../components/ui/Toggle";
import { cn } from "../lib/cn";
import {
  ACCENT_HUE,
  useSettings,
  type AccentName,
  type GlowLevel,
  type Language,
} from "../store/settings";

const ACCENTS: AccentName[] = ["violet", "cyan", "teal", "amber", "rose"];

interface SettingRowProps {
  title: string;
  desc?: string;
  children: ReactNode;
}

function SettingRow({ title, desc, children }: SettingRowProps) {
  return (
    <div className="flex items-center justify-between gap-6 border-b border-line/60 py-3.5 last:border-0">
      <div>
        <div className="text-[13.5px] font-medium text-ink">{title}</div>
        {desc && <div className="text-[12px] text-dim">{desc}</div>}
      </div>
      <div className="no-drag shrink-0">{children}</div>
    </div>
  );
}

export function Settings() {
  const settings = useSettings();

  return (
    <>
      <TabHeader icon={SettingsIcon} title="设置" subtitle="所有更改即时自动保存 — 无需手动保存" />
      <div className="min-h-0 flex-1 overflow-auto px-6 pb-6">
        <motion.div
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
          className="glass hairline mx-auto max-w-2xl rounded-2xl px-5 py-2"
        >
          <SettingRow title="强调色" desc="主题主色调，实时应用">
            <div className="flex gap-2">
              {ACCENTS.map((accent) => (
                <motion.button
                  key={accent}
                  whileHover={{ scale: 1.15 }}
                  whileTap={{ scale: 0.9 }}
                  onClick={() => settings.update({ accent })}
                  className={cn(
                    "h-7 w-7 rounded-full border-2 transition",
                    settings.accent === accent ? "border-ink glow" : "border-transparent",
                  )}
                  style={{ background: `oklch(72% 0.16 ${ACCENT_HUE[accent]})` }}
                />
              ))}
            </div>
          </SettingRow>

          <SettingRow title="发光强度" desc="界面柔和发光效果">
            <Segmented
              id="glow"
              value={settings.glow}
              onChange={(value) => settings.update({ glow: value as GlowLevel })}
              options={[
                { value: "soft", label: "柔和" },
                { value: "medium", label: "中等" },
                { value: "intense", label: "强烈" },
              ]}
            />
          </SettingRow>

          <SettingRow title="亚克力模糊" desc="Windows 11 acrylic 背景效果">
            <Toggle checked={settings.acrylic} onChange={(value) => settings.update({ acrylic: value })} />
          </SettingRow>

          <SettingRow title="减弱动画" desc="降低动效以提升无障碍体验">
            <Toggle
              checked={settings.reduceMotion}
              onChange={(value) => settings.update({ reduceMotion: value })}
            />
          </SettingRow>

          <SettingRow
            title="关闭后保留到托盘"
            desc="关闭窗口时收起到系统托盘，后台继续运行（亲和性 / 超频 / OSD）；右键托盘图标可退出"
          >
            <Toggle
              checked={settings.closeToTray}
              onChange={(value) => settings.update({ closeToTray: value })}
            />
          </SettingRow>

          <SettingRow title="语言 / Language">
            <Segmented
              id="lang"
              value={settings.language}
              onChange={(value) => settings.update({ language: value as Language })}
              options={[
                { value: "zh", label: "中文" },
                { value: "en", label: "EN" },
              ]}
            />
          </SettingRow>

          <SettingRow title="刷新间隔" desc="实时数据轮询频率">
            <Segmented
              id="poll"
              value={String(settings.pollMs)}
              onChange={(value) => settings.update({ pollMs: Number(value) })}
              options={[
                { value: "1000", label: "1s" },
                { value: "1500", label: "1.5s" },
                { value: "2000", label: "2s" },
                { value: "3000", label: "3s" },
              ]}
            />
          </SettingRow>
        </motion.div>
      </div>
    </>
  );
}
