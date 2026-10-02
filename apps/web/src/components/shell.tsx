"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { api, type RuntimeStatus } from "@/lib/api";

const NAV = [
  { href: "/", label: "Dashboard" },
  { href: "/target", label: "Target Role" },
  { href: "/prep", label: "Prep Plan" },
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
        <div className="ml-auto">
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
