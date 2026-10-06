import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useState, type ReactNode } from "react";
import { cn } from "../../lib/cn";
import { useTf } from "../../lib/i18n";

const appWindow = getCurrentWindow();

/** Windows 11 caption button: 46px wide, full bar height, square, no motion. */
function Caption({ children, onClick, label, close }: { children: ReactNode; onClick: () => void; label: string; close?: boolean }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={cn(
        "no-drag grid h-10 w-[46px] place-items-center text-muted transition-colors duration-100",
        "focus-visible:outline-none focus-visible:bg-surface2",
        close ? "hover:bg-[#c42b1c] hover:text-white active:bg-[#c42b1c]/80" : "hover:bg-surface2 hover:text-ink active:bg-surface3",
      )}
    >
      {children}
    </button>
  );
}

/** The CorePilot mark: a die with one core lit — "pick the core". */
export function BrandMark({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 18 18" aria-hidden className="shrink-0">
      <g stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" className="text-dim">
        <path d="M6 1.5v2M9 1.5v2M12 1.5v2M6 14.5v2M9 14.5v2M12 14.5v2M1.5 6h2M1.5 9h2M1.5 12h2M14.5 6h2M14.5 9h2M14.5 12h2" />
      </g>
      <rect x="3.75" y="3.75" width="10.5" height="10.5" rx="2.25" fill="none" stroke="currentColor" strokeWidth="1.3" className="text-ink" />
      <rect x="6.25" y="6.25" width="2.5" height="2.5" rx="0.6" fill="var(--color-accent)" />
      <rect x="9.25" y="6.25" width="2.5" height="2.5" rx="0.6" fill="currentColor" className="text-dim" opacity="0.6" />
      <rect x="6.25" y="9.25" width="2.5" height="2.5" rx="0.6" fill="currentColor" className="text-dim" opacity="0.6" />
      <rect x="9.25" y="9.25" width="2.5" height="2.5" rx="0.6" fill="currentColor" className="text-dim" opacity="0.6" />
    </svg>
  );
}

interface TitleBarProps {
  cpuName?: string;
}

export function TitleBar({ cpuName }: TitleBarProps) {
  const tf = useTf();
  const [maximized, setMaximized] = useState(false);

  // Track maximize state so the caption glyph matches Windows (□ vs ❐).
  useEffect(() => {
    let un: (() => void) | undefined;
    let alive = true;
    const sync = () => void appWindow.isMaximized().then((m) => alive && setMaximized(m)).catch(() => undefined);
    sync();
    void appWindow
      .onResized(sync)
      .then((f) => (alive ? (un = f) : f()))
      .catch(() => undefined);
    return () => {
      alive = false;
      un?.();
    };
  }, []);

  return (
    <header data-tauri-drag-region className="relative z-20 flex h-10 shrink-0 items-center justify-between">
      <div data-tauri-drag-region className="flex min-w-0 items-center gap-2.5 pl-4">
        <BrandMark />
        <span data-tauri-drag-region className="font-title text-[13px] font-semibold text-ink">
          CorePilot
        </span>
        {cpuName && (
          <span data-tauri-drag-region className="ml-2 hidden min-w-0 truncate border-l border-line pl-3 text-[12px] text-dim md:block">
            {cpuName}
          </span>
        )}
      </div>
      <div className="flex items-center">
        <Caption label={tf("最小化", "Minimize")} onClick={() => void appWindow.minimize()}>
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
            <path d="M0 5h10" stroke="currentColor" strokeWidth="1" />
          </svg>
        </Caption>
        <Caption label={maximized ? tf("还原", "Restore") : tf("最大化", "Maximize")} onClick={() => void appWindow.toggleMaximize()}>
          {maximized ? (
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden>
              <rect x="0.5" y="2.5" width="7" height="7" rx="1" stroke="currentColor" />
              <path d="M2.5 2.5V1.5a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1h-1" stroke="currentColor" />
            </svg>
          ) : (
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden>
              <rect x="0.5" y="0.5" width="9" height="9" rx="1.2" stroke="currentColor" />
            </svg>
          )}
        </Caption>
        <Caption close label={tf("关闭窗口", "Close")} onClick={() => void appWindow.close()}>
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
            <path d="M0.5 0.5l9 9M9.5 0.5l-9 9" stroke="currentColor" strokeWidth="1" />
          </svg>
        </Caption>
      </div>
    </header>
  );
}
