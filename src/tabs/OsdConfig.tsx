import { Gamepad2, MonitorPlay, Plus, RotateCcw, Trash2 } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useMemo, useState } from "react";
import { emit } from "@tauri-apps/api/event";
import { Segmented } from "../components/ui/Segmented";
import { Slider } from "../components/ui/Slider";
import { TabHeader } from "../components/ui/TabHeader";
import { Toggle } from "../components/ui/Toggle";
import { cn } from "../lib/cn";
import { api } from "../lib/ipc";
import { OSD_CATEGORIES, OSD_METRICS, fetchOsdData, type OsdCategory, type OsdData } from "../lib/osd";
import {
  effectiveConfig,
  useOsd,
  useOsdTargets,
  type OsdAppearance,
  type OsdConfig as OsdCfg,
} from "../store/osd";
import { OsdPlate } from "../osd/OsdPlate";

const EMPTY: OsdData = { metrics: null, sensors: null, gpu: null, fps: null };

function cfgOf(s: OsdCfg): OsdCfg {
  return {
    enabled: s.enabled,
    style: s.style,
    scale: s.scale,
    opacity: s.opacity,
    position: s.position,
    rounded: s.rounded,
    oledShift: s.oledShift,
    metrics: s.metrics,
  };
}

export function OsdConfig() {
  const osd = useOsd();
  const { mode, targets, setMode, addTarget, removeTarget, setTargetList, updateTargetConfig } =
    useOsdTargets();
  const [cat, setCat] = useState<OsdCategory>("cpu");
  const [data, setData] = useState<OsdData>(EMPTY);
  const [selected, setSelected] = useState<string | null>(null);
  const [addName, setAddName] = useState("");

  const selectedTarget = useMemo(
    () => targets.find((t) => t.name === selected) ?? null,
    [targets, selected],
  );

  // Global default as a plain config object (used for preview + as the base the
  // per-game override merges onto).
  const globalCfg = cfgOf(osd);

  // The config currently being previewed/edited: the selected game's effective
  // config when one is selected, else the global default.
  const previewCfg = selectedTarget
    ? effectiveConfig(globalCfg, selectedTarget.config)
    : globalCfg;

  // Live preview poll (only while this tab is mounted).
  const needGpu = previewCfg.metrics.some((k) => k.startsWith("gpu."));
  const needFps = previewCfg.metrics.includes("fps");
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      const d = await fetchOsdData(needGpu, needFps);
      if (alive) setData(d);
    };
    void tick();
    const id = window.setInterval(() => void tick(), 1000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [needGpu, needFps]);

  // Push every default-config change to the live overlay window (no-op if closed).
  useEffect(() => useOsd.subscribe((s) => void emit("osd:cfg", cfgOf(s))), []);
  // Push every list change too, so the overlay re-resolves immediately.
  useEffect(
    () =>
      useOsdTargets.subscribe((s) => void emit("osd:targets", { mode: s.mode, targets: s.targets })),
    [],
  );

  function setEnabled(enabled: boolean) {
    osd.setEnabled(enabled);
    api.osdSetVisible(enabled).catch(() => undefined);
  }

  // Appearance/metric editors operate on either the global default or the
  // selected game's override.
  const editingOverride = selectedTarget !== null;
  function applyPatch(patch: Partial<OsdCfg>) {
    if (selectedTarget) updateTargetConfig(selectedTarget.name, patch);
    else osd.update(patch);
  }
  function toggleMetric(key: string) {
    if (selectedTarget) {
      const cur = previewCfg.metrics;
      const next = cur.includes(key) ? cur.filter((k) => k !== key) : [...cur, key];
      updateTargetConfig(selectedTarget.name, { metrics: next });
    } else {
      osd.toggleMetric(key);
    }
  }

  function submitAdd() {
    const n = addName.trim();
    if (!n) return;
    addTarget(n);
    setAddName("");
    setSelected(n.toLowerCase());
  }

  return (
    <>
      <TabHeader
        icon={MonitorPlay}
        title="游戏内监控 OSD"
        subtitle="可定制的低占用游戏叠加层 — 适用于无边框 / 窗口化游戏，所有更改即时生效"
      />
      <div className="min-h-0 flex-1 space-y-4 overflow-auto p-4">
        {/* Enable + preview */}
        <div className="glass hairline rounded-2xl p-4">
          <div className="mb-3 flex items-center justify-between">
            <div>
              <div className="text-[14px] font-semibold text-ink">启用游戏内叠加</div>
              <div className="text-[12px] text-dim">总开关 — 关闭后所有游戏均不显示叠加层</div>
            </div>
            <Toggle checked={osd.enabled} onChange={setEnabled} />
          </div>

          {/* Live preview over a faux game backdrop */}
          <div className="relative overflow-hidden rounded-xl border border-line">
            <div
              className="flex min-h-[120px] p-2"
              style={{
                background:
                  "radial-gradient(120% 140% at 20% 0%, oklch(38% 0.08 250) 0%, oklch(16% 0.03 265) 60%), repeating-linear-gradient(135deg, oklch(20% 0.02 265) 0 14px, oklch(22% 0.02 265) 14px 28px)",
                alignItems: previewCfg.position.startsWith("t") ? "flex-start" : "flex-end",
                justifyContent: previewCfg.position.endsWith("l") ? "flex-start" : "flex-end",
              }}
            >
              <OsdPlate
                metrics={previewCfg.metrics}
                style={previewCfg.style}
                scale={previewCfg.scale}
                opacity={previewCfg.opacity}
                rounded={previewCfg.rounded}
                data={data}
              />
            </div>
            <span className="pointer-events-none absolute right-2 top-2 rounded bg-black/40 px-1.5 py-0.5 text-[10px] text-white/60">
              {editingOverride ? `预览 · ${selectedTarget?.name}` : "预览 · 默认"}
            </span>
          </div>
        </div>

        {/* Per-game white / black list */}
        <div className="glass hairline rounded-2xl p-4">
          <div className="mb-3 flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <Gamepad2 size={15} className="text-accent-bright" />
              <span className="text-[13.5px] font-semibold text-ink">游戏名单 / 白·黑名单</span>
            </div>
            <Segmented
              id="osd-mode"
              value={mode}
              onChange={(v) => setMode(v as "whitelist" | "all")}
              options={[
                { value: "whitelist", label: "白名单" },
                { value: "all", label: "全部显示 + 黑名单" },
              ]}
            />
          </div>
          <div className="mb-3 text-[11.5px] leading-relaxed text-dim">
            {mode === "whitelist"
              ? "仅当焦点游戏在白名单中时显示叠加层 — 启动该游戏即自动出现，无需手动开关。"
              : "默认对所有前台程序显示；黑名单中的程序不显示。"}
          </div>

          {/* Add by exe name */}
          <div className="mb-3 flex items-center gap-2">
            <input
              value={addName}
              onChange={(e) => setAddName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submitAdd();
              }}
              placeholder="可执行文件名，如 cyberpunk2077.exe"
              className="no-drag w-72 rounded-lg border border-line bg-surface2 px-3 py-1.5 text-[12.5px] text-ink outline-none transition-colors focus:border-accent/50"
            />
            <button
              onClick={submitAdd}
              className="no-drag flex items-center gap-1.5 rounded-lg border border-line bg-surface2 px-2.5 py-1.5 text-[12px] text-muted transition-colors hover:bg-surface3 hover:text-ink"
            >
              <Plus size={13} /> 添加
            </button>
          </div>

          {/* Entry list */}
          {targets.length === 0 ? (
            <div className="rounded-lg border border-dashed border-line/70 px-3 py-4 text-center text-[12px] text-dim">
              暂无游戏 — 在此添加，或在任务管理器中右键进程 → “添加游戏内覆盖”。
            </div>
          ) : (
            <div className="space-y-1.5">
              {targets.map((t) => {
                const isSel = t.name === selected;
                const hasOverride = t.config !== undefined;
                return (
                  <div
                    key={t.name}
                    className={cn(
                      "no-drag flex items-center gap-2 rounded-lg border px-3 py-2 text-[12.5px] transition-colors",
                      isSel ? "border-accent/40 bg-accent/10" : "border-line bg-surface2",
                    )}
                  >
                    <button
                      onClick={() => setSelected(isSel ? null : t.name)}
                      className="flex flex-1 items-center gap-2 text-left"
                    >
                      <MonitorPlay
                        size={13}
                        className={isSel ? "text-accent-bright" : "text-dim"}
                      />
                      <span className={cn("flex-1 truncate", isSel ? "text-ink" : "text-muted")}>
                        {t.name}
                      </span>
                      {hasOverride && (
                        <span className="rounded bg-accent/15 px-1.5 py-0.5 text-[10px] text-accent-bright">
                          自定义
                        </span>
                      )}
                    </button>
                    <Segmented
                      id={`osd-list-${t.name}`}
                      value={t.list}
                      onChange={(v) => setTargetList(t.name, v as "white" | "black")}
                      options={[
                        { value: "white", label: "白" },
                        { value: "black", label: "黑" },
                      ]}
                    />
                    <button
                      onClick={() => {
                        removeTarget(t.name);
                        if (isSel) setSelected(null);
                      }}
                      className="grid h-7 w-7 shrink-0 place-items-center rounded-lg text-dim transition-colors hover:bg-danger/15 hover:text-danger"
                      title="移除"
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                );
              })}
            </div>
          )}

          {/* Per-game override controls */}
          {selectedTarget && (
            <div className="mt-3 rounded-xl border border-accent/30 bg-accent/5 p-3">
              <div className="mb-2 flex items-center justify-between gap-3">
                <span className="text-[12.5px] font-semibold text-ink">
                  “{selectedTarget.name}” 的叠加设置
                </span>
                <button
                  onClick={() => updateTargetConfig(selectedTarget.name, undefined)}
                  disabled={selectedTarget.config === undefined}
                  className="no-drag flex items-center gap-1.5 rounded-lg border border-line bg-surface2 px-2.5 py-1 text-[11.5px] text-muted transition-colors hover:bg-surface3 hover:text-ink disabled:cursor-not-allowed disabled:opacity-45"
                >
                  <RotateCcw size={12} /> 用默认
                </button>
              </div>
              <div className="text-[11px] leading-relaxed text-dim">
                {selectedTarget.config === undefined
                  ? "当前沿用全局默认外观与监控项；在下方调整即为该游戏单独定制。"
                  : "已为该游戏单独定制；点“用默认”可还原为全局默认。"}
              </div>
            </div>
          )}
        </div>

        {/* Appearance settings (drive the default, or the selected game's override) */}
        <OsdAppearanceControls cfg={previewCfg} onChange={applyPatch} />

        {/* Monitoring content */}
        <div className="glass hairline rounded-2xl p-4">
          <div className="mb-3 flex items-center justify-between">
            <span className="text-[13.5px] font-semibold text-ink">
              监控内容{editingOverride ? ` · ${selectedTarget?.name}` : "（默认）"}
            </span>
            <button
              onClick={() => applyPatch({ metrics: [] })}
              className="no-drag flex items-center gap-1.5 rounded-lg border border-line bg-surface2 px-2.5 py-1 text-[11.5px] text-muted transition-colors hover:bg-surface3 hover:text-ink"
            >
              <RotateCcw size={12} /> 全部清空
            </button>
          </div>
          <div className="mb-3 flex flex-wrap gap-1.5">
            {OSD_CATEGORIES.map((c) => (
              <button
                key={c.id}
                onClick={() => setCat(c.id)}
                className={cn(
                  "no-drag rounded-lg px-3 py-1.5 text-[12.5px] font-medium transition-colors",
                  cat === c.id ? "bg-accent/15 text-accent-bright" : "text-dim hover:bg-surface3 hover:text-ink",
                )}
              >
                {c.label}
              </button>
            ))}
          </div>
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={cat}
              className="grid gap-2 sm:grid-cols-2"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              transition={{ duration: 0.2, ease: [0.33, 1, 0.68, 1] }}
            >
              {OSD_METRICS.filter((m) => m.cat === cat).map((m) => {
                const on = previewCfg.metrics.includes(m.key);
                return (
                  <button
                    key={m.key}
                    disabled={!m.supported}
                    onClick={() => toggleMetric(m.key)}
                    className={cn(
                      "no-drag flex items-center gap-2.5 rounded-lg border px-3 py-2 text-left text-[12.5px] transition-colors",
                      !m.supported
                        ? "cursor-not-allowed border-line/60 text-dim opacity-55"
                        : on
                          ? "border-accent/40 bg-accent/10 text-ink"
                          : "border-line bg-surface2 text-muted hover:bg-surface3 hover:text-ink",
                    )}
                  >
                    <span
                      className={cn(
                        "grid h-4 w-4 shrink-0 place-items-center rounded border transition-colors",
                        on && m.supported ? "border-accent bg-accent" : "border-line-strong",
                      )}
                    >
                      {on && m.supported && <span className="h-2 w-2 rounded-[2px] bg-white" />}
                    </span>
                    <span className="flex-1">{m.label}</span>
                    {!m.supported && <span className="text-[10.5px] text-dim">需 PresentMon</span>}
                  </button>
                );
              })}
            </motion.div>
          </AnimatePresence>
        </div>
      </div>
    </>
  );
}

