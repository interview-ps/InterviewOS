import type { UIAction, UINode } from "@interview-os/frontend-types";
import {
  Badge,
  Bar,
  Button,
  Card,
  EmptyState,
  EvidenceList,
  SkillScore,
  Stat,
  Tabs,
} from "./components.js";
import { ReadinessChart } from "./sparkline.js";

export interface DeclarativeRendererProps {
  node: UINode;
  /** Host-implemented action dispatcher — actions never run inside a plugin. */
  onAction?: (action: UIAction) => void;
}

const GAP = { sm: "gap-2", md: "gap-4", lg: "gap-6" } as const;
const TEXT_TONE: Record<string, string> = {
  green: "text-green",
  amber: "text-accent",
  red: "text-danger",
  blue: "text-blue",
  muted: "text-muted",
};

function Node({ node, onAction }: { node: UINode; onAction?: (a: UIAction) => void }) {
  switch (node.type) {
    case "stack":
      return (
        <div className={`flex flex-col ${GAP[node.gap ?? "md"]}`}>
          {node.children.map((c, i) => (
            <Node key={i} node={c} onAction={onAction} />
          ))}
        </div>
      );
    case "row":
      return (
        <div className="flex flex-wrap items-center gap-4">
          {node.children.map((c, i) => (
            <Node key={i} node={c} onAction={onAction} />
          ))}
        </div>
      );
    case "card":
      return (
        <Card>
          {node.title && <h3 className="mb-1 text-base font-semibold text-navy">{node.title}</h3>}
          {node.subtitle && <p className="mb-3 text-sm text-muted">{node.subtitle}</p>}
          <div className="flex flex-col gap-4">
            {node.children.map((c, i) => (
              <Node key={i} node={c} onAction={onAction} />
            ))}
          </div>
        </Card>
      );
    case "heading":
      return node.level === 3 ? (
        <h3 className="text-base font-semibold text-navy">{node.text}</h3>
      ) : (
        <h2 className="text-lg font-semibold text-navy">{node.text}</h2>
      );
    case "text":
      return <p className={`text-sm ${TEXT_TONE[node.tone ?? ""] ?? "text-ink"}`}>{node.text}</p>;
    case "stat":
      return <Stat label={node.label} value={node.value} trend={node.trend} tone={node.tone} />;
    case "badge":
      return <Badge tone={node.tone}>{node.text}</Badge>;
    case "skillScore":
      return <SkillScore label={node.label ?? node.skillId} score={node.score} confidence={node.confidence} />;
    case "progressList":
      return (
        <ul className="space-y-2">
          {node.items.map((it, i) => (
            <li key={i}>
              <div className="mb-1 flex items-center justify-between text-sm">
                <span className="text-ink">{it.label}</span>
                <span className="text-muted">{Math.round(it.value * 100)}%</span>
              </div>
              <Bar value={it.value} tone={it.tone === "red" ? "amber" : it.tone ?? "blue"} />
            </li>
          ))}
        </ul>
      );
    case "list":
      return (
        <ul className="list-disc space-y-1 pl-5 text-sm">
          {node.items.map((it, i) => (
            <li key={i} className={TEXT_TONE[it.tone ?? ""] ?? "text-ink"}>
              {it.text}
            </li>
          ))}
        </ul>
      );
    case "evidenceList":
      return <EvidenceList items={node.items} />;
    case "readinessChart":
      return <ReadinessChart points={node.points} label={node.label} />;
    case "tabs":
      return (
        <Tabs
          tabs={node.tabs.map((t) => ({
            label: t.label,
            children: (
              <div className="flex flex-col gap-4">
                {t.children.map((c, i) => (
                  <Node key={i} node={c} onAction={onAction} />
                ))}
              </div>
            ),
          }))}
        />
      );
    case "emptyState":
      return <EmptyState title={node.title} description={node.description} />;
    case "divider":
      return <hr className="border-line" />;
    case "button":
      return (
        <div>
          <Button
            variant={node.variant ?? "primary"}
            onClick={onAction ? () => onAction(node.action) : undefined}
          >
            {node.label}
          </Button>
        </div>
      );
  }
}

/**
 * Renders a validated declarative UI tree with design-system components.
 * The tree cannot produce raw HTML, styles, links or images — every node maps
 * to a fixed component.
 */
export function DeclarativeRenderer({ node, onAction }: DeclarativeRendererProps) {
  return <Node node={node} onAction={onAction} />;
}
