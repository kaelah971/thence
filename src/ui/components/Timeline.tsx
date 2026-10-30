import type { TimelineStep } from "@/ui/lib/status";
import { cn } from "@/ui/lib/cn";
import { Icon } from "./Icon";
import styles from "./shell.module.css";

export function Timeline({ steps, tone = "light" }: { steps: readonly TimelineStep[]; tone?: "light" | "dark" }): React.JSX.Element {
  return (
    <ol className={cn(styles.timeline, tone === "dark" && styles.timelineDark)}>
      {steps.map((step) => (
        <li key={step.key} className={styles.step} data-state={step.state}>
          <span className={styles.stepNode} aria-hidden="true">
            {step.state === "done" && <Icon name="check" size={13} strokeWidth={3} />}
            {step.state === "paused" && <Icon name="clock" size={13} strokeWidth={2.4} />}
          </span>
          <div className={styles.stepText}>
            <p className={styles.stepLabel}>
              {step.label}
              <span className="sr-only">
                {step.state === "done" ? " — done" : step.state === "current" ? " — current step" : step.state === "paused" ? " — waiting" : " — not yet"}
              </span>
            </p>
            {(step.state === "current" || step.state === "paused") && <p className={styles.stepDetail}>{step.detail}</p>}
          </div>
        </li>
      ))}
    </ol>
  );
}
