import { Link, useLocation } from "react-router";
import { useEffect, useState, type ReactNode } from "react";
import { api, type RuntimeStatus, type TargetListItem } from "@/lib/api";
import { CommandPalette } from "@/components/command-palette";
import { useUIContributions } from "@/components/plugin-ui";
import { runtimeLabel } from "@/lib/runtime";
import { ToastHost, toast } from "@/components/ui";

const NAV = [
  { href: "/", label: "Home" },
  { href: "/target", label: "Target" },
  { href: "/prepare", label: "Prepare" },
  { href: "/interview", label: "Interview" },
  { href: "/readiness", label: "Readiness" },
  { href: "/resume", label: "Resume" },
  { href: "/history", label: "History" },
  { href: "/packs", label: "Packs" },
  { href: "/skills", label: "Skills & plugins" },
  { href: "/settings", label: "Settings" },
];

function RuntimeBadge({ status }: { status: RuntimeStatus | null }) {
  let dot = "●";
  let text = "Checking runtime…";
  let cls = "text-muted";
  if (status) {
    const label = runtimeLabel(status.mode);
    if (status.mode === "mock") {
      text = "Mock Runtime";
      cls = "text-blue";
    } else if (status.available) {
      text = `${label} Connected`;
      cls = "text-green";
    } else {
      text = `${label} Not Available`;
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
            .then(() => {
              toast("Target switched");
              window.location.reload();
            })
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

/** v0.4: fixed icon vocabulary for plugin navigation (inline SVGs). */
function PluginIcon({ icon }: { icon: string }) {
  const paths: Record<string, string> = {
    database: "M12 3c-4 0-7 1.3-7 3v12c0 1.7 3 3 7 3s7-1.3 7-3V6c0-1.7-3-3-7-3Zm-7 6c1.2 1 4 1.6 7 1.6s5.8-.6 7-1.6M5 15c1.2 1 4 1.6 7 1.6s5.8-.6 7-1.6",
    cloud: "M7 18a4 4 0 0 1-.6-8 5.5 5.5 0 0 1 10.7 1.5A3.5 3.5 0 0 1 17 18H7Z",
    code: "m8 7-5 5 5 5m8-10 5 5-5 5",
    book: "M5 4h9a3 3 0 0 1 3 3v13H8a3 3 0 0 0-3 3V4Zm0 0v16",
    chart: "M4 20V10m6 10V4m6 16v-7",
    puzzle: "M9 4h6v4a2 2 0 1 0 4 0V4h-6v4a2 2 0 1 1-4 0V4Zm0 0H4v6h4a2 2 0 1 1 0 4H4v6h6v-4a2 2 0 1 0 4 0v4h6v-6h-4",
    shield: "M12 3 5 6v5c0 4.5 3 8 7 10 4-2 7-5.5 7-10V6l-7-3Z",
    star: "m12 3 2.7 5.6 6.3.9-4.5 4.4 1 6.2-5.5-3-5.5 3 1-6.2L3 9.5l6.3-.9L12 3Z",
  };
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      className="h-4 w-4 shrink-0"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={paths[icon] ?? paths.puzzle!} />
    </svg>
  );
}

function NavList({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = useLocation().pathname;
  const contributions = useUIContributions();
  const pluginNav = contributions.flatMap((p) =>
    p.navigation.map((n) => ({
      pluginId: p.pluginId,
      label: n.label,
      icon: n.icon,
      to: `/plugins/${p.pluginId}${n.page === "/" ? "" : n.page}`,
    })),
  );
  return (
    <ul className="space-y-1">
      {NAV.map((item) => {
        const active =
          item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
        return (
          <li key={item.href}>
            <Link
              to={item.href}
              aria-current={active ? "page" : undefined}
              onClick={onNavigate}
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
      {pluginNav.length > 0 && (
        <li>
          <p className="mt-4 px-3 text-[0.7rem] font-semibold uppercase tracking-wide text-muted">
            Plugins
          </p>
          <ul className="mt-1 space-y-1">
            {pluginNav.map((item) => (
              <li key={`${item.pluginId}:${item.to}`}>
                <Link
                  to={item.to}
                  onClick={onNavigate}
                  className={`flex items-center gap-2 rounded-[0.6rem] px-3 py-2 text-sm ${
                    pathname.startsWith(`/plugins/${item.pluginId}`)
                      ? "bg-tint font-semibold text-navy"
                      : "text-muted hover:bg-page hover:text-ink"
                  }`}
                >
                  <PluginIcon icon={item.icon} />
                  {item.label}
                </Link>
              </li>
            ))}
          </ul>
        </li>
      )}
    </ul>
  );
}

export function Shell({ children }: { children: ReactNode }) {
  const location = useLocation();
  const [status, setStatus] = useState<RuntimeStatus | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  // §9.7: Ctrl/Cmd+K opens the command palette.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

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

  // Scroll restoration: hash targets (e.g. /target#add-target) scroll into view
  // — retry briefly since the element may render after an async load; otherwise
  // go to the top like a fresh page.
  useEffect(() => {
    if (!location.hash) {
      window.scrollTo(0, 0);
      return;
    }
    const id = decodeURIComponent(location.hash.slice(1));
    let tries = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const attempt = () => {
      const el = document.getElementById(id);
      if (el) el.scrollIntoView();
      else if (tries++ < 40) timer = setTimeout(attempt, 50);
    };
    attempt();
    return () => clearTimeout(timer);
  }, [location.pathname, location.hash]);

  return (
    <div className="flex min-h-screen flex-col">
      <header className="flex items-center gap-3 border-b border-line bg-surface px-5 py-3">
        <button
          type="button"
          aria-label="Open navigation menu"
          aria-expanded={menuOpen}
          data-testid="menu-button"
          onClick={() => setMenuOpen((v) => !v)}
          className="menu:hidden rounded-[0.5rem] border border-line bg-page px-2 py-1 text-sm text-ink"
        >
          ☰
        </button>
        <img src="/interview-ps-logo.png" alt="interview.ps logo" width={28} height={28} />
        <div className="font-display text-base font-semibold text-navy">
          Interview OS <span className="font-normal text-muted">· by interview.ps</span>
        </div>
        <div className="ml-auto flex items-center gap-4">
          <TargetSwitcher />
          <button
            type="button"
            aria-label="Open command palette"
            data-testid="palette-button"
            onClick={() => setPaletteOpen(true)}
            className="hidden rounded-[0.5rem] border border-line bg-page px-2 py-1 text-xs text-muted hover:bg-tint sm:block"
          >
            ⌘K
          </button>
          <RuntimeBadge status={status} />
        </div>
      </header>
      <div className="flex flex-1">
        <nav
          aria-label="Primary"
          className="hidden w-48 shrink-0 border-r border-line bg-surface px-3 py-4 menu:block"
        >
          <NavList />
        </nav>
        {menuOpen && (
          <div
            className="fixed inset-0 z-40 menu:hidden"
            role="dialog"
            aria-label="Navigation menu"
          >
            <button
              type="button"
              aria-label="Close navigation menu"
              className="absolute inset-0 bg-navy/30"
              onClick={() => setMenuOpen(false)}
            />
            <nav
              aria-label="Primary overlay"
              className="absolute left-0 top-0 h-full w-56 bg-surface px-3 py-4 shadow-lg"
            >
              <NavList onNavigate={() => setMenuOpen(false)} />
            </nav>
          </div>
        )}
        <main className="min-w-0 flex-1 px-6 py-6">{children}</main>
      </div>
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
      />
      <ToastHost />
    </div>
  );
}
