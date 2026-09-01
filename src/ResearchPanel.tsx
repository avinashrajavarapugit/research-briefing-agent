import { Badge, Button, Surface } from "@cloudflare/kumo";
import { CheckCircleIcon, XCircleIcon } from "@phosphor-icons/react";
import type { BriefingState } from "./server";

export type WorkflowProgress = {
  step?: string;
  status?: "pending" | "running" | "complete" | "error";
  message?: string;
  percent?: number;
  sources?: Array<{ provider: string; title: string; url: string }>;
};

type Props = {
  status: BriefingState["status"];
  instanceId: string | null;
  progress: WorkflowProgress | null;
  onApprove: () => void;
  onReject: () => void;
};

const STATUS_LABEL: Record<BriefingState["status"], string> = {
  idle: "Idle",
  researching: "Researching",
  "awaiting-approval": "Waiting for your approval",
  complete: "Brief ready",
  error: "Research failed"
};

export function ResearchPanel({
  status,
  instanceId,
  progress,
  onApprove,
  onReject
}: Props) {
  if (status === "idle") return null;

  const awaitingApproval = status === "awaiting-approval";
  // The final progress event can land before the completion state does.
  const percent =
    status === "complete" ? 100 : Math.round((progress?.percent ?? 0) * 100);
  const sources = progress?.sources ?? [];

  return (
    <Surface className="max-w-3xl mx-auto mb-3 rounded-xl border border-kumo-line p-4">
      <div className="flex items-center justify-between gap-3 mb-2">
        <div className="flex items-center gap-2">
          <span className="font-medium">{STATUS_LABEL[status]}</span>
          {status !== "complete" && progress?.step && (
            <Badge>{progress.step}</Badge>
          )}
        </div>
        <span className="text-kumo-subtle text-sm">{percent}%</span>
      </div>

      <div
        className="h-2 w-full rounded-full bg-kumo-control overflow-hidden"
        role="progressbar"
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="Research progress"
      >
        <div
          className={`h-full transition-all duration-500 ${
            status === "error" ? "bg-red-500" : "bg-kumo-brand"
          }`}
          style={{ width: `${percent}%` }}
        />
      </div>

      {status !== "complete" && progress?.message && (
        <p className="mt-2 text-sm text-kumo-subtle">{progress.message}</p>
      )}

      {awaitingApproval && (
        <div className="mt-3">
          {sources.length > 0 && (
            <ul className="mb-3 space-y-1">
              {sources.map((s) => (
                <li key={s.url} className="text-sm">
                  <span className="mr-2 text-kumo-subtle">[{s.provider}]</span>
                  <a
                    href={s.url}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="underline"
                  >
                    {s.title}
                  </a>
                </li>
              ))}
            </ul>
          )}

          <div className="flex gap-2">
            <Button
              onClick={onApprove}
              disabled={!instanceId}
              icon={<CheckCircleIcon size={16} />}
            >
              Approve sources
            </Button>
            <Button
              variant="ghost"
              onClick={onReject}
              disabled={!instanceId}
              icon={<XCircleIcon size={16} />}
            >
              Reject
            </Button>
          </div>
        </div>
      )}
    </Surface>
  );
}
