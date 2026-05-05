/**
 * Mermaid 図クリック拡大表示。
 *
 * vitepress-plugin-mermaid は SVG を `.mermaid-wrapper > svg` として client-side
 * 描画する。複雑な図は column 幅でも読みづらいため、wrapper クリックで
 * fullscreen overlay に SVG をクローンして表示する。
 *
 * Mermaid 描画は async なので MutationObserver で SVG 出現を監視。
 */

const ZOOM_OVERLAY_CLASS = 'mermaid-zoom-overlay'

function openZoomOverlay(wrapper: HTMLElement) {
  const svg = wrapper.querySelector('svg')
  if (!svg) return

  const overlay = document.createElement('div')
  overlay.className = ZOOM_OVERLAY_CLASS
  overlay.setAttribute('role', 'dialog')
  overlay.setAttribute('aria-modal', 'true')
  overlay.setAttribute('aria-label', 'Enlarged diagram')

  const inner = document.createElement('div')
  inner.className = 'mermaid-zoom-inner'

  const clone = svg.cloneNode(true) as SVGElement
  clone.removeAttribute('width')
  clone.removeAttribute('height')
  clone.style.width = '100%'
  clone.style.height = '100%'
  clone.style.maxWidth = 'unset'
  clone.style.minWidth = 'unset'

  const closeBtn = document.createElement('button')
  closeBtn.className = 'mermaid-zoom-close'
  closeBtn.setAttribute('aria-label', 'Close')
  closeBtn.textContent = '×'

  inner.appendChild(clone)
  overlay.appendChild(inner)
  overlay.appendChild(closeBtn)

  // 開く前のフォーカス位置を覚えておき、閉じた後に復元する (a11y)
  const previousActive = document.activeElement as HTMLElement | null

  const close = () => {
    overlay.remove()
    document.removeEventListener('keydown', onKey)
    if (previousActive && typeof previousActive.focus === 'function') {
      previousActive.focus()
    }
  }

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      close()
      return
    }
    // Tab focus trap: closeBtn が overlay 内で唯一の focusable 要素なので、
    // Tab / Shift+Tab を抑止して常にそこへ留める。SVG 内に tabindex を持つ
    // 要素を追加した場合は cycle 処理に拡張すること。
    if (e.key === 'Tab') {
      e.preventDefault()
      closeBtn.focus()
    }
  }

  overlay.addEventListener('click', (e) => {
    // 内部 SVG クリックでは閉じない (modal 外/closeBtn のみで閉じる)
    if (
      e.target === overlay ||
      (e.target as HTMLElement).classList.contains('mermaid-zoom-close')
    ) {
      close()
    }
  })

  document.addEventListener('keydown', onKey)
  document.body.appendChild(overlay)

  // 開いた直後に close ボタンへ初期フォーカス (スクリーンリーダー用、ESC 等の操作起点)
  closeBtn.focus()
}

function enhanceWrapper(wrapper: HTMLElement) {
  if (wrapper.dataset.zoomEnhanced === 'true') return
  // SVG が出現する前は enhance しない (空 wrapper をクリックしても何も起きない)
  if (!wrapper.querySelector('svg')) return

  wrapper.dataset.zoomEnhanced = 'true'
  wrapper.classList.add('mermaid-zoomable')
  wrapper.title = 'クリックで拡大'
  wrapper.addEventListener('click', () => openZoomOverlay(wrapper))
}

let observer: MutationObserver | null = null

export function setupMermaidZoom() {
  if (typeof window === 'undefined') return

  const scan = () => {
    document.querySelectorAll<HTMLElement>('.mermaid-wrapper').forEach(enhanceWrapper)
  }

  // 既存 wrapper を即時 enhance
  scan()

  // 既存 observer があれば disconnect (route 切替時の重複防止)
  if (observer) observer.disconnect()

  observer = new MutationObserver(() => scan())
  observer.observe(document.body, { childList: true, subtree: true })
}
