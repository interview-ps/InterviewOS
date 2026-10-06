import { theme as antdTheme, type ThemeConfig } from "antd";

import { semanticTokens, type ThemeMode } from "./tokens";

/**
 * Build the Ant Design theme from Interview OS semantic tokens.
 *
 * The compact algorithm is composed with the light/dark base so control
 * heights, paddings and margins shrink for a desktop-density feel. Compact
 * alone also drops the base font to `fontSizeSM` (12px), so the font and
 * spacing scales are raised back explicitly to keep 13–14px UI text readable.
 *
 * Colour is applied by meaning: neutral text for headings/body, cobalt for
 * links/primary/focus/selection, green for positive, amber for caution, red
 * for errors, neutral for unassessed. Surfaces are opaque so overlays
 * (drawer/modal/dropdown) never show content behind them.
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
      /* brand + links */
      colorPrimary: t.brand,
      colorPrimaryHover: t.brandHover,
      colorPrimaryActive: t.brandActive,
      colorPrimaryBg: t.selection,
      colorLink: t.link,
      colorLinkHover: t.brandHover,
      colorLinkActive: t.brandActive,
      /* semantic status (fill bases) */
      colorSuccess: t.success,
      colorWarning: t.warning,
      colorError: t.danger,
      colorInfo: t.brand,
      /* surfaces — opaque, no translucency on content */
      colorBgBase: t.bgContainer,
      colorBgContainer: t.bgContainer,
      colorBgElevated: t.bgElevated,
      colorBgLayout: t.bgLayout,
      colorBgMask: isDark ? "rgba(3, 7, 18, 0.6)" : "rgba(16, 24, 40, 0.45)",
      /* text */
      colorText: t.textBody,
      colorTextHeading: t.textPrimary,
      colorTextSecondary: t.textSecondary,
      colorTextTertiary: t.textMuted,
      colorTextQuaternary: isDark ? "#586783" : "#98a2b3",
      /* lines */
      colorBorder: t.border,
      colorBorderSecondary: t.borderSecondary,
      colorSplit: t.divider,
      /* shape + density */
      borderRadius: t.radiusMd,
      borderRadiusSM: t.radiusSm,
      borderRadiusLG: t.radiusLg,
      controlHeight: t.controlHeight,
      controlHeightSM: 26,
      controlHeightLG: 40,
      fontFamily: t.fontBody,
      fontSize: 14,
      fontSizeSM: 13,
      fontSizeLG: 16,
      lineHeight: 1.5,
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
      /* elevation — reserve real shadows for elevated content */
      boxShadow: t.shadowSm,
      boxShadowSecondary: t.shadowMd,
      motionDurationMid: "0.15s",
      motionDurationSlow: "0.2s",
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
        itemHoverColor: t.textPrimary,
        itemHoverBg: t.surfaceHover,
        itemSelectedBg: t.selection,
        itemSelectedColor: t.brand,
        itemBorderRadius: t.radiusMd,
        itemHeight: 30,
        itemMarginInline: 6,
        itemMarginBlock: 2,
        itemPaddingInline: 10,
        groupTitleColor: t.textMuted,
        groupTitleFontSize: 11,
      },
      Card: {
        headerBg: "transparent",
        borderRadiusLG: t.radiusLg,
        bodyPadding: 16,
        headerHeight: 40,
        headerFontSize: 14,
        headerPadding: 0,
        extraColor: t.textMuted,
      },
      Button: {
        fontWeight: 500,
        primaryShadow: "none",
        defaultShadow: "none",
        dangerShadow: "none",
        contentFontSize: 13,
        contentFontSizeSM: 12,
        paddingInline: 12,
        defaultBg: t.bgContainer,
        defaultColor: t.textBody,
        defaultBorderColor: t.border,
        defaultHoverBg: t.inset,
        defaultHoverColor: t.textPrimary,
        defaultHoverBorderColor: isDark ? "#3b4a63" : "#98a2b3",
        defaultActiveBg: t.surfaceHover,
        defaultActiveBorderColor: t.brand,
        textTextColor: t.textSecondary,
        textTextHoverColor: t.textPrimary,
        textHoverBg: t.surfaceHover,
        primaryColor: "#ffffff",
      },
      Input: {
        activeBorderColor: t.brand,
        hoverBorderColor: isDark ? "#4d7fd8" : "#93b4f4",
        activeShadow: isDark
          ? "0 0 0 2px rgba(91, 141, 239, 0.25)"
          : "0 0 0 2px rgba(37, 99, 235, 0.15)",
        paddingInline: 10,
        paddingBlock: 5,
      },
      Select: {
        optionSelectedBg: t.selection,
        optionSelectedColor: t.textPrimary,
        optionSelectedFontWeight: 600,
        optionActiveBg: t.surfaceHover,
        optionPadding: "5px 12px",
        selectorBg: t.bgContainer,
        multipleItemBg: t.inset,
        multipleItemBorderColor: t.borderSecondary,
        multipleItemColorDisabled: t.textMuted,
        multipleItemBorderColorDisabled: t.borderSecondary,
      },
      Drawer: {
        footerPaddingBlock: 10,
        footerPaddingInline: 16,
      },
      Modal: {
        headerBg: t.bgElevated,
        contentBg: t.bgElevated,
        footerBg: t.bgElevated,
        titleColor: t.textPrimary,
        titleFontSize: 16,
      },
      Dropdown: {
        paddingBlock: 4,
      },
      Tag: {
        defaultBg: t.neutralBg,
        defaultColor: t.neutral,
        borderRadiusSM: t.radiusSm,
      },
      Table: {
        headerBg: t.inset,
        headerColor: t.textSecondary,
        rowHoverBg: t.inset,
        borderColor: t.divider,
        headerSplitColor: t.divider,
        cellPaddingBlock: 8,
        cellPaddingInline: 12,
        cellFontSize: 13,
        footerBg: t.bgContainer,
        footerColor: t.textMuted,
      },
      Tabs: {
        itemColor: t.textMuted,
        itemHoverColor: t.textPrimary,
        itemSelectedColor: t.textPrimary,
        inkBarColor: t.brand,
        titleFontSize: 13,
        horizontalItemGutter: 16,
        horizontalItemPadding: "7px 0",
      },
      Collapse: {
        headerPadding: "10px 12px",
        contentPadding: "12px",
        headerBg: "transparent",
        contentBg: "transparent",
      },
      Form: {
        itemMarginBottom: 12,
        labelFontSize: 13,
        labelColor: t.textBody,
        verticalLabelPadding: "0 0 4px",
      },
      Descriptions: {
        itemPaddingBottom: 8,
        titleMarginBottom: 8,
      },
      Statistic: {
        contentFontSize: 26,
        titleFontSize: 12,
      },
      Progress: {
        remainingColor: t.divider,
        lineBorderRadius: 4,
      },
      Radio: {
        radioSize: 16,
        dotSize: 6,
      },
      Breadcrumb: {
        itemColor: t.textMuted,
        linkColor: t.brand,
        linkHoverColor: t.brandHover,
        lastItemColor: t.textSecondary,
        separatorColor: t.textMuted,
      },
      Tooltip: {
        colorBgSpotlight: t.textPrimary,
        colorTextLightSolid: isDark ? "#0b1220" : "#ffffff",
      },
      Steps: {
        iconSize: 26,
        iconFontSize: 12,
      },
      Message: {
        contentBg: t.bgElevated,
      },
    },
  };
}
