import { useEffect, useRef, useState } from "react";
import { ArrowLeftIcon, CheckIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { BUILD_STEPS, LOG_RETENTION, type BuildState } from "@/lib/protocol";
import { cn } from "@/lib/utils";

/** Full-screen build view: the step list on the left, live narration and log on the right. */
export function BuildProgress({
  state,
  onCancel,
  onBack,
}: {
  state: BuildState;
  onCancel: () => void;
  /** Present when a build is running over an existing homepage — offers a way back to it. */
  onBack?: () => void;
}) {
  const { stepIndex, detail, narration, logs } = state;
  const [elapsed, setElapsed] = useState(0);
  const narrRef = useRef<HTMLDivElement>(null);
  const logRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    const t = setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => clearInterval(t);
  }, []);

  // Keep the streaming panels pinned to their latest line.
  useEffect(() => {
    if (narrRef.current) narrRef.current.scrollTop = narrRef.current.scrollHeight;
  }, [narration]);
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [logs]);

  const mm = String(Math.floor(elapsed / 60)).padStart(2, "0");
  const ss = String(elapsed % 60).padStart(2, "0");

  return (
    <div className="grid min-h-screen w-screen grid-cols-1 bg-background text-foreground md:h-screen md:grid-cols-2">
      <section className="flex min-h-0 justify-center px-6 py-10 md:justify-end md:px-14 md:py-16">
        <div className="flex w-full max-w-md min-h-0 flex-col">
          <div className="mb-8 flex items-center justify-between">
            <h1 className="text-xl font-semibold tracking-tight">Building your homepage</h1>
            <span className="rounded-full border bg-muted px-3 py-1 font-mono text-xs text-muted-foreground tabular-nums">
              {mm}:{ss}
            </span>
          </div>

          <ol className="flex flex-col">
            {BUILD_STEPS.map((step, i) => {
              const status = i < stepIndex ? "done" : i === stepIndex ? "active" : "pending";
              const last = i === BUILD_STEPS.length - 1;
              return (
                <li key={step.label} className={cn("relative grid grid-cols-[28px_1fr] gap-3.5", !last && "pb-6")}>
                  {!last && (
                    <span
                      aria-hidden
                      className={cn(
                        "absolute top-7 bottom-0 left-[13px] w-0.5",
                        status === "done" ? "bg-emerald-500/40" : "bg-border",
                      )}
                    />
                  )}
                  <span
                    className={cn(
                      "z-10 grid size-7 place-items-center rounded-full border-2 text-xs font-bold transition-colors",
                      status === "done" && "border-emerald-600 bg-emerald-600 text-white",
                      status === "active" &&
                        "border-primary bg-primary/10 text-primary motion-safe:[animation:hb-ring_1.8s_ease-in-out_infinite]",
                      status === "pending" && "border-border bg-background text-muted-foreground",
                    )}
                  >
                    {status === "done" ? <CheckIcon className="size-3.5" /> : i + 1}
                  </span>
                  <div className="pt-0.5">
                    <div
                      className={cn(
                        "text-[15px] font-medium",
                        status === "pending" ? "text-muted-foreground" : "text-foreground",
                        status === "active" && "font-semibold",
                      )}
                    >
                      {step.label}
                    </div>
                    {status === "active" && detail && (
                      <div className="mt-0.5 font-mono text-xs text-muted-foreground">{detail}</div>
                    )}
                  </div>
                </li>
              );
            })}
          </ol>

          <div className="mt-9 flex gap-2.5">
            <Button variant="outline" onClick={onCancel} className="hover:border-destructive hover:text-destructive">
              Cancel
            </Button>
            {onBack && (
              <Button variant="ghost" onClick={onBack}>
                <ArrowLeftIcon /> Back to homepage
              </Button>
            )}
          </div>
        </div>
      </section>

      <section className="flex min-h-0 justify-center border-t bg-muted/50 px-6 py-10 md:justify-start md:border-t-0 md:border-l md:px-14 md:py-16">
        <div className="flex w-full max-w-md min-h-0 flex-col">
          <div className="mb-2.5 text-[11px] font-semibold tracking-[0.12em] text-muted-foreground uppercase">Agent</div>
          <div
            ref={narrRef}
            className="max-h-[42vh] flex-[0_1_auto] overflow-y-auto rounded-xl border bg-card px-5 py-4 text-[15px] leading-relaxed whitespace-pre-wrap shadow-xs"
          >
            {narration || "Warming up — reading what you’ve been browsing…"}
          </div>

          {logs.length > 0 && (
            <>
              <div className="mt-5 mb-2.5 text-[11px] font-semibold tracking-[0.12em] text-muted-foreground uppercase">
                Activity log
              </div>
              <pre
                ref={logRef}
                className="m-0 min-h-[90px] flex-1 overflow-auto rounded-xl bg-zinc-950 px-4 py-3.5 font-mono text-xs leading-relaxed break-words whitespace-pre-wrap text-emerald-300"
              >
                {logs.slice(-LOG_RETENTION).join("\n")}
              </pre>
            </>
          )}
        </div>
      </section>
    </div>
  );
}
