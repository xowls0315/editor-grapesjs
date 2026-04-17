import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Editor from '@monaco-editor/react'
import grapesjs from 'grapesjs'
import 'grapesjs/dist/css/grapes.min.css'
import './BlockEditor.css'
const TOOLBAR_TEXT_TAGS = new Set([
  'p',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'span',
  'a',
  'strong',
  'em',
  'b',
  'i',
  'u',
  'li',
  'td',
  'th',
])

function BeToolbarSvg({ children }) {
  return (
    <svg className="be-toolbar-svg" width={18} height={18} viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden>
      <g fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round">
        {children}
      </g>
    </svg>
  )
}

function getBlockRootComponent(editor) {
  const w = editor.getWrapper()
  return (
    w.find('#salon-story')[0] ||
    w.find('.salon-story')[0] ||
    w.find('.studio-root')[0] ||
    w.find('section')[0] ||
    w.components().at(0)
  )
}

const COMPONENT_LINK_ICON_SVG =
  '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M3.9,12C3.9,10.29 5.29,8.9 7,8.9H11V7H7A5,5 0 0,0 2,12A5,5 0 0,0 7,17H11V15.1H7C5.29,15.1 3.9,13.71 3.9,12M8,13H16V11H8V13M17,7H13V8.9H17C18.71,8.9 20.1,10.29 20.1,12C20.1,13.71 18.71,15.1 17,15.1H13V17H17A5,5 0 0,0 22,12A5,5 0 0,0 17,7Z"></path></svg>'

const GJS_COMPONENT_DEFAULTS = {
  draggable: true,
  droppable: true,
  copyable: true,
  removable: true,
  highlightable: true,
  selectable: true,
  hoverable: true,
  resizable: {
    tl: 1,
    tc: 1,
    tr: 1,
    cl: 1,
    cr: 1,
    bl: 1,
    bc: 1,
    br: 1,
    keyWidth: 'width',
    keyHeight: 'height',
  },
  toolbar: [
    {
      id: 'el-bg',
      label: '▣',
      command: 'custom:component-bg',
      attributes: { title: '요소 배경색' },
    },
    {
      id: 'lnk',
      label: COMPONENT_LINK_ICON_SVG,
      command: 'custom:component-link',
      attributes: { title: '링크 설정' },
    },
    {
      id: 'cpy',
      label: '⎘',
      command: 'core:copy',
      attributes: { title: '복사 (Ctrl+C)' },
    },
    {
      id: 'cut',
      label: '✂',
      command: 'custom:cut',
      attributes: { title: '잘라내기 (Ctrl+X)' },
    },
    {
      id: 'pst',
      label: '📋',
      command: 'core:paste',
      attributes: { title: '붙여넣기 (Ctrl+V)' },
    },
    {
      id: 'del',
      label: '⌫',
      command: 'core:component-delete',
      attributes: { title: '삭제 (Delete)' },
    },
  ],
}

const IMAGE_RESIZE_HANDLES = {
  tl: 1,
  tc: 1,
  tr: 1,
  cl: 1,
  cr: 1,
  bl: 1,
  bc: 1,
  br: 1,
  keyWidth: 'width',
  keyHeight: 'height',
}

const COMPONENT_LINK_TOOLBAR_ITEM = {
  id: 'lnk',
  label: COMPONENT_LINK_ICON_SVG,
  command: 'custom:component-link',
  attributes: { title: '링크 설정' },
}

function withComponentLinkToolbar(toolbar) {
  const base = Array.isArray(toolbar) ? [...toolbar] : []
  const exists = base.some((it) => it?.id === COMPONENT_LINK_TOOLBAR_ITEM.id || it?.command === COMPONENT_LINK_TOOLBAR_ITEM.command)
  if (exists) return base
  const delIdx = base.findIndex((it) => it?.command === 'core:component-delete')
  if (delIdx >= 0) {
    base.splice(delIdx, 0, { ...COMPONENT_LINK_TOOLBAR_ITEM })
  } else {
    base.push({ ...COMPONENT_LINK_TOOLBAR_ITEM })
  }
  return base
}

function markEditableTree(component) {
  const nextToolbar = withComponentLinkToolbar(component.get?.('toolbar'))
  const tag = (component.get('tagName') || '').toLowerCase()
  if (['img', 'br', 'hr', 'svg', 'path'].includes(tag)) {
    if (tag === 'img') {
      component.set({
        editable: false,
        draggable: true,
        resizable: { ...IMAGE_RESIZE_HANDLES },
        toolbar: nextToolbar,
      })
    }
    return
  }
  component.components().forEach((child) => markEditableTree(child))
  if (TOOLBAR_TEXT_TAGS.has(tag)) {
    component.set({
      editable: true,
      selectable: true,
      hoverable: true,
      highlightable: true,
      toolbar: nextToolbar,
    })
  } else {
    component.set({
      toolbar: nextToolbar,
    })
  }
}

function configureWrapper(editor) {
  const w = editor.getWrapper()
  w.set({
    selectable: false,
    hoverable: false,
    highlightable: false,
    badgable: false,
    draggable: false,
    droppable: true,
    removable: false,
    copyable: false,
  })
}

/** iframe 내부 텍스트 선택 저장 (상단 툴바 클릭 시 포커스 이탈 대비). 링크 모달 등은 caret만 있어도 저장 */
function saveIframeSelection(editor, rangeRef, { allowCollapsed = false } = {}) {
  try {
    const doc = editor.Canvas.getDocument()
    const sel = doc.getSelection()
    if (sel && sel.rangeCount > 0 && (!sel.isCollapsed || allowCollapsed)) {
      rangeRef.current = sel.getRangeAt(0).cloneRange()
    }
  } catch {
    rangeRef.current = null
  }
}

function restoreIframeSelection(editor, rangeRef) {
  const r = rangeRef.current
  if (!r) return false
  try {
    const doc = editor.Canvas.getDocument()
    const sel = doc.getSelection()
    sel.removeAllRanges()
    sel.addRange(r)
    return true
  } catch {
    return false
  }
}

function execOnIframeSelection(editor, rangeRef, fn) {
  restoreIframeSelection(editor, rangeRef)
  fn()
}

const LINK_PENDING_ATTR = 'data-be-link-pending'

/**
 * RTE 링크 모달 직전: 선택을 임시 span 으로 감쌈.
 * 모달에서 포커스가 나가면 Grapes가 RTE 를 끄며 DOM을 동기화해 cloneRange 가 무효화되므로,
 * 마커로 위치를 유지한 뒤 삽입 완료 시 <a> 로 치환한다.
 */
function wrapSelectionForPendingLink(rte) {
  const doc = rte.doc
  const sel = doc.getSelection()
  if (!sel?.rangeCount) return
  const range = sel.getRangeAt(0)
  const span = doc.createElement('span')
  span.setAttribute(LINK_PENDING_ATTR, '1')

  if (range.collapsed) {
    span.appendChild(doc.createTextNode('\u200b'))
    range.insertNode(span)
    const nr = doc.createRange()
    nr.selectNodeContents(span)
    nr.collapse(false)
    sel.removeAllRanges()
    sel.addRange(nr)
    return
  }
  try {
    range.surroundContents(span)
  } catch {
    const frag = range.extractContents()
    span.appendChild(frag)
    range.insertNode(span)
  }
}

function unwrapPendingLinkInCanvas(editor) {
  const doc = editor.Canvas.getDocument()
  const el = doc.querySelector(`[${LINK_PENDING_ATTR}]`)
  if (!el?.parentNode) return null
  const parent = el.parentNode
  while (el.firstChild) parent.insertBefore(el.firstChild, el)
  parent.removeChild(el)
  return parent?.nodeType === 1 ? parent : null
}

function applyPendingLinkInCanvas(editor, hrefRaw) {
  const href = hrefRaw.trim()
  if (!href) return false
  const doc = editor.Canvas.getDocument()
  const pending = doc.querySelector(`[${LINK_PENDING_ATTR}]`)
  if (!pending) return false
  const a = doc.createElement('a')
  a.href = href
  a.target = '_blank'
  a.rel = 'noopener noreferrer'
  while (pending.firstChild) a.appendChild(pending.firstChild)
  pending.replaceWith(a)
  notifyGrapesInputFromDomNode(editor, a)
  return true
}

function syncRteLinkChangeToModel(editor, nodeHint) {
  if (!editor) return
  if (nodeHint) notifyGrapesInputFromDomNode(editor, nodeHint)
  const selectedView = editor.getSelected?.()?.getView?.()
  if (typeof selectedView?.onInput === 'function') {
    selectedView.onInput()
  }
}

/** 프로그램matic DOM 변경 후 Grapes 텍스트 컴포넌트에 input 과 동일하게 동기화 */
function notifyGrapesInputFromDomNode(editor, node) {
  try {
    let el = node?.nodeType === 3 ? node.parentElement : node
    while (el) {
      if (el.__gjsv && typeof el.__gjsv.onInput === 'function') {
        el.__gjsv.onInput()
        return
      }
      el = el.parentElement
    }
    const cmp = editor.getSelected?.()
    const v = cmp?.getView?.()
    if (v?.onInput) v.onInput()
  } catch {
    /* ignore */
  }
}

function rgbStringToHex(rgb) {
  if (!rgb || rgb === 'transparent') return ''
  const m = rgb.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/i)
  if (!m) return ''
  const r = Number(m[1])
  const g = Number(m[2])
  const b = Number(m[3])
  return `#${[r, g, b].map((x) => x.toString(16).padStart(2, '0')).join('')}`
}

