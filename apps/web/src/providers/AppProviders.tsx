import { ConfigProvider } from "antd";
import type { ReactNode } from "react";

import { AntdAppProvider } from "@/providers/AntdAppProvider";
import { antTheme } from "@/theme/antTheme";
import { ThemeProvider, useTheme } from "@/theme/ThemeProvider";

function ThemedConfig({ children }: { children: ReactNode }) {
  const { mode } = useTheme();
  return (
    <ConfigProvider prefixCls="interview" theme={antTheme(mode)}>
      <AntdAppProvider>{children}</AntdAppProvider>
    </ConfigProvider>
  );
}

/** App-wide providers: theme resolution → antd ConfigProvider → App context. */
export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <ThemeProvider>
      <ThemedConfig>{children}</ThemedConfig>
    </ThemeProvider>
  );
}
