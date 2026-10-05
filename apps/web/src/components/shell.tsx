import { Link, useLocation } from "react-router";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  Breadcrumb,
  Button,
  Drawer,
  Dropdown,
  Grid,
  Layout,
  Menu,
  Segmented,
  Select,
  Tooltip,
  Typography,
} from "antd";
import {
  AimOutlined,
  BulbOutlined,
  DesktopOutlined,
  FileTextOutlined,
  HomeOutlined,
  MenuOutlined,
  MoonOutlined,
  MoreOutlined,
  SettingOutlined,
  SunOutlined,
  VideoCameraOutlined,
} from "@ant-design/icons";
import type { UITone as Tone } from "@interview-os/frontend-types";
import { api, type RuntimeStatus, type TargetListItem } from "@/lib/api";
import { CommandPalette } from "@/components/command-palette";
import { useUIContributions } from "@/components/plugin-ui";
import { runtimeLabel } from "@/lib/runtime";
import { AppRefreshContext } from "@/lib/app-refresh";
import { message } from "@/utils/antdMessage";
import { useTheme } from "@/theme/ThemeProvider";
import type { ThemePreference } from "@/theme/tokens";
import { StatusDot } from "@/ui";
import { displayLabel } from "@/components/ui";
import { PageTitleProvider, usePageTitle } from "@/lib/page-title";
import { commandKeyLabel } from "@/lib/platform";

type NavEntry = { href: string; label: string; icon?: ReactNode };

/* Navigation is organised around the candidate's journey, not the internal
   feature list: the prepare-and-practise steps, then Progress, Customizations,
   and Settings. */
const NAV_JOURNEY: NavEntry[] = [
  { href: "/", label: "Home", icon: <HomeOutlined /> },
  { href: "/target", label: "Target", icon: <AimOutlined /> },
  { href: "/prepare", label: "Prepare", icon: <BulbOutlined /> },
  { href: "/resume", label: "Resume", icon: <FileTextOutlined /> },
  { href: "/interview", label: "Interview", icon: <VideoCameraOutlined /> },
];
const NAV_PROGRESS: NavEntry[] = [
  { href: "/readiness", label: "Readiness" },
  { href: "/history", label: "History" },
];
const NAV_CUSTOMIZATIONS: NavEntry[] = [
  { href: "/packs", label: "Packs" },
  { href: "/skills", label: "Extensions" },
];
const NAV_WORKSPACE: NavEntry[] = [{ href: "/settings", label: "Settings" }];

/* Full list — used for breadcrumb labels and menu selection. */
const NAV: NavEntry[] = [
  ...NAV_JOURNEY,
  ...NAV_PROGRESS,
  ...NAV_CUSTOMIZATIONS,
  ...NAV_WORKSPACE,
];

const ALL_NAV = NAV;

function RuntimeIndicator({ status }: { status: RuntimeStatus | null }) {
  let tone: Tone = "muted";
  let label = "Checking runtime…";
  let attention = false;
  if (status) {
    const name = runtimeLabel(status.mode);
    if (status.mode === "mock") {
      tone = "blue";
      label = "Mock Runtime";
      attention = true;
    } else if (status.available) {
      tone = "green";
      label = `${name} connected`;
    } else {
      tone = "amber";
      label = `${name} unavailable`;
      attention = true;
    }
  }
  const indicator = (
    <span
      role="status"
      aria-live="polite"
      aria-label={label}
      className="inline-flex items-center gap-2"
    >
      <StatusDot tone={tone} />
      {attention && (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {label}
        </Typography.Text>
      )}
    </span>
  );
  if (!status) {
    return <Tooltip title={label}>{indicator}</Tooltip>;
  }
  return (
    <Dropdown
      trigger={["click"]}
      menu={{
        items: [
          {
            key: "diagnostics",
            icon: <SettingOutlined />,
            label: <Link to="/settings#diagnostics">Runtime diagnostics</Link>,
          },
        ],
      }}
    >
      <button
        type="button"
        aria-label={`${label}. Open runtime diagnostics.`}
        className="inline-flex cursor-pointer items-center border-0 bg-transparent p-0"
      >
        {indicator}
      </button>
    </Dropdown>
  );
}

