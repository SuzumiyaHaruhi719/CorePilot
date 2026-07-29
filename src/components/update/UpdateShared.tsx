import { AlertTriangle, Ban, Loader2 } from "lucide-react";
import { cn } from "../../lib/cn";
import { useTf } from "../../lib/i18n";
import type { UpdateBlocker, UpdateStateEvent } from "../../lib/ipc";

/** Human-readable phase label for the install progress line. */
const PHASE_LABEL: Record<UpdateStateEvent["phase"], string> = {
  idle: "",
  checking: "正在检查…",
  downloading: "正在下载…",
  verifying: "正在校验签名…",
  staging: "正在解压…",
  swapping: "正在替换程序文件…",
  ready: "即将重启…",
  failed: "",
};

/** Format a byte count for the download line. */
function mb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * The reasons an install can't (or shouldn't) run right now.
 *
 * `block` and `warn` look different on purpose: a block means the button is
 * disabled and the user has something to go fix, a warn means "this costs you
 * something, your call". Rendering them identically would train the user to
 * click past both.
 */
export function BlockerList({ blockers }: { blockers: UpdateBlocker[] }) {
  if (blockers.length === 0) return null;
  return (
    <div className="mt-3 space-y-1.5">
      {blockers.map((b) => {
        const blocking = b.severity === "block";
        return (
          <div
            key={b.id}
            className={cn(
              "flex items-start gap-2 rounded-lg border px-3 py-2 text-[11.5px] leading-relaxed",
              blocking
                ? "border-danger/40 bg-danger/10 text-danger"
                : "border-warn/40 bg-warn/10 text-warn",
            )}
          >
            {blocking ? (
              <Ban size={13} className="mt-0.5 shrink-0" />
            ) : (
              <AlertTriangle size={13} className="mt-0.5 shrink-0" />
            )}
            <span className="min-w-0">{b.message}</span>
          </div>
        );
      })}
    </div>
  );
}

/** Download / install progress. Shows a determinate bar when the server sent a
 *  Content-Length and a phase line otherwise — never a fake percentage. */
export function UpdateProgress({
  phase,
  downloaded,
  total,
}: {
  phase: UpdateStateEvent["phase"];
  downloaded: number;
  total: number | null;
}) {
  const tf = useTf();
  if (phase === "idle" || phase === "failed") return null;
  const pct = total && total > 0 ? Math.min(100, (downloaded / total) * 100) : null;

  return (
    <div className="mt-3">
      <div className="mb-1.5 flex items-center justify-between gap-3 text-[11.5px] text-dim">
        <span className="flex items-center gap-1.5">
          <Loader2 size={12} className="animate-spin" />
          {PHASE_LABEL[phase]}
        </span>
        {phase === "downloading" && downloaded > 0 && (
          <span className="nums">
            {total ? tf(`${mb(downloaded)} / ${mb(total)}`, `${mb(downloaded)} / ${mb(total)}`) : mb(downloaded)}
          </span>
        )}
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-surface3">
        <div
          className={cn("h-full rounded-full bg-accent-bright", pct === null && "w-1/3 animate-pulse")}
          style={pct === null ? undefined : { width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

/** Release notes as plain, scrollable text. Deliberately not rendered as
 *  markdown: the notes come off a GitHub release body, i.e. remote content, and
 *  a renderer is a whole attack surface for a paragraph of changelog. */
export function ReleaseNotes({ notes }: { notes: string | null }) {
  if (!notes?.trim()) return null;
  return (
    <div className="hairline mt-3 max-h-[220px] overflow-auto rounded-xl border border-line bg-surface2/40 px-3.5 py-3">
      <pre className="whitespace-pre-wrap break-words font-sans text-[12px] leading-relaxed text-muted">
        {notes.trim()}
      </pre>
    </div>
  );
}
