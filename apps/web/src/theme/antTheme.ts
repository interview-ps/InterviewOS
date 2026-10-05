import { theme as antdTheme, type ThemeConfig } from "antd";

import { semanticTokens, type ThemeMode } from "./tokens";

/** Build the Ant Design theme from Interview OS semantic tokens. */
export function antTheme(mode: ThemeMode): ThemeConfig {
  const isDark = mode === "dark";
  const t = semanticTokens[mode];
  return {
    algorithm: isDark ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
    token: {
      colorPrimary: t.brand,
      colorPrimaryHover: t.brandHover,
      colorPrimaryActive: t.brandActive,
      colorLink: t.link,
      colorSuccess: t.success,
      colorWarning: t.warning,
      colorError: t.danger,
      colorInfo: t.brand,
      colorBgBase: t.bg,
      colorBgContainer: t.bgContainer,
      colorBgElevated: t.bgElevated,
      colorBgLayout: t.bgLayout,
      colorText: t.textPrimary,
      colorTextSecondary: t.textSecondary,
      colorTextTertiary: t.textMuted,
      colorBorder: t.border,
      colorBorderSecondary: t.borderSecondary,
      borderRadius: t.radiusMd,
      controlHeight: t.controlHeight,
      fontFamily: t.fontBody,
      fontSize: 14,
      boxShadow: t.shadowSm,
      boxShadowSecondary: t.shadowMd,
    },
    components: {
      Layout: {
        headerBg: t.bgContainer,
        siderBg: t.bgContainer,
        bodyBg: t.bg,
        headerHeight: 56,
        headerPadding: 0,
      },
      Menu: {
        itemBg: "transparent",
        itemColor: t.textSecondary,
        itemHoverBg: t.surfaceHover,
        itemSelectedBg: t.surfaceHover,
        itemSelectedColor: t.brand,
        itemBorderRadius: t.radiusSm,
      },
      Card: {
        headerBg: "transparent",
        borderRadiusLG: t.radiusLg,
      },
      Button: {
        fontWeight: 500,
        primaryShadow: "none",
      },
      Tabs: {
        itemSelectedColor: t.brand,
      },
      Modal: {
        borderRadiusLG: t.radiusLg,
      },
      Table: {
        headerBg: t.surfaceHover,
      },
    },
  };
}
