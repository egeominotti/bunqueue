// @ts-check
import { defineEcConfig } from '@astrojs/starlight/expressive-code';

/**
 * Expressive Code options for the docs. Kept here rather than in astro.config.mjs because
 * the theme-aware style functions are not JSON-serializable, and the <Code> component
 * (used by components/FirstJobCode.astro) loads its options from this file.
 */
export default defineEcConfig({
  // Neutral code colors on the docs surface; shell commands render as plain blocks
  // (no fake terminal window), and a file name sits on a tab underlined in pink.
  themes: ['github-dark-default', 'github-light-default'],
  defaultProps: {
    overridesByLang: {
      'bash,sh,shell,zsh,console,powershell,ps,ps1': { frame: 'none' },
    },
  },
  styleOverrides: {
    borderRadius: '10px',
    borderColor: ({ theme }) => (theme.type === 'dark' ? '#26262c' : '#e5e5eb'),
    codeBackground: ({ theme }) => (theme.type === 'dark' ? '#111114' : '#f7f7f9'),
    codeFontFamily: "'IBM Plex Mono', ui-monospace, 'SF Mono', monospace",
    codeFontSize: '0.9rem',
    codeLineHeight: '1.7',
    codePaddingInline: '1.15rem',
    codePaddingBlock: '0.95rem',
    uiFontFamily: "'IBM Plex Mono', ui-monospace, monospace",
    frames: {
      frameBoxShadowCssValue: 'none',
      editorTabBarBackground: ({ theme }) => (theme.type === 'dark' ? '#111114' : '#f7f7f9'),
      editorActiveTabBackground: ({ theme }) =>
        theme.type === 'dark' ? '#111114' : '#f7f7f9',
      editorActiveTabIndicatorTopColor: 'transparent',
      editorActiveTabIndicatorBottomColor: ({ theme }) =>
        theme.type === 'dark' ? '#f472b6' : '#ba1c62',
      editorTabBarBorderBottomColor: ({ theme }) =>
        theme.type === 'dark' ? '#26262c' : '#e5e5eb',
      terminalTitlebarDotsOpacity: '0',
      terminalBackground: ({ theme }) => (theme.type === 'dark' ? '#111114' : '#f7f7f9'),
      terminalTitlebarBackground: ({ theme }) =>
        theme.type === 'dark' ? '#111114' : '#f7f7f9',
      terminalTitlebarBorderBottomColor: 'transparent',
    },
  },

});
