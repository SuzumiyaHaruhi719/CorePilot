import { Check } from "lucide-react";
import { motion } from "motion/react";

interface FeaturePanelProps {
  label?: string;
  points: string[];
  note?: string;
}

export function FeaturePanel({ label = "模块能力", points, note }: FeaturePanelProps) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
      className="glass hairline rounded-2xl p-6"
    >
      <div className="mb-4 flex items-center gap-2">
        <motion.span
          animate={{ opacity: [0.4, 1, 0.4] }}
          transition={{ duration: 2.2, repeat: Infinity, ease: "easeInOut" }}
          className="h-2 w-2 rounded-full bg-accent glow-sm"
        />
        <span className="text-[11.5px] font-semibold uppercase tracking-[0.14em] text-muted">{label}</span>
      </div>
      <ul className="grid gap-2.5 sm:grid-cols-2">
        {points.map((point, i) => (
          <motion.li
            key={point}
            initial={{ opacity: 0, x: -8 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: 0.04 * i, duration: 0.3 }}
            className="flex items-center gap-2.5 text-[13px] text-ink"
          >
            <span className="grid h-5 w-5 shrink-0 place-items-center rounded-md bg-accent/15 text-accent">
              <Check size={13} />
            </span>
            {point}
          </motion.li>
        ))}
      </ul>
      {note && <p className="mt-4 text-[12px] leading-relaxed text-dim">{note}</p>}
    </motion.div>
  );
}