/** 네이티브 color input용 #rrggbb (없으면 기본값) */
function hexForColorInputFromStyle(st, fallback = '#ffffff') {
  if (!st || typeof st !== 'object') return fallback
  const tryStr = (s) => {
    if (!s || typeof s !== 'string') return ''
    const t = s.trim()
    if (/^#[0-9a-f]{6}$/i.test(t)) return t
    if (/^#[0-9a-f]{3}$/i.test(t)) {
      const r = t[1]
      const g = t[2]
      const b = t[3]
      return `#${r}${r}${g}${g}${b}${b}`.toLowerCase()
    }
    return rgbStringToHex(t)
  }
  const fromBgc = tryStr(st['background-color'])
  if (fromBgc) return fromBgc
  const bg = st.background
  if (bg && typeof bg === 'string' && !/gradient/i.test(bg)) {
    const fromBg = tryStr(bg)
    if (fromBg) return fromBg
  }
  return fallback
}

function getFontSizePxFromSelection(doc, win) {
  const sel = doc.getSelection()
  if (!sel?.focusNode) return 16
  let el = sel.focusNode.nodeType === 1 ? sel.focusNode : sel.focusNode.parentElement
  if (!el) return 16
  const fs = parseFloat(win.getComputedStyle(el).fontSize)
  return Number.isFinite(fs) ? Math.round(fs) : 16
}

/** RTE 글자 크기를 span 래핑 대신 부여할 블록(또는 인라인 대체) 호스트 */
const RTE_FS_BLOCK_TAGS = new Set([
  'p',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'li',
  'td',
  'th',
  'blockquote',
  'figcaption',
  'div',
])

function findRteFontSizeHostElement(node) {
  let el = node?.nodeType === 3 ? node.parentElement : node
  let inlineCandidate = null
  while (el && el.nodeType === 1) {
    const tag = el.tagName.toLowerCase()
    if (tag === 'body' || tag === 'html') break
    if (RTE_FS_BLOCK_TAGS.has(tag)) return el
    if (TOOLBAR_TEXT_TAGS.has(tag)) inlineCandidate = inlineCandidate || el
    el = el.parentElement
  }
  return inlineCandidate
}

function collectRteFontSizeHostElements(doc, range) {
  const hosts = new Set()
  const add = (n) => {
    const h = findRteFontSizeHostElement(n)
    if (h) hosts.add(h)
  }

  if (range.collapsed) {
    add(range.startContainer)
    return [...hosts]
  }

  const ca = range.commonAncestorContainer
  const root = ca.nodeType === 1 ? ca : ca.parentElement
  if (!root) {
    add(range.startContainer)
    add(range.endContainer)
    return [...hosts]
  }

  try {
    const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, null)
    let tn = walker.nextNode()
    while (tn) {
      if (range.intersectsNode(tn)) add(tn)
      tn = walker.nextNode()
    }
  } catch {
    /* ignore */
  }

  if (hosts.size === 0) {
    add(range.startContainer)
    add(range.endContainer)
  }
  return [...hosts]
}

function scheduleEditorCanvasRefresh(editor) {
  requestAnimationFrame(() => {
    try {
      editor?.refresh?.()
    } catch {
      /* ignore */
    }
  })
}

function getForeColorHexFromSelection(doc, win) {
  const sel = doc.getSelection()
  if (!sel?.focusNode) return ''
  let el = sel.focusNode.nodeType === 1 ? sel.focusNode : sel.focusNode.parentElement
  if (!el) return ''
  return rgbStringToHex(win.getComputedStyle(el).color) || ''
}

/** 선택(또는 캐럿)이 속한 텍스트 호스트 요소에 font-size(px) 인라인 스타일 적용 (span 래핑 없음) */
function applyFontSizePxToSelection(editor, doc, px) {
  const n = Math.max(8, Math.min(200, Math.round(Number(px)) || 16))
  const sel = doc.getSelection()
  if (!sel?.rangeCount) return
  const range = sel.getRangeAt(0)
  const hosts = collectRteFontSizeHostElements(doc, range)
  if (!hosts.length) return
  hosts.forEach((el) => {
    el.style.fontSize = `${n}px`
  })
  notifyGrapesInputFromDomNode(editor, hosts[0])
  scheduleEditorCanvasRefresh(editor)
}

function applyForeColorToSelection(editor, doc, color) {
  try {
    doc.execCommand('styleWithCSS', false, true)
  } catch {
    /* ignore */
  }
  const sel = doc.getSelection()
  if (!sel?.rangeCount) return
  let notifyEl = sel.anchorNode
  if (sel.isCollapsed) {
    const span = doc.createElement('span')
    span.style.color = color
    const z = doc.createTextNode('\u200b')
    span.appendChild(z)
    const r = sel.getRangeAt(0)
    r.insertNode(span)
    const nr = doc.createRange()
    nr.setStart(z, 1)
    nr.collapse(true)
    sel.removeAllRanges()
    sel.addRange(nr)
    notifyEl = span
  } else {
    doc.execCommand('foreColor', false, color)
  }
  notifyGrapesInputFromDomNode(editor, notifyEl)
  scheduleEditorCanvasRefresh(editor)
}

function applyHiliteColorToSelection(editor, doc, color) {
  try {
    doc.execCommand('styleWithCSS', false, true)
  } catch {
    /* ignore */
  }
  const sel = doc.getSelection()
  if (!sel?.rangeCount) return
  let notifyEl = sel.anchorNode
  if (sel.isCollapsed) {
    const span = doc.createElement('span')
    span.style.backgroundColor = color
    const z = doc.createTextNode('\u200b')
    span.appendChild(z)
    const r = sel.getRangeAt(0)
    r.insertNode(span)
    const nr = doc.createRange()
    nr.setStart(z, 1)
    nr.collapse(true)
    sel.removeAllRanges()
    sel.addRange(nr)
    notifyEl = span
  } else {
    try {
      doc.execCommand('hiliteColor', false, color)
    } catch {
      doc.execCommand('backColor', false, color)
    }
  }
  notifyGrapesInputFromDomNode(editor, notifyEl)
  scheduleEditorCanvasRefresh(editor)
}

function removeRteFormatExtras(toolbar) {
  toolbar?.querySelector('.be-rte-extras')?.remove()
}

/** 주입된 RTE 보조 컨트롤(.be-rte-extras) 입력값을 캔버스 선택 기준으로 맞춤 */
function syncRteExtrasInputsFromCanvas(editor) {
  const toolbar = editor.RichTextEditor?.getToolbarEl?.()
  const root = toolbar?.querySelector('.be-rte-extras')
  if (!root) return
  try {
    const doc = editor.Canvas.getDocument()
    const win = editor.Canvas.getWindow()
    const inp = root.querySelector('[data-rte-fs-input]')
    const fgInp = root.querySelector('[data-rte-fg-input]')
    const fgBar = root.querySelector('[data-rte-fg-bar]')
    if (inp) inp.value = String(getFontSizePxFromSelection(doc, win))
    const fgHex = fgInp ? getForeColorHexFromSelection(doc, win) : ''
    if (fgInp && fgHex) {
      fgInp.value = fgHex
      if (fgBar) fgBar.style.background = fgHex
    }
  } catch {
    /* ignore */
  }
}

/** Grapes RTE 툴바에 글자 크기·색 컨트롤 주입 */
function mountRteFormatExtras(editor, savedRangeRef) {
  const toolbar = editor.RichTextEditor.getToolbarEl()
  if (!toolbar) return
  removeRteFormatExtras(toolbar)

  const root = document.createElement('div')
  root.className = 'be-rte-extras'
  root.innerHTML = `
    <div class="be-font-size be-font-size--rte">
      <button type="button" class="be-btn" data-rte-act="fs-minus" title="1px 작게">−</button>
      <input type="number" min="8" max="200" data-rte-fs-input value="16" />
      <span class="be-font-size-suffix" aria-hidden="true">px</span>
      <button type="button" class="be-btn" data-rte-act="fs-plus" title="1px 크게">+</button>
    </div>
    <label class="be-color-wrap be-color-wrap--rte" title="글자색">
      <span class="be-color-fake" data-rte-fg-fake>A<span class="be-color-bar" data-rte-fg-bar></span></span>
      <input type="color" data-rte-fg-input value="#f8fafc" />
    </label>
    <label class="be-color-wrap be-color-wrap--rte" title="텍스트 배경(형광)">
      <span class="be-color-fake" data-rte-bg-fake>▧</span>
      <input type="color" data-rte-bg-input value="#ffff00" />
    </label>
  `

  const runInCanvas = (fn) => {
    execOnIframeSelection(editor, savedRangeRef, () => {
      const doc = editor.Canvas.getDocument()
      const win = editor.Canvas.getWindow()
      fn(doc, win)
    })
  }

  root.addEventListener('mousedown', (e) => e.stopPropagation())

  root.addEventListener('click', (e) => {
    const t = e.target
    if (t?.getAttribute?.('data-rte-act') === 'fs-minus') {
      e.preventDefault()
      const inp = root.querySelector('[data-rte-fs-input]')
      const cur = Math.max(8, Math.min(200, Number(inp?.value) || 16))
      const next = cur - 1
      if (inp) inp.value = String(next)
      runInCanvas((doc) => applyFontSizePxToSelection(editor, doc, next))
    }
    if (t?.getAttribute?.('data-rte-act') === 'fs-plus') {
      e.preventDefault()
      const inp = root.querySelector('[data-rte-fs-input]')
      const cur = Math.max(8, Math.min(200, Number(inp?.value) || 16))
      const next = cur + 1
      if (inp) inp.value = String(next)
      runInCanvas((doc) => applyFontSizePxToSelection(editor, doc, next))
    }
  })

  const fsInput = root.querySelector('[data-rte-fs-input]')
  fsInput?.addEventListener('change', () => {
    const next = Math.max(8, Math.min(200, Number(fsInput.value) || 16))
    fsInput.value = String(next)
    runInCanvas((doc) => applyFontSizePxToSelection(editor, doc, next))
  })
  fsInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') fsInput.dispatchEvent(new Event('change', { bubbles: true }))
  })

  const fgInput = root.querySelector('[data-rte-fg-input]')
  fgInput?.addEventListener('input', () => {
    const v = fgInput.value
    const bar = root.querySelector('[data-rte-fg-bar]')
    if (bar) bar.style.background = v
    runInCanvas((doc) => applyForeColorToSelection(editor, doc, v))
  })

  const bgInput = root.querySelector('[data-rte-bg-input]')
  bgInput?.addEventListener('input', () => {
    const v = bgInput.value
    runInCanvas((doc) => applyHiliteColorToSelection(editor, doc, v))
  })

  toolbar.appendChild(root)
  requestAnimationFrame(() => syncRteExtrasInputsFromCanvas(editor))
}

