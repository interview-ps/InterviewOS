import { Link, useLocation } from "react-router";

const TABS = [
  { href: "/prepare", label: "Plan" },
  { href: "/prepare/stories", label: "Stories" },
];

/** Compact Plan | Stories tabs, rendered inside each Prepare screen toolbar. */
export function PrepareTabs() {
  const pathname = useLocation().pathname;
  return (
    <nav aria-label="Prepare sections" className="flex items-center gap-1">
      {TABS.map((t) => {
        const active =
          t.href === "/prepare" ? pathname === "/prepare" : pathname.startsWith(t.href);
        return (
          <Link
            key={t.href}
            to={t.href}
            aria-current={active ? "page" : undefined}
            className={`-mb-px border-b-2 px-2.5 py-1.5 text-[13px] ${
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
  );
}