function TargetSwitcher({ onSwitched }: { onSwitched: () => void }) {
  const [targets, setTargets] = useState<TargetListItem[]>([]);
  const [switching, setSwitching] = useState(false);

  useEffect(() => {
    api.listTargets().then(setTargets).catch(() => setTargets([]));
  }, []);

  if (targets.length === 0) return null;
  const active = targets.find((t) => t.active);
  const activeLabel = active
    ? `${active.role} · ${active.company} · ${active.level}`
    : "Select a target";

  return (
    <Tooltip title={active ? `Active target: ${activeLabel}` : "Select a target"}>
      <Select
        aria-label={
          active
            ? `Active target role: ${active.role} at ${active.company}, ${active.level}`
            : "Active target role"
        }
        size="small"
        style={{ maxWidth: 300, minWidth: 160 }}
        popupMatchSelectWidth={false}
        value={active?.id}
        loading={switching}
        onChange={(value) => {
          setSwitching(true);
          api
            .activateTarget(value)
            .then(() => {
              void message.success("Target switched");
              api.listTargets().then(setTargets).catch(() => {});
              onSwitched();
            })
            .catch(() => {})
            .finally(() => setSwitching(false));
        }}
        options={targets.map((t) => ({
          value: t.id,
          label: `${t.role} · ${t.company} · ${t.level}`,
        }))}
      />
    </Tooltip>
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

function navLinks(entries: NavEntry[]) {
  return entries.map((item) => ({
    key: item.href,
    label: <Link to={item.href}>{item.label}</Link>,
    ...(item.icon ? { icon: item.icon } : {}),
  }));
}

function useNavItems() {
  const contributions = useUIContributions();

  return useMemo(() => {
    const pluginNav = contributions.flatMap((p) =>
      p.navigation.map((n) => ({
        key: `/plugins/${p.pluginId}${n.page === "/" ? "" : n.page}`,
        label: (
          <Link to={`/plugins/${p.pluginId}${n.page === "/" ? "" : n.page}`}>
            <span className="inline-flex items-center gap-2">
              <PluginIcon icon={n.icon} />
              {n.label}
            </span>
          </Link>
        ),
      })),
    );
    const items: unknown[] = [
      ...navLinks(NAV_JOURNEY),
      { key: "group-progress", type: "group", label: "Progress", children: navLinks(NAV_PROGRESS) },
      {
        key: "group-customizations",
        type: "group",
        label: "Customizations",
        children: navLinks(NAV_CUSTOMIZATIONS),
      },
      { type: "divider", key: "divider-workspace" },
      ...navLinks(NAV_WORKSPACE),
    ];
    if (pluginNav.length > 0) {
      items.push({
        key: "plugins-group",
        type: "group",
        label: "Plugins",
        children: pluginNav,
      });
    }
    return items as never;
  }, [contributions]);
}

function selectedKey(pathname: string): string {
  if (pathname === "/") return "/";
  const match = ALL_NAV.filter((n) => n.href !== "/").find((n) =>
    pathname.startsWith(n.href),
  );
  if (match) return match.href;
  if (pathname.startsWith("/plugins/")) return pathname;
  return pathname;
}

function ThemeControl() {
  const { preference, setPreference } = useTheme();
  return (
    <Tooltip title="Appearance">
      <Segmented
        size="small"
        aria-label="Appearance"
        value={preference}
        onChange={(value) => setPreference(value as ThemePreference)}
        options={[
          { value: "light", icon: <SunOutlined />, title: "Light" },
          { value: "dark", icon: <MoonOutlined />, title: "Dark" },
          { value: "system", icon: <DesktopOutlined />, title: "System" },
        ]}
      />
    </Tooltip>
  );
}

/** Route ids must never become crumb text (D2). */
const ID_LIKE =
  /^(\d+|[0-9a-f]{8,}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

function crumbLabel(
  segments: string[],
  index: number,
  pageTitle: string | null,
): string {
  const segment = segments[index] ?? "";
  const href = "/" + segments.slice(0, index + 1).join("/");
  const nav = ALL_NAV.find((n) => n.href === href);
  if (nav) return nav.label;
  if (index === segments.length - 1 && pageTitle) return pageTitle;
  if (segments[index - 1] === "loop") return "Loop";
  if (segments[index - 1] === "interview" || ID_LIKE.test(segment)) return "Session";
  return displayLabel(segment);
}

function Breadcrumbs() {
  const pathname = useLocation().pathname;
  const pageTitle = usePageTitle();
  if (pathname === "/") return null;
  const segments = pathname.split("/").filter(Boolean);
  const items = segments.map((_segment, index) => {
    const href = "/" + segments.slice(0, index + 1).join("/");
    const label = crumbLabel(segments, index, pageTitle);
    return {
      title: index === segments.length - 1 ? label : <Link to={href}>{label}</Link>,
    };
  });
  return <Breadcrumb items={items} style={{ marginBottom: 12 }} />;
}

/** Small-screen primary navigation — the four journey goals, plus More. */
function BottomNav({ pathname, onMore }: { pathname: string; onMore: () => void }) {
  return (
    <nav aria-label="Primary" className="interview-bottom-nav">
      {NAV_JOURNEY.slice(0, 4).map((item) => {
        const active =
          item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
        return (
          <Link
            key={item.href}
            to={item.href}
            aria-current={active ? "page" : undefined}
            className={`interview-bottom-nav__item${active ? " is-active" : ""}`}
          >
            {item.label}
          </Link>
        );
      })}
      <button
        type="button"
        onClick={onMore}
        className="interview-bottom-nav__item"
        aria-label="More destinations"
      >
        <MoreOutlined aria-hidden /> More
      </button>
    </nav>
  );
}

export function Shell({ children }: { children: ReactNode }) {
  const location = useLocation();
  const screens = Grid.useBreakpoint();
  const desktop = screens.lg ?? true;
  const [status, setStatus] = useState<RuntimeStatus | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const items = useNavItems();

  const refresh = useCallback(() => setRefreshKey((k) => k + 1), []);

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

  // Scroll restoration for hash targets (e.g. /target#add-target).
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
      if (el) el.scrollIntoView({ block: "start" });
      else if (tries++ < 40) timer = setTimeout(attempt, 50);
    };
    attempt();
    return () => clearTimeout(timer);
  }, [location.pathname, location.hash]);

  useEffect(() => {
    setMenuOpen(false);
  }, [location.pathname]);

  return (
    <AppRefreshContext.Provider value={refresh}>
      <Layout style={{ minHeight: "100vh" }}>
        <Layout.Header className="interview-header flex items-center gap-3">
          <Button
            type="text"
            aria-label="Open navigation menu"
            aria-expanded={menuOpen}
            data-testid="menu-button"
            icon={<MenuOutlined />}
            onClick={() => setMenuOpen(true)}
            style={{ display: desktop ? "none" : "inline-flex" }}
          />
          <img src="/interview-ps-logo.png" alt="interview.ps logo" width={28} height={28} />
          <Typography.Text strong style={{ fontSize: 16 }}>
            Interview OS{" "}
            <Typography.Text type="secondary" style={{ fontWeight: 400 }}>
              · by interview.ps
            </Typography.Text>
          </Typography.Text>
          <div className="ml-auto flex items-center gap-3">
            <TargetSwitcher onSwitched={refresh} />
            <Button
              size="small"
              aria-label={`Open command palette (${commandKeyLabel()})`}
              data-testid="palette-button"
              onClick={() => setPaletteOpen(true)}
              style={{ display: desktop ? "inline-flex" : "none" }}
            >
              {commandKeyLabel()}
            </Button>
            <ThemeControl />
            <RuntimeIndicator status={status} />
          </div>
        </Layout.Header>
        <Layout>
          {desktop && (
            <Layout.Sider theme="light" width={208} className="interview-sider">
              <Menu
                mode="inline"
                selectedKeys={[selectedKey(location.pathname)]}
                items={items}
                style={{ borderInlineEnd: "none", paddingTop: 8 }}
              />
            </Layout.Sider>
          )}
          <Layout.Content className="interview-content" key={refreshKey}>
            <PageTitleProvider>
              <Breadcrumbs />
              {children}
            </PageTitleProvider>
          </Layout.Content>
        </Layout>

        <Drawer
          title="Navigation"
          placement="left"
          open={menuOpen}
          onClose={() => setMenuOpen(false)}
          size={256}
          styles={{ body: { padding: 8 } }}
        >
          <Menu
            mode="inline"
            selectedKeys={[selectedKey(location.pathname)]}
            items={items}
            style={{ borderInlineEnd: "none" }}
          />
        </Drawer>

        {!desktop && (
          <BottomNav pathname={location.pathname} onMore={() => setMenuOpen(true)} />
        )}

        <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
      </Layout>
    </AppRefreshContext.Provider>
  );
}