function parseVideoEmbed(url) {
  const u = url.trim()
  if (!u) return ''
  const yt = u.match(/(?:youtube\.com\/(?:watch\?v=|embed\/)|youtu\.be\/)([\w-]{11})/)
  if (yt) {
    return `<div class="gjs-video-wrap" style="position:relative;padding-bottom:56.25%;height:0;overflow:hidden;max-width:100%;border-radius:12px;"><iframe style="position:absolute;top:0;left:0;width:100%;height:100%;border:0;" src="https://www.youtube.com/embed/${yt[1]}" allowfullscreen></iframe></div>`
  }
  const vm = u.match(/vimeo\.com\/(?:video\/)?(\d+)/)
  if (vm) {
    return `<div class="gjs-video-wrap" style="position:relative;padding-bottom:56.25%;height:0;overflow:hidden;max-width:100%;border-radius:12px;"><iframe style="position:absolute;top:0;left:0;width:100%;height:100%;border:0;" src="https://player.vimeo.com/video/${vm[1]}" allowfullscreen></iframe></div>`
  }
  if (/^https?:\/\//i.test(u)) {
    return `<div class="gjs-video-wrap" style="position:relative;padding-bottom:56.25%;height:0;overflow:hidden;max-width:100%;border-radius:12px;"><iframe style="position:absolute;top:0;left:0;width:100%;height:100%;border:0;" src="${u.replace(/"/g, '&quot;')}" allowfullscreen></iframe></div>`
  }
  return ''
}

function insertHtmlIntoBlock(editor, html) {
  const root = getBlockRootComponent(editor)
  if (!root) {
    editor.getWrapper().append(html)
    return
  }
  const inner = root.find('.inner')[0] || root
  inner.append(html)
}

