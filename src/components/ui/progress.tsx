import * as React from "react";
import { cn } from "../../lib/utils";

export interface ProgressProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Progress value 0-100 */
  value?: number;
  /** Optional label text shown inside the bar */
  label?: string;
}

const Progress = React.forwardRef<HTMLDivElement, ProgressProps>(
  ({ className, value = 0, label, ...props }, ref) => {
    const clamped = Math.max(0, Math.min(100, value));
    return (
      <div
        ref={ref}
        role="progressbar"
        aria-valuenow={clamped}
        aria-valuemin={0}
        aria-valuemax={100}
        className={cn("progress-bar", className)}
        {...props}
      >
        <div
          className="progress-fill"
          style={{ width: `${clamped}%` }}
        >
          {label && <span className="progress-label">{label}</span>}
        </div>
      </div>
    );
  }
);
Progress.displayName = "Progress";

export { Progress };
