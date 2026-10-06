import { theme as antdTheme, type ThemeConfig } from "antd";

import { semanticTokens, type ThemeMode } from "./tokens";

/**
 * Build the Ant Design theme from Interview OS semantic tokens.
 *
 * The compact algorithm is composed with the light/dark base so control
 * heights, paddings and margins shrink for a desktop-density feel. Compact
 * alone also drops the base font to `fontSizeSM` (12px), so the font and
 * spacing scales are raised back explicitly to keep 13–14px UI text readable.
 */
export function antTheme(mode: ThemeMode): ThemeConfig {
  const isDark = mode === "dark";
  const t = semanticTokens[mode];
  return {
    algorithm: [
      isDark ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
      antdTheme.compactAlgorithm,
    ],
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
      controlHeightSM: 26,
      controlHeightLG: 36,
      fontFamily: t.fontBody,
      fontSize: 14,
      fontSizeSM: 13,
      fontSizeLG: 16,
      paddingXXS: 2,
      paddingXS: 6,
      paddingSM: 8,
      padding: 12,
      paddingMD: 16,
      paddingLG: 20,
      paddingXL: 24,
      marginXXS: 2,
      marginXS: 6,
      marginSM: 8,
      margin: 12,
      marginMD: 16,
      marginLG: 20,
      marginXL: 28,
      boxShadow: t.shadowSm,
      boxShadowSecondary: t.shadowMd,
    },
    components: {
      Layout: {
        headerBg: t.bgContainer,
        siderBg: t.bgContainer,
        bodyBg: t.bg,
        headerHeight: 42,
        headerPadding: "0 12px",
      },
      Menu: {
        itemBg: "transparent",
        itemColor: t.textSecondary,
        itemHoverBg: t.surfaceHover,
        itemSelectedBg: t.surfaceHover,
        itemSelectedColor: t.brand,
        itemBorderRadius: t.radiusSm,
        itemHeight: 32,
        itemMarginInline: 4,
        itemPaddingInline: 12,
        groupTitleFontSize: 11,
      },
      Card: {
        headerBg: "transparent",
        borderRadiusLG: t.radiusLg,
        bodyPadding: 14,
        headerHeight: 40,
        headerFontSize: 14,
      },
      Button: {
        fontWeight: 500,
        primaryShadow: "none",
        contentFontSize: 13,
      },
      Tabs: {
        itemSelectedColor: t.brand,
        titleFontSize: 13,
        horizontalItemGutter: 16,
        horizontalItemPadding: "7px 0",
      },
      Modal: {
        borderRadiusLG: t.radiusLg,
      },
      Table: {
        headerBg: t.surfaceHover,
        rowHoverBg: t.surfaceHover,
        borderColor: t.borderSecondary,
        cellPaddingBlock: 8,
        cellPaddingInline: 10,
        cellFontSize: 13,
      },
      Form: {
        itemMarginBottom: 12,
        labelFontSize: 13,
      },
      Collapse: {
        headerPadding: "8px 12px",
        contentPadding: "12px",
      },
      Descriptions: {
        itemPaddingBottom: 8,
        titleMarginBottom: 8,
      },
      Statistic: {
        contentFontSize: 20,
      },
    },
  };
}
