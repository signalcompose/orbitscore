import DefaultTheme from 'vitepress/theme'
import type { EnhanceAppContext } from 'vitepress'
import './custom.css'
import { setupMermaidZoom } from './mermaid-zoom'

export default {
  ...DefaultTheme,
  enhanceApp(ctx: EnhanceAppContext) {
    DefaultTheme.enhanceApp?.(ctx)
    if (typeof window !== 'undefined') {
      // 初期 page load 時に setup (Mermaid SVG は async 描画なので
      // mermaid-zoom.ts 内の MutationObserver が後続の出現を拾う)
      setupMermaidZoom()
    }
  },
}