function isStylesheetLinkTag(tag) {
  return /\brel\s*=\s*(['"]?)stylesheet\1/i.test(String(tag || ''))
}

function splitHeadAssetsAndHtml(codeText) {
  const src = String(codeText || '')
  const linkTags = []
  let html = src
  html = html.replace(/<link\b[^>]*>/gi, (full) => {
    if (isStylesheetLinkTag(full)) {
      linkTags.push(full.trim())
      return ''
    }
    return full
  })

  const styles = []
  const styleRegex = /<style\b[^>]*>([\s\S]*?)<\/style>/gi
  html = html.replace(styleRegex, (_, css) => {
    styles.push(String(css || '').trim())
    return ''
  })

  return {
    links: linkTags,
    css: styles.filter(Boolean).join('\n\n'),
    html: html.trim(),
  }
}

function composeHeadAssetsMarkup({ links = [], css = '' }) {
  const linkPart = links.filter(Boolean).join('\n')
  const stylePart = css.trim() ? `<style>\n${css.trim()}\n</style>` : ''
  return [linkPart, stylePart].filter(Boolean).join('\n\n').trim()
}

function convertImageLinkMetaToAnchors(html) {
  const src = String(html || '')
  if (!src.trim()) return ''
  if (typeof DOMParser === 'undefined') return src

  try {
    const parser = new DOMParser()
    const doc = parser.parseFromString(`<body>${src}</body>`, 'text/html')
    const body = doc.body

    // 링크 삽입 중 임시 마커는 최종/내보내기 코드에 남기지 않는다.
    body.querySelectorAll(`[${LINK_PENDING_ATTR}]`).forEach((el) => {
      const parent = el.parentNode
      if (!parent) return
      while (el.firstChild) parent.insertBefore(el.firstChild, el)
      parent.removeChild(el)
    })

    const images = body.querySelectorAll(`img[${IMG_LINK_DATA_HREF}]`)

    images.forEach((img) => {
      const href = (img.getAttribute(IMG_LINK_DATA_HREF) || '').trim()
      const target = (img.getAttribute(IMG_LINK_DATA_TARGET) || '_blank').trim() || '_blank'
      const rel = (img.getAttribute(IMG_LINK_DATA_REL) || 'noopener noreferrer').trim() || 'noopener noreferrer'

      img.removeAttribute(IMG_LINK_DATA_HREF)
      img.removeAttribute(IMG_LINK_DATA_TARGET)
      img.removeAttribute(IMG_LINK_DATA_REL)
      if (!href) return

      const parent = img.parentElement
      if (parent?.tagName === 'A') {
        parent.setAttribute('href', href)
        parent.setAttribute('target', target)
        parent.setAttribute('rel', rel)
        return
      }

      const a = doc.createElement('a')
      a.setAttribute('href', href)
      a.setAttribute('target', target)
      a.setAttribute('rel', rel)
      parent?.insertBefore(a, img)
      a.appendChild(img)
    })

    return body.innerHTML
  } catch {
    return src
  }
}

function convertAnchoredImagesToLinkMeta(html) {
  const src = String(html || '')
  if (!src.trim()) return ''
  if (typeof DOMParser === 'undefined') return src

  try {
    const parser = new DOMParser()
    const doc = parser.parseFromString(`<body>${src}</body>`, 'text/html')
    const body = doc.body
    const anchors = body.querySelectorAll('a[href]')

    anchors.forEach((a) => {
      const imgs = Array.from(a.querySelectorAll('img'))
      if (imgs.length !== 1) return
      const img = imgs[0]
      const href = (a.getAttribute('href') || '').trim()
      if (!href) return
      const target = (a.getAttribute('target') || '_blank').trim() || '_blank'
      const rel = (a.getAttribute('rel') || 'noopener noreferrer').trim() || 'noopener noreferrer'

      img.setAttribute(IMG_LINK_DATA_HREF, href)
      img.setAttribute(IMG_LINK_DATA_TARGET, target)
      img.setAttribute(IMG_LINK_DATA_REL, rel)
      a.replaceWith(img)
    })

    return body.innerHTML
  } catch {
    return src
  }
}

function getCanvasDomHtmlSnapshot(editor) {
  try {
    const doc = editor?.Canvas?.getDocument?.()
    const body = doc?.body
    if (!body) return ''
    const clone = body.cloneNode(true)
    clone.querySelectorAll('*').forEach((el) => {
      Array.from(el.attributes || []).forEach((attr) => {
        const name = String(attr.name || '')
        if (name.startsWith('data-gjs-')) el.removeAttribute(name)
      })
      // 편집 중 런타임 속성 제거
      if (el.getAttribute('contenteditable') != null) el.removeAttribute('contenteditable')
      if (el.getAttribute('draggable') === 'true') el.removeAttribute('draggable')
      if (el.getAttribute('spellcheck') != null) el.removeAttribute('spellcheck')
    })
    return clone.innerHTML || ''
  } catch {
    return ''
  }
}

function getExportHtml(editor, headAssets) {
  if (!editor) return ''
  const domHtml = getCanvasDomHtmlSnapshot(editor)
  const sourceHtml = domHtml || editor.getHtml() || ''
  const html = convertImageLinkMetaToAnchors(sourceHtml)
  const head = composeHeadAssetsMarkup(headAssets || {})
  return (head ? `${head}\n\n` : '') + html
}

function injectCanvasHeadAssets(editor, { links = [], css = '' }) {
  const doc = editor.Canvas.getDocument()
  const head = doc?.head
  if (!head) return

  head.querySelectorAll('[data-be-head-asset="1"]').forEach((el) => el.remove())

  links.forEach((tag) => {
    const tpl = doc.createElement('template')
    tpl.innerHTML = String(tag || '').trim()
    const el = tpl.content.firstElementChild
    if (el?.tagName === 'LINK') {
      el.setAttribute('data-be-head-asset', '1')
      head.appendChild(el)
    }
  })

  if (css.trim()) {
    const styleEl = doc.createElement('style')
    styleEl.setAttribute('data-be-head-asset', '1')
    styleEl.textContent = css
    head.appendChild(styleEl)
  }
}

/** <style> 제거 뒤 HTML 조각에서 <script> 태그만 분리 (재조합 시 HTML 끝에 이어 붙임) */
function splitHtmlAndScripts(htmlChunk) {
  const scripts = []
  const htmlOnly = String(htmlChunk || '').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, (full) => {
    scripts.push(full)
    return ''
  })
  return {
    htmlOnly: htmlOnly.replace(/\n{3,}/g, '\n\n').trim(),
    scriptsJoined: scripts.join('\n\n').trim(),
  }
}

function parseCodeModalSections(fullText) {
  const { css, links, html } = splitHeadAssetsAndHtml(fullText)
  const { htmlOnly, scriptsJoined } = splitHtmlAndScripts(html)
  return { css: css.trim(), links, htmlOnly, scriptsJoined }
}

function composeCodeModalSections({ links = [], css, htmlOnly, scriptsJoined }) {
  const linkPart = links.filter(Boolean).join('\n')
  const stylePart = css.trim() ? `<style>\n${css.trim()}\n</style>` : ''
  const headPart = [linkPart, stylePart].filter(Boolean).join('\n\n')
  const h = String(htmlOnly || '').trim()
  const s = String(scriptsJoined || '').trim()
  return `${headPart ? `${headPart}\n\n` : ''}${h}${s ? `\n${s}` : ''}`
}

async function formatDocumentWithPrettier(text) {
  const prettier = await import('prettier/standalone')
  const htmlPlugin = await import('prettier/plugins/html')
  const postcssPlugin = await import('prettier/plugins/postcss')
  const htmlPl = htmlPlugin.default ?? htmlPlugin
  const postcssPl = postcssPlugin.default ?? postcssPlugin
  return prettier.format(String(text || ''), {
    parser: 'html',
    plugins: [htmlPl, postcssPl],
    printWidth: 100,
  })
}

const pendingFrameMeasureHandles = new WeakMap()

function clearPendingFrameMeasures(editor) {
  const h = pendingFrameMeasureHandles.get(editor)
  if (h) {
    h.timeouts.forEach(clearTimeout)
    h.rafs.forEach(cancelAnimationFrame)
    pendingFrameMeasureHandles.delete(editor)
  }
}

function applyCanvasFramePx(editor, px, { skipRefresh = false } = {}) {
  try {
    const iframe = editor.Canvas.getFrameEl()
    if (!iframe) return
    const h = `${px}px`
    iframe.style.height = h
    iframe.style.minHeight = h
    const wrap = iframe.closest('.gjs-frame-wrapper')
    if (wrap) {
      wrap.style.height = h
      wrap.style.minHeight = h
    }
    if (!skipRefresh) editor.refreshCanvas?.()
  } catch {
    /* ignore */
  }
}

/**
 * iframe/래퍼 높이를 잠긴 픽셀(px)로 맞춤.
 * lockRef.current 에 숫자가 있으면 편집 중에는 재측정 없이 유지하고,
 * 코드 보기에서 소스 적용 시에만 reset 으로 다시 잠급니다.
 */
function syncCanvasFrameHeight(editor, lockRef, { reset = false } = {}) {
  try {
    const iframe = editor.Canvas.getFrameEl()
    const doc = iframe?.contentDocument
    const body = doc?.body
    const rootEl = doc?.documentElement
    if (!iframe || !body || !rootEl) return

    if (!reset && lockRef.current != null) {
      applyCanvasFramePx(editor, lockRef.current)
      return
    }

    clearPendingFrameMeasures(editor)
    if (reset) lockRef.current = null

    let sessionMax = 320
    const handles = { timeouts: [], rafs: [] }
    pendingFrameMeasureHandles.set(editor, handles)

    const measure = () => {
      try {
        if (!editor.Canvas?.getFrameEl()) return
        const h = Math.max(
          body.scrollHeight,
          rootEl.scrollHeight,
          body.offsetHeight,
          rootEl.offsetHeight,
          320,
        )
        sessionMax = Math.max(sessionMax, h)
        lockRef.current = sessionMax
        applyCanvasFramePx(editor, sessionMax)
      } catch {
        /* ignore */
      }
    }

    measure()
    handles.rafs.push(requestAnimationFrame(measure))
    ;[0, 50, 150, 400, 1000].forEach((ms) => {
      handles.timeouts.push(setTimeout(measure, ms))
    })
  } catch {
    /* ignore */
  }
}

function shouldHandleShortcut(e, modalOpen, shellEl) {
  if (modalOpen) return false
  const t = e.target
  if (t.closest?.('.be-modal-overlay')) return false
  if (!shellEl) return false
  if (t.closest?.('.be-toolbar')) return true
  if (t.closest?.('.be-img-toolbar')) return true
  if (t.closest?.('.gjs-editor') || t.closest?.('.gjs-cv-canvas')) return true
  const ae = document.activeElement
  if (ae?.tagName === 'IFRAME' && shellEl.contains(ae)) return true
  return false
}

/** ancestor 중 contenteditable 호스트가 있으면 true (GrapesJS RTE / 브라우저 상속 반영) */
function domNodeInsideContentEditable(node) {
  let el = node?.nodeType === 3 ? node.parentElement : node
  while (el && el.nodeType === 1) {
    if (el.isContentEditable) return true
    const attr = el.getAttribute?.('contenteditable')
    if (attr === 'true' || attr === '') return true
    el = el.parentElement
  }
  return false
}

/** keydown target이 body 등이어도, 캔버스 안에서 글자 편집 중이면 true */
function isCanvasDomTextEditing(e, editor) {
  const tgt = e.target
  if (tgt?.nodeType === 3) return domNodeInsideContentEditable(tgt)
  if (tgt?.nodeType === 1 && domNodeInsideContentEditable(tgt)) return true

  try {
    const doc = editor.Canvas.getDocument()
    const ae = doc.activeElement
    if (ae && ae !== doc.body && domNodeInsideContentEditable(ae)) return true

    const sel = doc.getSelection()
    if (sel?.rangeCount) return domNodeInsideContentEditable(sel.anchorNode)
  } catch {
    /* ignore */
  }
  return false
}

function domNodeInsideAnchorTag(node) {
  if (!node) return false
  let n = node.nodeType === 3 ? node.parentElement : node
  while (n && n.nodeType === 1) {
    if (n.nodeName === 'A') return true
    n = n.parentElement
  }
  return false
}

/** RTE selection 이 링크 안인지 (anchor·focus 모두 확인, Grapes isValidTag 와 동일 취지) */
function rteSelectionInsideAnchor(rte) {
  const sel = rte?.selection?.()
  if (!sel?.anchorNode) return false
  if (domNodeInsideAnchorTag(sel.anchorNode)) return true
  if (sel.focusNode && sel.focusNode !== sel.anchorNode && domNodeInsideAnchorTag(sel.focusNode)) return true
  return false
}

/** 툴바 클릭 직전 저장된 Range 가 <a> 안을 가리키는지 (mousedown 후 selection 이 비어도 판별) */
function savedRangeTouchesAnchor(rangeRef) {
  const r = rangeRef.current
  if (!r) return false
  try {
    if (domNodeInsideAnchorTag(r.startContainer)) return true
    if (domNodeInsideAnchorTag(r.endContainer)) return true
    let n = r.commonAncestorContainer
    if (n.nodeType === 3) n = n.parentElement
    return domNodeInsideAnchorTag(n)
  } catch {
    return false
  }
}

const initialImgToolbarState = { visible: false, top: 0, left: 0 }

function isImgComponent(cmp) {
  if (!cmp) return false
  const tag = (cmp.get('tagName') || '').toLowerCase()
  if (tag === 'img') return true
  const type = String(cmp.get('type') || '').toLowerCase()
  return type === 'image'
}

function findClosestAnchorComponent(component) {
  let cur = component
  while (cur) {
    const tag = (cur.get('tagName') || '').toLowerCase()
    if (tag === 'a') return cur
    cur = cur.parent?.()
  }
  return null
}

const IMG_LINK_DATA_HREF = 'data-be-link-href'
const IMG_LINK_DATA_TARGET = 'data-be-link-target'
const IMG_LINK_DATA_REL = 'data-be-link-rel'

function getImageLinkData(component) {
  const attrs = component?.getAttributes?.() || {}
  return {
    href: String(attrs[IMG_LINK_DATA_HREF] || '').trim(),
    target: String(attrs[IMG_LINK_DATA_TARGET] || '_blank'),
    rel: String(attrs[IMG_LINK_DATA_REL] || 'noopener noreferrer'),
  }
}

function getFirstImageChild(component) {
  if (!component?.find) return null
  return component.find('img')?.[0] || null
}

function normalizeImageLinkPair(anchorComponent, imageComponent) {
  try {
    anchorComponent?.set?.({
      selectable: false,
      hoverable: false,
      highlightable: false,
      droppable: false,
      editable: false,
    })
    imageComponent?.set?.({
      selectable: true,
      hoverable: true,
      highlightable: true,
      draggable: true,
      resizable: { ...IMAGE_RESIZE_HANDLES },
      editable: false,
      toolbar: withComponentLinkToolbar(imageComponent.get?.('toolbar')),
    })
  } catch {
    /* ignore */
  }
}

function ensureImageLinkWrapper(editor, imageComponent) {
  if (!editor || !isImgComponent(imageComponent)) return imageComponent
  const { href, target, rel } = getImageLinkData(imageComponent)
  if (!href) return imageComponent

  const anchor = findClosestAnchorComponent(imageComponent)
  if (anchor) {
    anchor.addAttributes({ href, target, rel })
    normalizeImageLinkPair(anchor, imageComponent)
    return imageComponent
  }

  // 편집 중에는 <a><img/></a>로 구조를 바꾸지 않는다.
  // 래핑 교체는 GrapesJS에서 이미지 컴포넌트/핸들 상태를 깨뜨려 리사이즈가 풀리는 원인이 됨.
  return imageComponent
}

function syncImageToolbarPosition(editor, cmp, shellEl, setImgToolbar) {
  if (!isImgComponent(cmp)) {
    setImgToolbar(initialImgToolbarState)
    return
  }
  try {
    const el = cmp.getEl?.()
    const iframe = editor.Canvas.getFrameEl()
    if (!el?.getBoundingClientRect || !iframe || !shellEl?.getBoundingClientRect) {
      setImgToolbar(initialImgToolbarState)
      return
    }
    const inner = el.getBoundingClientRect()
    const ir = iframe.getBoundingClientRect()
    const shellRect = shellEl.getBoundingClientRect()
    const top = ir.top + inner.bottom - shellRect.top + shellEl.scrollTop + 8
    const left = ir.left + inner.left + inner.width / 2 - shellRect.left + shellEl.scrollLeft
    setImgToolbar({ visible: true, top, left })
  } catch {
    setImgToolbar(initialImgToolbarState)
  }
}

function applyImageSrcToComponent(editor, component, srcRaw) {
  const src = String(srcRaw || '').trim()
  if (!editor || !component || !src) return
  try {
    if (typeof component.set === 'function') {
      component.set('src', src)
    }
    component.addAttributes({ src })
    const el = component.getEl?.()
    if (el) {
      el.setAttribute('src', src)
      notifyGrapesInputFromDomNode(editor, el)
    }
  } catch {
    /* ignore */
  }
}

function applyLinkToComponent(editor, component, hrefRaw) {
  const href = String(hrefRaw || '').trim()
  if (!editor || !component || !href) return false
  const attrs = {
    href,
    target: '_blank',
    rel: 'noopener noreferrer',
  }

  const innerImage = getFirstImageChild(component)
  if (innerImage) {
    return applyLinkToComponent(editor, innerImage, href)
  }

  if (isImgComponent(component)) {
    component.addAttributes({
      [IMG_LINK_DATA_HREF]: href,
      [IMG_LINK_DATA_TARGET]: attrs.target,
      [IMG_LINK_DATA_REL]: attrs.rel,
    })
    const next = ensureImageLinkWrapper(editor, component)
    if (next) editor.select(next)
    return true
  }

  const anchor = findClosestAnchorComponent(component)
  if (anchor) {
    anchor.addAttributes(attrs)
    editor.select(anchor)
    return true
  }

  const html = component.toHTML?.()
  if (!html || typeof component.replaceWith !== 'function') return false
  const escapedHref = href.replace(/"/g, '&quot;')
  const wrapped = component.replaceWith(
    `<a href="${escapedHref}" target="_blank" rel="noopener noreferrer">${html}</a>`,
  )
  const next = Array.isArray(wrapped) ? wrapped[0] : wrapped
  if (next) editor.select(next)
  return true
}

/**
 * @param {{ initialHtml: string; blockLabel: string; sourcePath: string }} props
 */
export default function BlockEditor({ initialHtml, blockLabel, sourcePath }) {
  const containerRef = useRef(null)
  const shellRef = useRef(null)
  const editorRef = useRef(null)
  const savedRangeRef = useRef(null)
  const iframeKeydownRef = useRef(null)
  const headAssetsRef = useRef({ links: [], css: '' })
  /** 캔버스 iframe 고정 높이(px). 코드 보기 적용 시에만 재측정 */
  const canvasFrameLockRef = useRef(null)
  const codeOpenTextRef = useRef('')
  /** RTE 링크 버튼 → 상단과 동일한 링크 모달 (selection 은 savedRangeRef 에 저장) */
  const openRteLinkModalRef = useRef(() => {})
  /** 이미지 교체 모달 적용 대상 (선택이 바뀌어도 유지) */
  const imageReplaceTargetRef = useRef(null)
  /** 요소 툴바 링크 버튼 적용 대상 */
  const componentLinkTargetRef = useRef(null)
  const rteActiveRef = useRef(false)

  const [modalLink, setModalLink] = useState({ open: false, url: '', mode: 'rte' })
  const [modalImage, setModalImage] = useState({ open: false, url: '', mode: 'insert' })
  const [modalVideo, setModalVideo] = useState({ open: false, url: '' })
  const [modalCode, setModalCode] = useState({ open: false, text: '' })
  /** 코드 모달: 전체 | HTML(스크립트 제외) | CSS | 스크립트 */
  const [codeModalTab, setCodeModalTab] = useState('all')
  const [codeModalLoading, setCodeModalLoading] = useState(false)
  const [codeApplyState, setCodeApplyState] = useState({
    status: 'idle', // idle | applying | failure
    message: '',
    details: '',
  })

  const anyModalOpen =
    modalLink.open || modalImage.open || modalVideo.open || modalCode.open
  const anyModalOpenRef = useRef(false)
  anyModalOpenRef.current = anyModalOpen

  const [imgToolbar, setImgToolbar] = useState(initialImgToolbarState)

  /* 링크 모달은 RTE 툴바 mousedown 캡처에서 이미 selection 저장됨 (툴바가 iframe 밖이라 click 시점엔 선택이 사라짐) */
  openRteLinkModalRef.current = () => {
    componentLinkTargetRef.current = null
    setModalLink({ open: true, url: '', mode: 'rte' })
  }

  const refreshToolStyleFromSelection = useCallback(() => {
    const editor = editorRef.current
    if (!editor) return
    syncRteExtrasInputsFromCanvas(editor)
  }, [])

  useEffect(() => {
    if (!containerRef.current) return undefined

    let imgToolbarRaf = null
    const scheduleImgToolbar = (maybeCmp) => {
      if (imgToolbarRaf != null) cancelAnimationFrame(imgToolbarRaf)
      imgToolbarRaf = requestAnimationFrame(() => {
        imgToolbarRaf = null
        const ed = editorRef.current
        if (!ed || anyModalOpenRef.current || rteActiveRef.current) {
          setImgToolbar(initialImgToolbarState)
          return
        }
        const cmp = maybeCmp ?? ed.getSelected?.()
        syncImageToolbarPosition(ed, cmp, shellRef.current, setImgToolbar)
      })
    }

    const editor = grapesjs.init({
      container: containerRef.current,
      height: 'auto',
      width: '100%',
      fromElement: false,
      noticeOnUnload: false,
      storageManager: false,
      showOffsets: true,
      showDevices: false,
      keepUnusedStyles: true,
      panels: { defaults: [] },
      layerManager: { appendTo: '' },
      styleManager: { appendTo: '' },
      traitManager: { appendTo: '' },
      selectorManager: { appendTo: '' },
      blockManager: { appendTo: '' },
      deviceManager: {
        devices: [{ id: 'desktop', name: 'Desktop', width: '' }],
      },
      domComponents: {
        defaults: GJS_COMPONENT_DEFAULTS,
      },
      canvas: {
        styles: [],
        scripts: [],
        scrollableCanvas: true,
      },
      parser: {
        optionsHtml: {
          allowScripts: true,
          allowUnsafeAttr: true,
          allowUnsafeAttrValue: true,
        },
      },
      richTextEditor: {
        actions: [
          'bold',
          'italic',
          'underline',
          'strikethrough',
          {
            name: 'link',
            event: 'mousedown',
            attributes: {
              style: 'font-size:1.4rem;padding:0 4px 2px;',
              title: '링크',
            },
            result(rte) {
              if (rteSelectionInsideAnchor(rte) || savedRangeTouchesAnchor(savedRangeRef)) {
                rte.exec('unlink')
                return
              }
              wrapSelectionForPendingLink(rte)
              openRteLinkModalRef.current()
            },
          },
        ],
      },
    })

    editorRef.current = editor
    editor.Keymaps.removeAll()

    // GrapesJS 기본 이미지 뷰는 dblclick 시 AssetManager(Select Image)를 여는 onActive를 호출한다.
    // 우리 에디터는 커스텀 "이미지 교체" UX를 사용하므로, 이미지 더블클릭만 비활성화한다.
    const imageType = editor.DomComponents.getType('image')
    const BaseImageView = imageType?.view
    if (BaseImageView?.extend) {
      editor.DomComponents.addType('image', {
        model: imageType.model,
        view: BaseImageView.extend({
          events() {
            const baseEvents =
              (typeof BaseImageView.prototype.events === 'function'
                ? BaseImageView.prototype.events.call(this)
                : BaseImageView.prototype.events) || {}
            const nextEvents = { ...baseEvents }
            delete nextEvents.dblclick
            return nextEvents
          },
          onActive(ev) {
            ev?.stopPropagation?.()
          },
        }),
      })
    }

    editor.Commands.add('custom:cut', {
      run(ed) {
        ed.runCommand('core:copy')
        ed.runCommand('core:component-delete')
      },
    })

    editor.Commands.add('custom:component-bg', {
      run(ed) {
        const sel = ed.getSelected()
        if (!sel) return
        const input = document.createElement('input')
        input.type = 'color'
        input.value = hexForColorInputFromStyle(sel.getStyle?.() || {})
        input.onchange = () => {
          sel.addStyle({ 'background-color': input.value })
        }
        input.click()
      },
    })

    editor.Commands.add('custom:component-link', {
      run(ed) {
        const selected = ed.getSelected()
        if (!selected) return
        const target = getFirstImageChild(selected) || selected
        const anchor = findClosestAnchorComponent(target)
        const attrs = anchor?.getAttributes?.() || target.getAttributes?.() || {}
        const imgLink = getImageLinkData(target)
        componentLinkTargetRef.current = target
        setImgToolbar(initialImgToolbarState)
        setModalLink({
          open: true,
          url: String(attrs.href || imgLink.href || ''),
          mode: 'component',
        })
      },
    })

    editor.Commands.add('custom:block-bg', {
      run(ed) {
        const block = getBlockRootComponent(ed)
        if (!block) return
        const input = document.createElement('input')
        input.type = 'color'
        input.value = '#0f172a'
        input.onchange = () => {
          block.addStyle({ background: input.value })
        }
        input.click()
      },
    })

    const applyAutoFrameHeight = () => {
      // grapesjs.init() 반환값은 Editor 뷰 — Frame API는 EditorModel(em)에 있음
      editor.getModel().getCurrentFrameModel()?.set({ height: 'auto', minHeight: '200px' })
      injectCanvasHeadAssets(editor, headAssetsRef.current)
      syncCanvasFrameHeight(editor, canvasFrameLockRef, { reset: false })
    }

    let enforceLockRaf = null
    const enforceLockedFrameSize = () => {
      const px = canvasFrameLockRef.current
      if (px == null) return
      if (enforceLockRaf != null) cancelAnimationFrame(enforceLockRaf)
      enforceLockRaf = requestAnimationFrame(() => {
        enforceLockRaf = null
        applyCanvasFramePx(editor, px, { skipRefresh: true })
      })
    }

    editor.on('canvas:frame:load:body', applyAutoFrameHeight)
    editor.on('canvas:update', enforceLockedFrameSize)

    const parsedInitial = splitHeadAssetsAndHtml(initialHtml)
    headAssetsRef.current = { links: parsedInitial.links, css: parsedInitial.css }
    editor.setComponents(parsedInitial.html)

    let removeRteToolbarCapture = null
    let removeImgScrollListener = null

    editor.on('load', () => {
      injectCanvasHeadAssets(editor, headAssetsRef.current)
      configureWrapper(editor)
      markEditableTree(editor.getWrapper())
      syncCanvasFrameHeight(editor, canvasFrameLockRef, { reset: false })
      const frame = editor.Canvas.getFrameEl()
      const onFrameKeydown = (e) => {
        if (anyModalOpenRef.current) return
        handleEditorShortcuts(e, editor, false)
      }
      iframeKeydownRef.current = onFrameKeydown
      frame?.contentWindow?.addEventListener('keydown', onFrameKeydown, true)

      const rteToolbar = editor.RichTextEditor.getToolbarEl()
      const captureRteSelectionBeforeToolbarFocus = () => {
        saveIframeSelection(editor, savedRangeRef, { allowCollapsed: true })
      }
      rteToolbar?.addEventListener('pointerdown', captureRteSelectionBeforeToolbarFocus, true)
      rteToolbar?.addEventListener('mousedown', captureRteSelectionBeforeToolbarFocus, true)
      removeRteToolbarCapture = () => {
        rteToolbar?.removeEventListener('pointerdown', captureRteSelectionBeforeToolbarFocus, true)
        rteToolbar?.removeEventListener('mousedown', captureRteSelectionBeforeToolbarFocus, true)
      }

      const win = editor.Canvas.getWindow()
      const onFrameScroll = () => scheduleImgToolbar()
      win?.addEventListener('scroll', onFrameScroll, true)
      removeImgScrollListener = () => win?.removeEventListener('scroll', onFrameScroll, true)
    })

    editor.on('rte:enable', () => {
      rteActiveRef.current = true
      setImgToolbar(initialImgToolbarState)
      mountRteFormatExtras(editor, savedRangeRef)
    })
    editor.on('rte:disable', () => {
      rteActiveRef.current = false
      removeRteFormatExtras(editor.RichTextEditor.getToolbarEl())
      scheduleImgToolbar()
    })

    const onWinResize = () => scheduleImgToolbar()
    window.addEventListener('resize', onWinResize)

    editor.on('component:selected', (cmp) => {
      requestAnimationFrame(() => {
        // 링크 래퍼(<a>)가 선택된 경우 내부 이미지를 즉시 선택해 리사이즈 핸들을 유지
        const linkedImage = getFirstImageChild(cmp)
        if (linkedImage && cmp !== linkedImage) {
          normalizeImageLinkPair(cmp, linkedImage)
          editor.select(linkedImage)
          scheduleImgToolbar(linkedImage)
          return
        }
        if (cmp?.set) {
          cmp.set({
            toolbar: withComponentLinkToolbar(cmp.get?.('toolbar')),
          })
        }
        refreshToolStyleFromSelection()
        scheduleImgToolbar(cmp)
      })
    })
    editor.on('component:deselected', () => {
      setImgToolbar(initialImgToolbarState)
    })
    editor.on('component:update', (cmp) => {
      const ed = editorRef.current
      if (ed && cmp === ed.getSelected?.()) scheduleImgToolbar(cmp)
    })
    editor.on('component:drag:end', (payload) => {
      const ed = editorRef.current
      if (!ed) return
      const dragged = payload?.target || payload
      if (!isImgComponent(dragged)) return
      const next = ensureImageLinkWrapper(ed, dragged)
      if (next) {
        if (ed.getSelected?.() === dragged) ed.select(next)
        scheduleImgToolbar(next)
      }
    })
    editor.on('canvas:update', () => scheduleImgToolbar())

    function handleEditorShortcuts(e, ed, checkShell) {
      const shell = shellRef.current
      if (checkShell && !shouldHandleShortcut(e, anyModalOpenRef.current, shell)) return
      if (isCanvasDomTextEditing(e, ed) && ['b', 'i', 'u', 'z', 'y', 'Z', 'c', 'x', 'v'].includes(e.key)) {
        if ((e.ctrlKey || e.metaKey) && !e.altKey) {
          // 글자 편집 중 실행 취소/다시 실행은 GrapesJS 히스토리가 아니라 브라우저 contenteditable 스택
          if (e.key === 'z' || e.key === 'y' || e.key === 'Z') {
            return
          }
        }
        return
      }

      if (e.ctrlKey || e.metaKey) {
        const k = e.key.toLowerCase()
        if (k === 'z' && !e.shiftKey) {
          e.preventDefault()
          ed.runCommand('core:undo')
          return
        }
        if (k === 'z' && e.shiftKey) {
          e.preventDefault()
          ed.runCommand('core:redo')
          return
        }
        if (k === 'y') {
          e.preventDefault()
          ed.runCommand('core:redo')
          return
        }
        if (k === 'b' && shouldHandleShortcut(e, anyModalOpenRef.current, shell)) {
          e.preventDefault()
          execOnIframeSelection(ed, savedRangeRef, () => {
            ed.Canvas.getDocument().execCommand('bold', false)
          })
          return
        }
        if (k === 'i') {
          e.preventDefault()
          execOnIframeSelection(ed, savedRangeRef, () => {
            ed.Canvas.getDocument().execCommand('italic', false)
          })
          return
        }
        if (k === 'u') {
          e.preventDefault()
          execOnIframeSelection(ed, savedRangeRef, () => {
            ed.Canvas.getDocument().execCommand('underline', false)
          })
          return
        }
        if (k === 'c') {
          e.preventDefault()
          ed.runCommand('core:copy')
          return
        }
        if (k === 'x') {
          e.preventDefault()
          ed.runCommand('custom:cut')
          return
        }
        if (k === 'v') {
          e.preventDefault()
          ed.runCommand('core:paste')
          return
        }
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && !isCanvasDomTextEditing(e, ed)) {
        e.preventDefault()
        ed.runCommand('core:component-delete')
      }
    }

    const onShellKeydown = (e) => {
      if (!editorRef.current) return
      handleEditorShortcuts(e, editorRef.current, true)
    }
    const shellEl = shellRef.current
    shellEl?.addEventListener('keydown', onShellKeydown, true)

    return () => {
      if (imgToolbarRaf != null) cancelAnimationFrame(imgToolbarRaf)
      window.removeEventListener('resize', onWinResize)
      removeImgScrollListener?.()
      removeRteToolbarCapture?.()
      if (enforceLockRaf != null) cancelAnimationFrame(enforceLockRaf)
      clearPendingFrameMeasures(editor)
      shellEl?.removeEventListener('keydown', onShellKeydown, true)
      const frame = editor.Canvas.getFrameEl()
      if (frame?.contentWindow && iframeKeydownRef.current) {
        frame.contentWindow.removeEventListener('keydown', iframeKeydownRef.current, true)
      }
      canvasFrameLockRef.current = null
      editor.destroy()
      editorRef.current = null
    }
  }, [refreshToolStyleFromSelection, initialHtml])

  const onToolbarPointerDown = () => {
    const ed = editorRef.current
    if (ed) saveIframeSelection(ed, savedRangeRef, { allowCollapsed: true })
  }

  const runRte = (fn) => {
    const ed = editorRef.current
    if (!ed) return
    execOnIframeSelection(ed, savedRangeRef, () => fn(ed.Canvas.getDocument()))
  }

  const clearTextAlignInDescendants = (component) => {
    if (!component?.components) return
    component.components().forEach((child) => {
      const st = child.getStyle?.() || {}
      if (Object.prototype.hasOwnProperty.call(st, 'text-align')) {
        const { ['text-align']: _omit, ...rest } = st
        child.setStyle?.(rest)
      }
      clearTextAlignInDescendants(child)
    })
  }

  const setAlignment = (align) => {
    const ed = editorRef.current
    if (!ed) return
    const map = { left: 'left', center: 'center', right: 'right', justify: 'justify' }
    const ta = map[align] || 'left'
    const sel = ed.getSelected()
    if (sel) {
      // 부모 컨테이너 정렬 시, 자식에 남아있는 text-align 인라인값이 부모 정렬을 덮지 않도록 정리
      clearTextAlignInDescendants(sel)
      sel.addStyle({ 'text-align': ta })
      return
    }
    runRte((doc) => {
      const cmd =
        align === 'center'
          ? 'justifyCenter'
          : align === 'right'
            ? 'justifyRight'
            : align === 'justify'
              ? 'justifyFull'
              : 'justifyLeft'
      doc.execCommand(cmd, false)
    })
  }

  const openCodeModal = () => {
    const ed = editorRef.current
    if (!ed) return
    const raw = getExportHtml(ed, headAssetsRef.current)
    setCodeApplyState({ status: 'idle', message: '', details: '' })
    codeOpenTextRef.current = ''
    setCodeModalTab('all')
    setCodeModalLoading(true)
    setModalCode({ open: true, text: raw })
    void (async () => {
      let next = raw
      try {
        next = await formatDocumentWithPrettier(raw)
      } catch (err) {
        console.error('코드 모달 자동 Prettier 실패:', err)
      }
      setModalCode((m) => (m.open ? { ...m, text: next } : m))
      codeOpenTextRef.current = next
      setCodeModalLoading(false)
    })()
  }

  const closeCodeModal = () => {
    codeOpenTextRef.current = ''
    setCodeModalTab('all')
    setCodeModalLoading(false)
    setCodeApplyState({ status: 'idle', message: '', details: '' })
    setModalCode({ open: false, text: '' })
  }

  const formatCodeWithPrettier = async () => {
    try {
      const formatted = await formatDocumentWithPrettier(modalCode.text)
      setModalCode((m) => ({ ...m, text: formatted }))
      // codeOpenTextRef 는 모달 최초 오픈 시점(자동 Prettier 완료) 문자열만 유지.
      // 여기서 갱신하면 적용 시 "변경 없음"으로 오판해 setComponents 가 스킵되는 버그가 난다.
    } catch (err) {
      console.error('Prettier 실패:', err)
    }
  }

  const codeModalSections = useMemo(() => parseCodeModalSections(modalCode.text), [modalCode.text])

  const codeEditorPane = useMemo(() => {
    switch (codeModalTab) {
      case 'html':
        return { value: codeModalSections.htmlOnly, language: 'html' }
      case 'style':
        return { value: codeModalSections.css, language: 'css' }
      case 'script':
        return { value: codeModalSections.scriptsJoined, language: 'html' }
      default:
        return { value: modalCode.text, language: 'html' }
    }
  }, [codeModalTab, codeModalSections, modalCode.text])

  const onCodeEditorChange = useCallback(
    (v) => {
      const val = v ?? ''
      if (codeModalTab === 'all') {
        setModalCode((m) => ({ ...m, text: val }))
        return
      }
      const parsed = parseCodeModalSections(modalCode.text)
      if (codeModalTab === 'html') {
        setModalCode((m) => ({ ...m, text: composeCodeModalSections({ ...parsed, htmlOnly: val }) }))
      } else if (codeModalTab === 'style') {
        setModalCode((m) => ({ ...m, text: composeCodeModalSections({ ...parsed, css: val }) }))
      } else if (codeModalTab === 'script') {
        setModalCode((m) => ({ ...m, text: composeCodeModalSections({ ...parsed, scriptsJoined: val }) }))
      }
    },
    [codeModalTab, modalCode.text],
  )

  const applyCodeModal = () => {
    const ed = editorRef.current
    if (!ed) return
    if (codeModalLoading) return
    setCodeApplyState({ status: 'applying', message: '코드를 적용하는 중입니다...', details: '' })
    if (modalCode.text.trim() === codeOpenTextRef.current.trim()) {
      closeCodeModal()
      return
    }
    const { links, css, html } = splitHeadAssetsAndHtml(modalCode.text)
    const nextHtml = convertAnchoredImagesToLinkMeta(html).trim()
    if (!nextHtml) {
      setCodeApplyState({
        status: 'failure',
        message: '적용할 HTML이 비어 있습니다. 태그를 확인해 주세요.',
        details: '',
      })
      return
    }

    try {
      ed.setComponents(nextHtml)
    } catch (err) {
      console.error('코드 적용 실패(setComponents):', err)
      setCodeApplyState({
        status: 'failure',
        message: 'HTML 적용에 실패했습니다. 태그 구조를 확인해 주세요.',
        details: String(err?.message || err || ''),
      })
      return
    }

    headAssetsRef.current = { links, css }
    injectCanvasHeadAssets(ed, headAssetsRef.current)

    try {
      configureWrapper(ed)
      markEditableTree(ed.getWrapper())
      ed.getModel().getCurrentFrameModel()?.set({ height: 'auto', minHeight: '200px' })
      syncCanvasFrameHeight(ed, canvasFrameLockRef, { reset: true })
      ed.refresh?.()
    } catch (err) {
      console.error('코드 적용 후처리 실패:', err)
      setCodeApplyState({
        status: 'failure',
        message: '코드 적용 후처리 중 실패했습니다.',
        details: String(err?.message || err || ''),
      })
      return
    }

    closeCodeModal()
  }

  const handleSave = () => {
    const ed = editorRef.current
    if (!ed) return
    const exported = getExportHtml(ed, headAssetsRef.current)
    console.log(exported)
    console.log('저장이 완료되었습니다!')
  }

  return (
    <div className="be-root" ref={shellRef}>
      <div className="be-meta">
        {blockLabel} — 편집 영역 (보내기: <code>getExportHtml(editor)</code>). 원본: <code>{sourcePath}</code>
      </div>

      <div className="be-toolbar" onMouseDown={onToolbarPointerDown}>
        <div className="be-toolbar-group">
          <button type="button" className="be-btn" title="실행 취소 (Ctrl+Z)" onClick={() => editorRef.current?.runCommand('core:undo')}>
            <BeToolbarSvg>
              <path d="M9 14 4 9l5-5" />
              <path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5v0a5.5 5.5 0 0 1-5.5 5.5H11" />
            </BeToolbarSvg>
          </button>
          <button type="button" className="be-btn" title="다시 실행 (Ctrl+Y)" onClick={() => editorRef.current?.runCommand('core:redo')}>
            <BeToolbarSvg>
              <path d="m15 14 5-5-5-5" />
              <path d="M20 9H9.5A5.5 5.5 0 0 0 4 14.5v0A5.5 5.5 0 0 0 9.5 20H13" />
            </BeToolbarSvg>
          </button>
        </div>

        <div className="be-toolbar-group">
          <button type="button" className="be-btn" title="요소 배경색 (선택한 요소)" onClick={() => editorRef.current?.runCommand('custom:component-bg')}>
            <svg className="be-toolbar-svg" width={18} height={18} viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden>
              <rect x={4} y={4} width={16} height={16} rx={2} fill="none" stroke="currentColor" strokeWidth={1.75} />
              <rect x={8} y={8} width={8} height={8} rx={1} fill="currentColor" fillOpacity={0.22} stroke="currentColor" strokeWidth={1.75} />
            </svg>
          </button>
          <button type="button" className="be-btn" title="블록 전체 배경색" onClick={() => editorRef.current?.runCommand('custom:block-bg')}>
            <BeToolbarSvg>
              <rect x={3} y={3} width={18} height={18} rx={2.5} />
              <path d="M3 15h18" />
            </BeToolbarSvg>
          </button>
        </div>

        <div className="be-toolbar-group">
          <button type="button" className="be-btn" title="왼쪽 정렬" onClick={() => setAlignment('left')}>
            <BeToolbarSvg>
              <path d="M4 7h12M4 11h8M4 15h14" />
            </BeToolbarSvg>
          </button>
          <button type="button" className="be-btn" title="가운데 정렬" onClick={() => setAlignment('center')}>
            <BeToolbarSvg>
              <path d="M5 7h14M7 11h10M6 15h12" />
            </BeToolbarSvg>
          </button>
          <button type="button" className="be-btn" title="오른쪽 정렬" onClick={() => setAlignment('right')}>
            <BeToolbarSvg>
              <path d="M8 7h12M10 11h10M6 15h14" />
            </BeToolbarSvg>
          </button>
          <button type="button" className="be-btn" title="양쪽 정렬" onClick={() => setAlignment('justify')}>
            <BeToolbarSvg>
              <path d="M4 7h16M4 11h16M4 15h16M4 19h16" />
            </BeToolbarSvg>
          </button>
        </div>

        <div className="be-toolbar-group">
          <button
            type="button"
            className="be-btn"
            title="이미지"
            onClick={() => {
              imageReplaceTargetRef.current = null
              setModalImage({ open: true, url: '', mode: 'insert' })
            }}
          >
            <BeToolbarSvg>
              <rect x={3} y={3} width={18} height={18} rx={2} />
              <circle cx={8.5} cy={8.5} r={1.5} />
              <path d="m21 15-4-4-6 6" />
            </BeToolbarSvg>
          </button>
          <button type="button" className="be-btn" title="동영상" onClick={() => setModalVideo({ open: true, url: '' })}>
            <svg className="be-toolbar-svg" width={18} height={18} viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden>
              <rect x={2.5} y={5} width={13.5} height={14} rx={2} fill="none" stroke="currentColor" strokeWidth={1.75} />
              <path d="M17 9v6l5-3-5-3z" fill="currentColor" stroke="none" />
            </svg>
          </button>
          <button type="button" className="be-btn" title="코드 보기" onClick={openCodeModal}>
            <BeToolbarSvg>
              <path d="m16 18 6-6-6-6" />
              <path d="m8 6-6 6 6 6" />
            </BeToolbarSvg>
          </button>
        </div>

        <div className="be-spacer" />

        <button type="button" className="be-save" onClick={handleSave}>
          <svg className="be-toolbar-svg be-toolbar-svg--save" width={18} height={18} viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden>
            <g fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round">
              <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
              <polyline points="17 21 17 13 7 13 7 21" />
              <line x1={7} y1={3} x2={7} y2={8} />
              <line x1={12} y1={3} x2={12} y2={8} />
            </g>
          </svg>
          저장하기
        </button>
      </div>

      <div className="be-canvas-wrap">
        <div ref={containerRef} className="be-gjs-mount" />
      </div>

      {imgToolbar.visible && (
        <div
          role="toolbar"
          aria-label="이미지 도구"
          className="be-img-toolbar gjs-rte-toolbar"
          style={{
            position: 'absolute',
            top: imgToolbar.top,
            left: imgToolbar.left,
            transform: 'translate(-50%, 0)',
            zIndex: 30,
          }}
          onMouseDown={(e) => e.preventDefault()}
        >
          <button
            type="button"
            className="be-img-toolbar__btn"
            title="다른 이미지로 교체"
            onClick={() => {
              const ed = editorRef.current
              const cmp = ed?.getSelected?.()
              if (!isImgComponent(cmp)) return
              imageReplaceTargetRef.current = cmp
              const attrs = cmp.getAttributes?.() || {}
              const cur = attrs.src || ''
              setImgToolbar(initialImgToolbarState)
              setModalImage({ open: true, url: cur, mode: 'replace' })
            }}
          >
            이미지 교체
          </button>
        </div>
      )}

      {modalLink.open && (
        <div className="be-modal-overlay" role="dialog">
          <div className="be-modal">
            <h3>링크 삽입</h3>
            <div className="be-modal-body">
              <label htmlFor="be-link-url">URL</label>
              <input
                id="be-link-url"
                type="url"
                value={modalLink.url}
                onChange={(e) => setModalLink((m) => ({ ...m, url: e.target.value }))}
                placeholder="https://"
              />
            </div>
            <div className="be-modal-actions">
              <button
                type="button"
                className="be-btn"
                onClick={() => {
                  const ed = editorRef.current
                  if (ed && modalLink.mode === 'rte') unwrapPendingLinkInCanvas(ed)
                  componentLinkTargetRef.current = null
                  setModalLink({ open: false, url: '', mode: 'rte' })
                }}
              >
                취소
              </button>
              <button
                type="button"
                className="be-btn be-btn-primary"
                onClick={() => {
                  const ed = editorRef.current
                  const url = modalLink.url.trim()
                  if (!ed || !url) return
                  if (modalLink.mode === 'component') {
                    const target = componentLinkTargetRef.current || ed.getSelected?.()
                    if (!target || !applyLinkToComponent(ed, target, url)) return
                  } else {
                    let syncNode = null
                    ed.Canvas.getFrameEl()?.contentWindow?.focus()
                    if (!applyPendingLinkInCanvas(ed, url)) {
                      restoreIframeSelection(ed, savedRangeRef)
                      ed.Canvas.getDocument().execCommand('createLink', false, url)
                      try {
                        const doc = ed.Canvas.getDocument()
                        const sel = doc.getSelection()
                        const n = sel?.anchorNode
                        if (n) syncNode = n
                      } catch {
                        /* ignore */
                      }
                    }
                    // 어떤 경로로든 임시 마커가 남지 않게 마지막에 한 번 정리
                    const unwrappedParent = unwrapPendingLinkInCanvas(ed)
                    syncRteLinkChangeToModel(ed, unwrappedParent || syncNode)
                  }
                  componentLinkTargetRef.current = null
                  setModalLink({ open: false, url: '', mode: 'rte' })
                }}
              >
                삽입 완료
              </button>
            </div>
          </div>
        </div>
      )}

      {modalImage.open && (
        <div className="be-modal-overlay" role="dialog">
          <div className="be-modal">
            <h3>{modalImage.mode === 'replace' ? '이미지 교체' : '이미지 삽입'}</h3>
            <div className="be-modal-body">
              <label htmlFor="be-img-file">파일 선택</label>
              <input
                id="be-img-file"
                type="file"
                accept="image/*"
                onChange={(e) => {
                  const f = e.target.files?.[0]
                  if (!f) return
                  const r = new FileReader()
                  r.onload = () => setModalImage((m) => ({ ...m, url: String(r.result || '') }))
                  r.readAsDataURL(f)
                }}
              />
              <label htmlFor="be-img-url">이미지 URL</label>
              <input
                id="be-img-url"
                type="url"
                value={modalImage.url.startsWith('data:') ? '' : modalImage.url}
                onChange={(e) => setModalImage((m) => ({ ...m, url: e.target.value }))}
                placeholder="https://..."
              />
            </div>
            <div className="be-modal-actions">
              <button
                type="button"
                className="be-btn"
                onClick={() => {
                  imageReplaceTargetRef.current = null
                  setModalImage({ open: false, url: '', mode: 'insert' })
                }}
              >
                취소
              </button>
              <button
                type="button"
                className="be-btn be-btn-primary"
                onClick={() => {
                  const ed = editorRef.current
                  const src = modalImage.url.trim()
                  if (!ed || !src) return
                  const mode = modalImage.mode || 'insert'
                  if (mode === 'replace') {
                    applyImageSrcToComponent(ed, imageReplaceTargetRef.current, src)
                    imageReplaceTargetRef.current = null
                  } else {
                    insertHtmlIntoBlock(
                      ed,
                      `<img src="${src.replace(/"/g, '&quot;')}" alt="" style="max-width:100%;height:auto;border-radius:12px;"/>`,
                    )
                  }
                  setModalImage({ open: false, url: '', mode: 'insert' })
                }}
              >
                {modalImage.mode === 'replace' ? '교체 적용' : '이미지 삽입'}
              </button>
            </div>
          </div>
        </div>
      )}

      {modalVideo.open && (
        <div className="be-modal-overlay" role="dialog">
          <div className="be-modal">
            <h3>동영상 삽입</h3>
            <div className="be-modal-body">
              <label htmlFor="be-vid-url">동영상 URL (YouTube, Vimeo 등)</label>
              <input
                id="be-vid-url"
                type="url"
                value={modalVideo.url}
                onChange={(e) => setModalVideo((m) => ({ ...m, url: e.target.value }))}
                placeholder="https://www.youtube.com/watch?v=..."
              />
            </div>
            <div className="be-modal-actions">
              <button type="button" className="be-btn" onClick={() => setModalVideo({ open: false, url: '' })}>
                취소
              </button>
              <button
                type="button"
                className="be-btn be-btn-primary"
                onClick={() => {
                  const ed = editorRef.current
                  const embed = parseVideoEmbed(modalVideo.url)
                  if (!ed || !embed) return
                  insertHtmlIntoBlock(ed, embed)
                  setModalVideo({ open: false, url: '' })
                }}
              >
                동영상 삽입
              </button>
            </div>
          </div>
        </div>
      )}

      {modalCode.open && (
        <div className="be-modal-overlay be-code-modal-backdrop" role="presentation" onMouseDown={closeCodeModal}>
          <div className="be-modal be-modal--wide be-code-modal" role="dialog" aria-modal="true" onMouseDown={(e) => e.stopPropagation()}>
            <header className="be-code-modal__head">
              <h3>HTML / 코드편집</h3>
              <button type="button" className="be-code-modal__close" onClick={closeCodeModal}>
                닫기
              </button>
            </header>
            <p className="be-code-modal__desc">블록 내보내기 HTML을 편집합니다. 적용하면 편집 상태가 복원됩니다.</p>
            <div className="be-code-modal__tabs" role="tablist" aria-label="코드 영역">
              {[
                { id: 'all', label: '전체' },
                { id: 'html', label: '<html>' },
                { id: 'style', label: '<style>' },
                { id: 'script', label: '<script>' },
              ].map((t) => (
                <button
                  key={t.id}
                  type="button"
                  role="tab"
                  aria-selected={codeModalTab === t.id}
                  className={`be-code-modal__tab${codeModalTab === t.id ? ' be-code-modal__tab--active' : ''}`}
                  disabled={codeModalLoading}
                  onClick={() => setCodeModalTab(t.id)}
                >
                  {t.label}
                </button>
              ))}
            </div>
            <div className="be-modal-body be-code-modal__editor">
              {codeModalLoading ? (
                <div className="be-code-modal__loading">코드를 정리하는 중…</div>
              ) : (
                <Editor
                  key={codeModalTab}
                  height="480px"
                  language={codeEditorPane.language}
                  theme="vs-dark"
                  value={codeEditorPane.value}
                  onChange={onCodeEditorChange}
                  options={{
                    fontSize: 13,
                    lineHeight: 22,
                    minimap: { enabled: true },
                    wordWrap: 'on',
                    scrollBeyondLastLine: false,
                    automaticLayout: true,
                    tabSize: 2,
                  }}
                />
              )}
            </div>
            {codeApplyState.status !== 'idle' && (
              <div className={`be-code-modal__notice be-code-modal__notice--${codeApplyState.status === 'applying' ? 'info' : 'error'}`}>
                <p>{codeApplyState.message}</p>
                {codeApplyState.details ? <pre>{codeApplyState.details}</pre> : null}
              </div>
            )}
            <div className="be-modal-actions be-code-modal__foot">
              <button type="button" className="be-btn" onClick={formatCodeWithPrettier} disabled={codeModalLoading}>
                Prettier로 정리
              </button>
              <button type="button" className="be-btn" onClick={closeCodeModal}>
                취소
              </button>
              <button
                type="button"
                className="be-btn be-btn-primary"
                onClick={applyCodeModal}
                disabled={codeApplyState.status === 'applying' || codeModalLoading}
              >
                적용
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