interface OsdAppearanceControlsProps {
  cfg: OsdAppearance;
  onChange: (patch: Partial<OsdCfg>) => void;
}

/** The shared style / position / scale / opacity / rounded controls, driven by a
 *  config value + a patch callback so the same UI edits either the global default
 *  or a selected game's per-game override. */
function OsdAppearanceControls({ cfg, onChange }: OsdAppearanceControlsProps) {
  return (
    <div className="glass hairline grid gap-4 rounded-2xl p-4 sm:grid-cols-2">
      <Row label="布局样式">
        <Segmented
          id="osd-style"
          value={cfg.style}
          onChange={(v) => onChange({ style: v as OsdCfg["style"] })}
          options={[
            { value: "horizontal", label: "横向" },
            { value: "vertical", label: "竖排" },
          ]}
        />
      </Row>
      <Row label="屏幕位置">
        <Segmented
          id="osd-pos"
          value={cfg.position}
          onChange={(v) => onChange({ position: v as OsdCfg["position"] })}
          options={[
            { value: "tl", label: "左上" },
            { value: "tr", label: "右上" },
            { value: "bl", label: "左下" },
            { value: "br", label: "右下" },
          ]}
        />
      </Row>
      <div className="sm:col-span-1">
        <Slider
          label="字体大小"
          value={Math.round(cfg.scale * 100)}
          min={80}
          max={200}
          step={10}
          unit="%"
          onChange={(v) => onChange({ scale: v / 100 })}
        />
      </div>
      <div className="sm:col-span-1">
        <Slider
          label="背景不透明度"
          value={Math.round(cfg.opacity * 100)}
          min={0}
          max={90}
          step={5}
          unit="%"
          onChange={(v) => onChange({ opacity: v / 100 })}
        />
      </div>
      <Row label="圆角背板">
        <Toggle checked={cfg.rounded} onChange={(v) => onChange({ rounded: v })} />
      </Row>
      <Row label="OLED 防烧屏">
        <Toggle checked={cfg.oledShift} onChange={(v) => onChange({ oledShift: v })} />
      </Row>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-[12.5px] text-muted">{label}</span>
      <div className="no-drag shrink-0">{children}</div>
    </div>
  );
}
