import { Link, useLocation } from "react-router";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  Badge,
  Breadcrumb,
  Button,
  Drawer,
  Grid,
  Layout,
  Menu,
  Segmented,
  Select,
  Tooltip,
  Typography,
} from "antd";
import {
  DesktopOutlined,
  MenuOutlined,
  MoonOutlined,
  SunOutlined,
} from "@ant-design/icons";
import { api, type RuntimeStatus, type TargetListItem } from "@/lib/api";
import { CommandPalette } from "@/components/command-palette";
import { useUIContributions } from "@/components/plugin-ui";
import { runtimeLabel } from "@/lib/runtime";
import { message } from "@/utils/antdMessage";
import { useTheme } from "@/theme/ThemeProvider";
import type { ThemePreference } from "@/theme/tokens";

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
  let color = "default";
  let text = "Checking runtime…";
  if (status) {
    const label = runtimeLabel(status.mode);
    if (status.mode === "mock") {
      color = "processing";
      text = "Mock Runtime";
    } else if (status.available) {
      color = "success";
      text = `${label} Connected`;
    } else {
      color = "default";
      text = `${label} Not Available`;
    }
  }
  return (
    <span aria-live="polite">
      <Badge color={color} text={text} />
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
    <Select
      aria-label="Active target role"
      size="small"
      style={{ maxWidth: 224, minWidth: 140 }}
      value={active?.id}
      loading={switching}
      onChange={(value) => {
        setSwitching(true);
        api
          .activateTarget(value)
          .then(() => {
            void message.success("Target switched");
            window.location.reload();
          })
          .catch(() => setSwitching(false));
      }}
      options={targets.map((t) => ({
        value: t.id,
        label: `${t.role} — ${t.company}`,
      }))}
    />
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

function useNavItems() {
  const pathname = useLocation().pathname;
  const contributions = useUIContributions();

  return useMemo(() => {
    const items = [
      ...NAV.map((item) => ({
        key: item.href,
        label: <Link to={item.href}>{item.label}</Link>,
      })),
    ];
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
    if (pluginNav.length > 0) {
      items.push({ key: "plugins-group", type: "group", label: "Plugins", children: pluginNav } as never);
    }
    return items;
  }, [contributions, pathname]);
}

function selectedKey(pathname: string): string {
  if (pathname === "/") return "/";
  const match = NAV.filter((n) => n.href !== "/").find((n) =>
    pathname.startsWith(n.href),
  );
  if (match) return match.href;
  if (pathname.startsWith("/plugins/")) return pathname;
  return pathname;
}

function ThemeControl() {
  const { preference, setPreference } = useTheme();
  return (
    <Tooltip title="Theme">
      <Segmented
        size="small"
        value={preference}
        onChange={(value) => setPreference(value as ThemePreference)}
        options={[
          { value: "light", icon: <SunOutlined /> },
          { value: "dark", icon: <MoonOutlined /> },
          { value: "system", icon: <DesktopOutlined /> },
        ]}
      />
    </Tooltip>
  );
}

function Breadcrumbs() {
  const pathname = useLocation().pathname;
  if (pathname === "/") return null;
  const segments = pathname.split("/").filter(Boolean);
  const items = segments.map((segment, index) => {
    const href = "/" + segments.slice(0, index + 1).join("/");
    const label =
      NAV.find((n) => n.href === href)?.label ??
      segment.replace(/[-_]+/g, " ");
    return { title: index === segments.length - 1 ? label : <Link to={href}>{label}</Link> };
  });
  return <Breadcrumb items={items} style={{ marginBottom: 12 }} />;
}

export function Shell({ children }: { children: ReactNode }) {
  const location = useLocation();
  const screens = Grid.useBreakpoint();
  const desktop = screens.lg ?? true;
  const [status, setStatus] = useState<RuntimeStatus | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const items = useNavItems();

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
      if (el) el.scrollIntoView();
      else if (tries++ < 40) timer = setTimeout(attempt, 50);
    };
    attempt();
    return () => clearTimeout(timer);
  }, [location.pathname, location.hash]);

  useEffect(() => {
    setMenuOpen(false);
  }, [location.pathname]);

  return (
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
          <TargetSwitcher />
          <Button
            size="small"
            aria-label="Open command palette"
            data-testid="palette-button"
            onClick={() => setPaletteOpen(true)}
            style={{ display: desktop ? "inline-flex" : "none" }}
          >
            ⌘K
          </Button>
          <ThemeControl />
          <RuntimeBadge status={status} />
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
        <Layout.Content className="interview-content">
          <Breadcrumbs />
          {children}
        </Layout.Content>
      </Layout>

      <Drawer
        title="Navigation"
        placement="left"
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        width={256}
        styles={{ body: { padding: 8 } }}
      >
        <Menu
          mode="inline"
          selectedKeys={[selectedKey(location.pathname)]}
          items={items}
          style={{ borderInlineEnd: "none" }}
        />
      </Drawer>

      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </Layout>
  );
}
