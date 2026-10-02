"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { api, type RuntimeStatus, type TargetListItem } from "@/lib/api";

const NAV = [
  { href: "/", label: "Dashboard" },
  { href: "/target", label: "Target Role" },
  { href: "/prep", label: "Prep Plan" },
  { href: "/stories", label: "Stories" },
  { href: "/interview", label: "Interview" },
  { href: "/readiness", label: "Readiness" },
  { href: "/history", label: "History" },
  { href: "/settings", label: "Settings" },
];

function RuntimeBadge({ status }: { status: RuntimeStatus | null }) {
  let dot = "●";
  let text = "Checking runtime…";
  let cls = "text-muted";
  if (status) {
    if (status.mode === "mock") {
      text = "Mock Runtime";
      cls = "text-blue";
    } else if (status.available) {
      text = "Local Codex Connected";
      cls = "text-green";
    } else {
      text = "Codex Not Available";
      dot = "○";
      cls = "text-muted";
    }
  }
  return (
    <span aria-live="polite" className={`inline-flex items-center gap-1.5 text-sm ${cls}`}>
      <span aria-hidden>{dot}</span>
      {text}
    </span>
  );
}

function TargetSwitcher() {
  const [targets, setTargets] = useState<TargetListItem[]>([]);
  const [switching, setSwitching] = useState(false);

  useEffect(() => {
    api.listTargets().then(setTargets).catch(() => setTargets([]));
  }, []);

  if (targets.length === 0) return null;
  const active = targets.find((t) => t.active);

  return (
    <label className="flex items-center gap-2 text-sm text-muted">
      <span className="hidden sm:inline">Target</span>
      <select
        aria-label="Active target role"
        value={active?.id ?? ""}
        disabled={switching}
        onChange={(e) => {
          setSwitching(true);
          api
            .activateTarget(e.target.value)
            .then(() => window.location.reload())
            .catch(() => setSwitching(false));
        }}
        className="max-w-56 rounded-[0.6rem] border border-line bg-surface px-2 py-1 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-accent"
      >
        {targets.map((t) => (
          <option key={t.id} value={t.id}>
            {t.role} — {t.company}
          </option>
        ))}
      </select>
    </label>
  );
}

export function Shell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const [status, setStatus] = useState<RuntimeStatus | null>(null);

  useEffect(() => {
    let cancelled = false;
    const poll = () =>
      api
        .runtimeStatus()
        .then((s) => !cancelled && setStatus(s))
        .catch(() => !cancelled && setStatus(null));
    poll();
    const timer = setInterval(poll, 30_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  return (
    <div className="flex min-h-screen flex-col">
      <header className="flex items-center gap-3 border-b border-line bg-surface px-5 py-3">
        <Image src="/interview-ps-logo.png" alt="interview.ps logo" width={28} height={28} />
        <div className="font-display text-base font-semibold text-navy">
          Interview OS <span className="font-normal text-muted">· by interview.ps</span>
        </div>
        <div className="ml-auto flex items-center gap-4">
          <TargetSwitcher />
          <RuntimeBadge status={status} />
        </div>
      </header>
      <div className="flex flex-1">
        <nav aria-label="Primary" className="w-48 shrink-0 border-r border-line bg-surface px-3 py-4">
          <ul className="space-y-1">
            {NAV.map((item) => {
              const active =
                item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    aria-current={active ? "page" : undefined}
                    className={`block rounded-[0.6rem] px-3 py-2 text-sm ${
                      active
                        ? "bg-tint font-semibold text-navy"
                        : "text-muted hover:bg-page hover:text-ink"
                    }`}
                  >
                    {item.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
        <main className="flex-1 px-6 py-6">{children}</main>
      </div>
    </div>
  );
}
