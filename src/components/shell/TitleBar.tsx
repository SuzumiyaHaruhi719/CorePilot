import { getCurrentWindow } from "@tauri-apps/api/window";
import { Cpu, Minus, Square, X } from "lucide-react";
import { motion } from "motion/react";
import type { ReactNode } from "react";
import { cn } from "../../lib/cn";

const appWindow = getCurrentWindow();

interface WinButtonProps {
  children: ReactNode;
  onClick: () => void;
  danger?: boolean;
}

function WinButton({ children, onClick, danger }: WinButtonProps) {
  return (
    <motion.button
      whileHover={{ scale: 1.12 }}
      whileTap={{ scale: 0.9 }}
      onClick={onClick}
      className={cn(
        "no-drag grid h-7 w-7 place-items-center rounded-lg text-muted transition-colors",
        danger ? "hover:bg-danger hover:text-white" : "hover:bg-surface3 hover:text-ink",
      )}
    >
      {children}
    </motion.button>
  );
}

interface TitleBarProps {
  cpuName?: string;
}

export function TitleBar({ cpuName }: TitleBarProps) {
  return (
    <header
      data-tauri-drag-region
      className="relative z-20 flex h-10 shrink-0 items-center justify-between border-b border-line px-3"
    >
      <div data-tauri-drag-region className="flex items-center gap-2.5">
        <motion.div
          initial={{ rotate: -90, opacity: 0, scale: 0.6 }}
          animate={{ rotate: 0, opacity: 1, scale: 1 }}
          transition={{ type: "spring", stiffness: 200, damping: 15 }}
          className="grid h-[26px] w-[26px] place-items-center rounded-[9px] grad-accent glow-sm text-white"
        >
          <Cpu size={15} strokeWidth={2.4} />
        </motion.div>
        <span className="brand-text display text-[14px] font-bold uppercase tracking-[0.18em] text-ink glow-text">
          Core<span className="text-accent-bright">Pilot</span>
        </span>
        {cpuName && (
          <span className="no-drag ml-1 hidden items-center gap-1.5 rounded-md border border-line bg-surface2 px-2 py-[3px] text-[11px] font-medium text-muted md:inline-flex">
            <span className="h-1.5 w-1.5 rounded-full bg-ok glow-sm" style={{ ["--glow" as string]: "var(--color-ok)" }} />
            {cpuName}
          </span>
        )}
      </div>
      <div className="flex items-center gap-1">
        <WinButton onClick={() => void appWindow.minimize()}>
          <Minus size={15} />
        </WinButton>
        <WinButton onClick={() => void appWindow.toggleMaximize()}>
          <Square size={11} />
        </WinButton>
        <WinButton danger onClick={() => void appWindow.close()}>
          <X size={15} />
        </WinButton>
      </div>
    </header>
  );
}
