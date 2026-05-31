import { motion } from "motion/react";
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

interface TabHeaderProps {
  icon: LucideIcon;
  title: string;
  subtitle?: string;
  actions?: ReactNode;
}

export function TabHeader({ icon: Icon, title, subtitle, actions }: TabHeaderProps) {
  return (
    <div className="flex items-start justify-between gap-4 px-6 pb-4 pt-5">
      <div className="flex items-center gap-3.5">
        <motion.div
          initial={{ scale: 0.8, opacity: 0, rotate: -8 }}
          animate={{ scale: 1, opacity: 1, rotate: 0 }}
          transition={{ type: "spring", stiffness: 320, damping: 20 }}
          className="grid h-11 w-11 place-items-center rounded-xl grad-accent glow text-white"
        >
          <Icon size={21} strokeWidth={2.2} />
        </motion.div>
        <div>
          <h1 className="text-[18px] font-semibold leading-tight text-ink">{title}</h1>
          {subtitle && <p className="text-[12.5px] text-muted">{subtitle}</p>}
        </div>
      </div>
      {actions && <div className="no-drag flex items-center gap-2">{actions}</div>}
    </div>
  );
}
