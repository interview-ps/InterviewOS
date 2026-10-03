"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

const TABS = [
  { href: "/prepare", label: "Plan" },
  { href: "/prepare/stories", label: "Stories" },
];

export default function PrepareLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  return (
    <div className="space-y-5">
      <nav aria-label="Prepare sections" className="flex gap-1 border-b border-line">
        {TABS.map((t) => {
          const active =
            t.href === "/prepare" ? pathname === "/prepare" : pathname.startsWith(t.href);
          return (
            <Link
              key={t.href}
              href={t.href}
              aria-current={active ? "page" : undefined}
              className={`-mb-px border-b-2 px-3 py-2 text-sm ${
                active
                  ? "border-blue font-semibold text-navy"
                  : "border-transparent text-muted hover:text-ink"
              }`}
            >
              {t.label}
            </Link>
          );
        })}
      </nav>
      {children}
    </div>
  );
}
