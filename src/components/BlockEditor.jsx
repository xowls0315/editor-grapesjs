import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Editor from '@monaco-editor/react'
import grapesjs from 'grapesjs'
import postcss from 'postcss'
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

const DEFAULT_IMAGE_UPLOAD_ENDPOINT = 'http://localhost:3100/api/images/upload'

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

/** @param {string} id */
function escapeCssIdForQuerySelector(id) {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
    return CSS.escape(id)
  }
  return String(id || '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\s/g, '\\20 ')
}

/**
 * `ancestor`에서 `el`로 내려가는 자식 인덱스 경로(첫 루트 = ancestor, 없으면 null)
 */
function getChildIndexPathFromAncestor(el, ancestor) {
  const path = []
  let n = el
  while (n && n !== ancestor) {
    const p = n.parentNode
    if (!p) return null
    const idx = Array.prototype.indexOf.call(p.children, n)
    if (idx < 0) return null
    path.unshift(idx)
    n = p
  }
  return n === ancestor ? path : null
}

function getElementByPath(root, path) {
  if (!root || !path) return null
  let cur = root
  for (let i = 0; i < path.length; i += 1) {
    const next = cur.children && cur.children[path[i]]
    if (!next) return null
    cur = next
  }
  return cur
}

function isLikelyGrapesAutoId(id) {
  return /^i[a-z0-9-]+$/i.test(String(id || '').trim())
}

function hasMeaningfulText(value) {
  return String(value || '')
    .replace(/\u00a0/g, ' ')
    .trim().length > 0
}

/**
 * setComponents('') 이후 GrapesJS가 자동 생성하는 빈 placeholder div인지 판별
 * 예: <div id="ie89"></div>
 */
function isAutoEmptyPlaceholderElement(el) {
  if (!el || String(el.tagName || '').toLowerCase() !== 'div') return false
  if ((el.children?.length || 0) > 0) return false
  if (hasMeaningfulText(el.textContent)) return false
  const attrs = Array.from(el.attributes || [])
  if (!attrs.length) return true
  if (attrs.length === 1 && attrs[0].name === 'id' && isLikelyGrapesAutoId(attrs[0].value)) return true
  return false
}

function isAutoEmptyPlaceholderComponent(comp) {
  if (!comp || typeof comp.get !== 'function') return false
  const tag = String(comp.get('tagName') || 'div').toLowerCase()
  if (tag !== 'div') return false
  const children = comp.components?.()
  if (children?.length) return false
  if (hasMeaningfulText(comp.get('content'))) return false
  const attrs = comp.getAttributes?.() || {}
  const attrKeys = Object.keys(attrs)
  const style = comp.getStyle?.() || {}
  if (Object.keys(style).length > 0) return false
  const classes = comp.getClasses?.()
  const classCount = Array.isArray(classes) ? classes.length : typeof classes?.length === 'number' ? classes.length : 0
  if (classCount > 0) return false
  if (!attrKeys.length) return true
  if (attrKeys.length === 1 && attrKeys[0] === 'id' && isLikelyGrapesAutoId(attrs.id)) return true
  return false
}

function stripSingleAutoEmptyPlaceholderHtml(html) {
  const src = String(html || '').trim()
  if (!src) return ''
  const matched = src.match(/^<div\b([^>]*)><\/div>$/i)
  if (!matched) return src
  const attrsChunk = String(matched[1] || '')
  const idMatch = attrsChunk.match(/\bid\s*=\s*["']([^"']+)["']/i)
  if (!idMatch) return src
  // id 외 다른 속성이 있으면 사용자 의도로 간주하고 유지
  const withoutId = attrsChunk.replace(/\bid\s*=\s*["'][^"']+["']/i, '').replace(/\s+/g, '').trim()
  if (withoutId) return src
  return isLikelyGrapesAutoId(idMatch[1]) ? '' : src
}

/**
 * 캔버스와 동일한 구조의 `body` clone(`bodyClone`)에서, iframe 내 `liveEl`에 대응하는 노드 찾기
 * (id 일치 → 실패 시 liveBody 기준 child-index 경로)
 */
function findInBodyCloneByLiveElement(liveBody, liveEl, bodyClone) {
  if (!liveEl || !bodyClone || !liveBody) return null
  if (liveEl === liveBody) return bodyClone
  const iid = liveEl.id && String(liveEl.id).trim()
  if (iid) {
    try {
      const byId = bodyClone.querySelector(`#${escapeCssIdForQuerySelector(iid)}`)
      if (byId) return byId
    } catch {
      /* ignore */
    }
  }
  const path = getChildIndexPathFromAncestor(liveEl, liveBody)
  return path && path.length ? getElementByPath(bodyClone, path) : null
}

/**
 * 래퍼(그래페 루트) 바로 아래 1뎁스의 최상위 컴포넌트들(실제 "블록" 콘텐츠)만 HTML로 잇는다.
 * 살롱/스튜디오 등 특정 id·클래스에 의존하지 않는다.
 */
function getTopLevelComponentExportMarkupFromClone(editor, liveBody, bodyClone) {
  const w = editor.getWrapper()
  if (!w) return null
  const wrapEl = w.getEl()
  if (!wrapEl) return null
  const wrapInClone = findInBodyCloneByLiveElement(liveBody, wrapEl, bodyClone)
  if (!wrapInClone) return null
  const parts = []
  const col = w.components && w.components()
  if (col && typeof col.forEach === 'function') {
    col.forEach((comp) => {
      if (isAutoEmptyPlaceholderComponent(comp)) return
      if (!comp || typeof comp.getEl !== 'function') return
      const el = comp.getEl()
      if (!el) return
      const node = findInBodyCloneByLiveElement(liveBody, el, bodyClone)
      if (node && !isAutoEmptyPlaceholderElement(node)) parts.push(node.outerHTML)
    })
  } else {
    for (const el of Array.from(wrapInClone.children)) {
      if (el && !isAutoEmptyPlaceholderElement(el)) parts.push(el.outerHTML)
    }
  }
  if (parts.length) return parts.join('\n\n')
  return stripSingleAutoEmptyPlaceholderHtml(wrapInClone.innerHTML)
}

/**
 * getHtml()만 쓰는 대체 경로(스냅샷 실패 시). 래퍼 1뎁스만 합침
 */
function getTopLevelComponentHtmlFromGetHtml(editor) {
  try {
    if (!editor || !editor.getWrapper || !editor.getHtml) return editor?.getHtml?.() || ''
    const w = editor.getWrapper()
    if (!w) return editor.getHtml() || ''
    const col = w.components && w.components()
    const out = []
    if (col && typeof col.forEach === 'function') {
      col.forEach((c) => {
        try {
          if (isAutoEmptyPlaceholderComponent(c)) return
          if (!c) return
          const h = editor.getHtml({ component: c })
          const cleaned = stripSingleAutoEmptyPlaceholderHtml(h)
          if (cleaned) out.push(String(cleaned))
        } catch {
          /* ignore */
        }
      })
    }
    if (out.length) return out.join('\n\n')
  } catch {
    /* ignore */
  }
  return stripSingleAutoEmptyPlaceholderHtml(editor.getHtml() || '')
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

const IMAGE_REPLACE_TOOLBAR_ITEM = {
  id: 'img-replace',
  label:
    '<svg viewBox="0 0 64 64" width="20" height="20" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">' +
    '<path fill="currentColor" stroke="currentColor" stroke-width="0.9" stroke-linejoin="round" d="M58,31H26a2.00229,2.00229,0,0,0-2,2V57a2.00229,2.00229,0,0,0,2,2H58a2.00229,2.00229,0,0,0,2-2V33A2.00229,2.00229,0,0,0,58,31ZM45.49286,57l-5.35248-6.95782,4.96021-8.28339L56.74152,57Zm-2.52411,0H27.249L35,46.64014ZM58,33l.00092,22.35352L46.68555,40.53857a1.99991,1.99991,0,0,0-3.29395.19824l-4.56134,7.60236L36.585,45.42041a2.05524,2.05524,0,0,0-3.17871.01074L26,55.33051V33ZM35,41a3,3,0,1,0-3-3A3.00328,3.00328,0,0,0,35,41Zm0-4a1,1,0,1,1-1,1A1.001,1.001,0,0,1,35,37ZM29,27a.99974.99974,0,0,0,1-1V6a.99974.99974,0,0,0-1-1H5A.99974.99974,0,0,0,4,6V26a.99974.99974,0,0,0,1,1ZM17.79584,25H8.20416L13,19.51855Zm.22839-2.777L21.085,16.86621,26.77905,25H20.45428ZM28,7V23.256l-5.27637-7.53625a1.99934,1.99934,0,0,0-3.375.15381L16.6308,20.63062l-2.12592-2.42944a2.06733,2.06733,0,0,0-3.01074,0L6,24.48071V7ZM14,15a3,3,0,1,0-3-3A3.00328,3.00328,0,0,0,14,15Zm0-4a1,1,0,1,1-1,1A1.001,1.001,0,0,1,14,11Zm7,33H15V37h3a1.00015,1.00015,0,0,0,.78125-1.62451l-4-5a1.03532,1.03532,0,0,0-1.5625,0l-4,5A1.00015,1.00015,0,0,0,10,37h3v8a.99974.99974,0,0,0,1,1h7a1,1,0,0,0,0-2ZM14,32.60059,15.91895,35H12.08105ZM33,17H45v4H42a1.00015,1.00015,0,0,0-.78125,1.62451l4,5a1.00049,1.00049,0,0,0,1.5625,0l4-5A1.00015,1.00015,0,0,0,50,21H47V16a.99974.99974,0,0,0-1-1H33a1,1,0,0,0,0,2Zm13,8.39941L44.08105,23h3.83789Z"/>' +
    '</svg>',
  command: 'custom:image-replace',
  attributes: { title: '이미지 교체' },
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

function withImageReplaceToolbar(toolbar) {
  const base = Array.isArray(toolbar) ? [...toolbar] : []
  const exists = base.some((it) => it?.id === IMAGE_REPLACE_TOOLBAR_ITEM.id || it?.command === IMAGE_REPLACE_TOOLBAR_ITEM.command)
  if (exists) return base
  const delIdx = base.findIndex((it) => it?.command === 'core:component-delete')
  if (delIdx >= 0) {
    base.splice(delIdx, 0, { ...IMAGE_REPLACE_TOOLBAR_ITEM })
  } else {
    base.push({ ...IMAGE_REPLACE_TOOLBAR_ITEM })
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
        toolbar: withImageReplaceToolbar(nextToolbar),
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

/** 선택 영역 안의 인라인 font-size / FONT size 를 제거해 한 겹 래핑으로 통일할 때 사용 */
function stripFontSizingFromFragment(fragment) {
  const visit = (node) => {
    if (node.nodeType === 1) {
      const el = node
      if (el.tagName === 'FONT') {
        el.removeAttribute('size')
      }
      el.style?.removeProperty?.('font-size')
      const st = el.getAttribute('style')
      if (st !== null && (!String(st).trim())) el.removeAttribute('style')
    }
    const kids = node.childNodes ? [...node.childNodes] : []
    kids.forEach(visit)
  }
  if (!fragment) return
  ;[...fragment.childNodes].forEach(visit)
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

function isStyledSpan(el) {
  if (!el || el.tagName !== 'SPAN') return false
  return Boolean((el.getAttribute('style') || '').trim())
}

function nearestFontSizeSpan(node) {
  let el = node?.nodeType === 3 ? node.parentElement : node
  while (el && el.nodeType === 1) {
    if (isStyledSpan(el)) return el
    el = el.parentElement
  }
  return null
}

function nearestSpan(node) {
  let el = node?.nodeType === 3 ? node.parentElement : node
  while (el && el.nodeType === 1) {
    if (el.tagName === 'SPAN') return el
    el = el.parentElement
  }
  return null
}

function cleanupSpanStyle(el) {
  const st = (el?.getAttribute?.('style') || '').trim()
  if (!st) el?.removeAttribute?.('style')
}

/** 선택 영역이 요소의 `selectNodeContents` 범위와 시작·끝 경계까지 일치할 때만 true (부분 선택이면 false) */
function rangeSelectsExactlyElementContents(range, el) {
  if (!range || !el?.ownerDocument) return false
  try {
    const inner = el.ownerDocument.createRange()
    inner.selectNodeContents(el)
    return (
      range.compareBoundaryPoints(Range.START_TO_START, inner) === 0 &&
      range.compareBoundaryPoints(Range.END_TO_END, inner) === 0
    )
  } catch {
    return false
  }
}

/** style 속성 문자열 → 소문자 속성명 맵 */
function parseInlineStyleToMap(styleAttr) {
  const m = {}
  if (!styleAttr || typeof styleAttr !== 'string') return m
  for (const part of styleAttr.split(';')) {
    const idx = part.indexOf(':')
    if (idx === -1) continue
    const key = part.slice(0, idx).trim().toLowerCase()
    const val = part.slice(idx + 1).trim()
    if (key) m[key] = val
  }
  return m
}

function styleMapToString(map) {
  return Object.entries(map || {})
    .filter(([, v]) => v != null && String(v).trim() !== '')
    .map(([k, v]) => `${k}: ${v}`)
    .join('; ')
}

/** 바깥 span(이번에 적용한 스타일)이 이김 — 안쪽 legacy span과 합쳐 한 겹으로 만든다 */
function mergeInlineStyleMaps(innerBase, outerOverlay) {
  return { ...innerBase, ...outerOverlay }
}

/**
 * 짧은 선택·반복 서식 시 span>span>… 중첩을 줄인다.
 * 자식이 span 하나뿐이면 스타일 합친 뒤 자식을 펼친다(여러 겹 반복).
 */
function collapseNestedSpanChainIntoOuter(outerSpan) {
  let el = outerSpan
  if (!el || el.nodeType !== 1 || el.tagName !== 'SPAN') return el
  while (el.childNodes.length === 1) {
    const c = el.firstChild
    if (!c || c.nodeType !== 1 || c.tagName !== 'SPAN') break
    const inner = c
    const merged = mergeInlineStyleMaps(
      parseInlineStyleToMap(inner.getAttribute('style')),
      parseInlineStyleToMap(el.getAttribute('style')),
    )
    const s = styleMapToString(merged)
    if (s) el.setAttribute('style', s)
    else el.removeAttribute('style')
    while (inner.firstChild) el.insertBefore(inner.firstChild, inner)
    inner.remove()
    cleanupSpanStyle(el)
  }
  return el
}

function copySpanAttrsWithoutId(src, dst) {
  if (!src?.attributes || !dst?.setAttribute) return
  for (const attr of Array.from(src.attributes)) {
    if (!attr?.name || attr.name.toLowerCase() === 'id') continue
    dst.setAttribute(attr.name, attr.value)
  }
}

function fragmentHasRenderableContent(fragment) {
  if (!fragment) return false
  for (const n of Array.from(fragment.childNodes || [])) {
    if (n.nodeType === 1) return true
    if (n.nodeType === 3 && String(n.nodeValue || '').length > 0) return true
  }
  return false
}

function styleHasDecorationToken(span, token) {
  if (!span || !token) return false
  const map = parseInlineStyleToMap(span.getAttribute('style') || '')
  const raw = `${map['text-decoration-line'] || ''} ${map['text-decoration'] || ''}`.toLowerCase()
  return raw.includes(token)
}

/** range를 포함하는 조상 span 중, 해당 token(text-decoration)이 걸려 있고 부분 선택인 첫 후보 */
function findDecorationAncestorSpanForPartialRange(range, token) {
  if (!range || !token) return null
  let el = range.startContainer?.nodeType === 3 ? range.startContainer.parentElement : range.startContainer
  while (el && el.nodeType === 1) {
    if (el.tagName === 'SPAN') {
      const containsStart = el.contains(range.startContainer)
      const containsEnd = el.contains(range.endContainer)
      if (
        containsStart &&
        containsEnd &&
        styleHasDecorationToken(el, token) &&
        !rangeSelectsExactlyElementContents(range, el)
      ) {
        return el
      }
    }
    el = el.parentElement
  }
  return null
}

/** 조상 span을 before/selected/after 로 분할하고 selected span을 반환 */
function splitAncestorSpanByRange(doc, ancestorSpan, range) {
  if (!doc || !ancestorSpan || !range) return null
  if (!ancestorSpan.contains(range.startContainer) || !ancestorSpan.contains(range.endContainer)) return null

  try {
    const full = doc.createRange()
    full.selectNodeContents(ancestorSpan)

    const beforeR = doc.createRange()
    beforeR.setStart(full.startContainer, full.startOffset)
    beforeR.setEnd(range.startContainer, range.startOffset)

    const selR = range.cloneRange()

    const afterR = doc.createRange()
    afterR.setStart(range.endContainer, range.endOffset)
    afterR.setEnd(full.endContainer, full.endOffset)

    const beforeFrag = beforeR.cloneContents()
    const selectedFrag = selR.cloneContents()
    const afterFrag = afterR.cloneContents()

    const out = doc.createDocumentFragment()
    let selectedSpan = null

    const makePieceSpan = (frag) => {
      const sp = doc.createElement('span')
      copySpanAttrsWithoutId(ancestorSpan, sp)
      sp.appendChild(frag)
      return sp
    }

    if (fragmentHasRenderableContent(beforeFrag)) {
      out.appendChild(makePieceSpan(beforeFrag))
    }
    if (fragmentHasRenderableContent(selectedFrag)) {
      selectedSpan = makePieceSpan(selectedFrag)
      out.appendChild(selectedSpan)
    }
    if (fragmentHasRenderableContent(afterFrag)) {
      out.appendChild(makePieceSpan(afterFrag))
    }

    if (!selectedSpan) return null
    ancestorSpan.replaceWith(out)
    return selectedSpan
  } catch {
    return null
  }
}

function getSelectionTypographySnapshot(range, win) {
  if (!range || !win?.getComputedStyle) return null
  const sampleEl =
    range.startContainer?.nodeType === 3
      ? range.startContainer.parentElement
      : range.startContainer?.nodeType === 1
        ? range.startContainer
        : null
  if (!sampleEl) return null
  try {
    const cs = win.getComputedStyle(sampleEl)
    return {
      fontSize: cs?.fontSize || '',
      fontStyle: cs?.fontStyle || '',
      fontWeight: cs?.fontWeight || '',
    }
  } catch {
    return null
  }
}

function applyTypographySnapshotToSpan(span, snapshot) {
  if (!span?.style || !snapshot) return
  if (snapshot.fontSize) span.style.fontSize = snapshot.fontSize
  if (snapshot.fontStyle) span.style.fontStyle = snapshot.fontStyle
  if (snapshot.fontWeight) span.style.fontWeight = snapshot.fontWeight
}

function toggleInlineTextStyle(editor, doc, win, kind) {
  const sel = doc.getSelection()
  if (!sel?.rangeCount) return
  const range = sel.getRangeAt(0)
  const beforeTypography = getSelectionTypographySnapshot(range, win)
  let notifyEl = null

  const applyToStyle = (style, sampleEl) => {
    const cs = sampleEl ? win.getComputedStyle(sampleEl) : null
    if (kind === 'bold') {
      const w = cs?.fontWeight || ''
      const isBold = w === 'bold' || Number(w) >= 600
      style.fontWeight = isBold ? 'normal' : '700'
    } else if (kind === 'italic') {
      const isItalic = (cs?.fontStyle || '').includes('italic')
      style.fontStyle = isItalic ? 'normal' : 'italic'
    } else if (kind === 'underline' || kind === 'strike') {
      const rawDeco = `${style.textDecorationLine || ''} ${style.textDecoration || ''} ${cs?.textDecorationLine || ''} ${cs?.textDecoration || ''}`.toLowerCase()
      const set = new Set()
      if (rawDeco.includes('underline')) set.add('underline')
      if (rawDeco.includes('line-through')) set.add('line-through')
      const token = kind === 'underline' ? 'underline' : 'line-through'
      if (set.has(token)) set.delete(token)
      else set.add(token)
      if (set.size === 0) {
        style.removeProperty('text-decoration')
        style.removeProperty('text-decoration-line')
      } else {
        const line = Array.from(set).join(' ')
        style.setProperty('text-decoration', line)
        style.setProperty('text-decoration-line', line)
      }
    }
  }

  if (range.collapsed) {
    const baseNode = range.startContainer?.nodeType === 3 ? range.startContainer.parentElement : range.startContainer
    const span = nearestSpan(range.startContainer) || doc.createElement('span')
    if (!span.parentNode) {
      const z = doc.createTextNode('\u200b')
      span.appendChild(z)
      range.insertNode(span)
      const nr = doc.createRange()
      nr.setStart(z, 1)
      nr.collapse(true)
      sel.removeAllRanges()
      sel.addRange(nr)
    }
    applyToStyle(span.style, baseNode || span)
    cleanupSpanStyle(span)
    notifyEl = span
  } else {
    if (kind === 'underline' || kind === 'strike') {
      const token = kind === 'underline' ? 'underline' : 'line-through'
      const decoAncestor = findDecorationAncestorSpanForPartialRange(range, token)
      if (decoAncestor) {
        const isolated = splitAncestorSpanByRange(doc, decoAncestor, range)
        if (isolated) {
          applyTypographySnapshotToSpan(isolated, beforeTypography)
          applyToStyle(isolated.style, isolated)
          // 조상 분할 직후에는 내부 span(예: font-size 45px)이 실제 선택 스타일일 수 있다.
          // 여기서 외곽 span 병합을 강제로 수행하면 바깥 조각의 font-size(예: 56px)로 역전될 수 있어 생략한다.
          cleanupSpanStyle(isolated)
          const nr = doc.createRange()
          nr.selectNodeContents(isolated)
          sel.removeAllRanges()
          sel.addRange(nr)
          notifyEl = isolated
          if (notifyEl) notifyGrapesInputFromDomNode(editor, notifyEl)
          scheduleEditorCanvasRefresh(editor)
          return
        }
      }
    }

    const startSpan = nearestSpan(range.startContainer)
    const endSpan = nearestSpan(range.endContainer)
    if (
      startSpan &&
      startSpan === endSpan &&
      rangeSelectsExactlyElementContents(range, startSpan)
    ) {
      applyToStyle(startSpan.style, startSpan)
      cleanupSpanStyle(startSpan)
      notifyEl = startSpan
    } else {
      const span = doc.createElement('span')
      const sample = range.startContainer?.nodeType === 3 ? range.startContainer.parentElement : range.startContainer
      applyToStyle(span.style, sample || span)
      try {
        const frag = range.extractContents()
        span.appendChild(frag)
        range.insertNode(span)
        collapseNestedSpanChainIntoOuter(span)
        const nr = doc.createRange()
        nr.selectNodeContents(span)
        sel.removeAllRanges()
        sel.addRange(nr)
        cleanupSpanStyle(span)
        notifyEl = span
      } catch {
        return
      }
    }
  }

  if (notifyEl) notifyGrapesInputFromDomNode(editor, notifyEl)
  scheduleEditorCanvasRefresh(editor)
}

/** 선택(또는 캐럿)에 글자 크기(px) 적용 — 중첩 span font-size 가 남아 박스가 안 줄어드는 문제 방지 */
function applyFontSizePxToSelection(editor, doc, win, px) {
  const n = Math.max(8, Math.min(200, Math.round(Number(px)) || 16))
  try {
    doc.execCommand('styleWithCSS', false, true)
  } catch {
    /* ignore */
  }
  const sel = doc.getSelection()
  if (!sel?.rangeCount) return
  const range = sel.getRangeAt(0)
  let notifyEl = null

  if (range.collapsed) {
    const tn = range.startContainer
    if (tn.nodeType === 3) {
      const chain = []
      let p = tn.parentElement
      while (p && p.tagName === 'SPAN' && isStyledSpan(p)) {
        chain.push(p)
        p = p.parentElement
      }
      if (chain.length > 0) {
        chain.forEach((sp) => {
          sp.style.fontSize = `${n}px`
        })
        notifyGrapesInputFromDomNode(editor, chain[0])
        scheduleEditorCanvasRefresh(editor)
        return
      }
    }
    const span = doc.createElement('span')
    span.style.fontSize = `${n}px`
    const z = doc.createTextNode('\u200b')
    span.appendChild(z)
    range.insertNode(span)
    const nr = doc.createRange()
    nr.setStart(z, 1)
    nr.collapse(true)
    sel.removeAllRanges()
    sel.addRange(nr)
    notifyEl = span
  } else {
    const startSpan = nearestFontSizeSpan(range.startContainer)
    const endSpan = nearestFontSizeSpan(range.endContainer)
    if (
      startSpan &&
      startSpan === endSpan &&
      rangeSelectsExactlyElementContents(range, startSpan)
    ) {
      startSpan.style.fontSize = `${n}px`
      notifyGrapesInputFromDomNode(editor, startSpan)
      scheduleEditorCanvasRefresh(editor)
      return
    }
    const span = doc.createElement('span')
    span.style.fontSize = `${n}px`
    try {
      const frag = range.extractContents()
      stripFontSizingFromFragment(frag)
      span.appendChild(frag)
      range.insertNode(span)
      collapseNestedSpanChainIntoOuter(span)
      // 같은 텍스트를 연속 조절할 때 다음 액션도 이 span 범위를 기준으로 동작하도록 유지
      const nr = doc.createRange()
      nr.selectNodeContents(span)
      sel.removeAllRanges()
      sel.addRange(nr)
      notifyEl = span
    } catch {
      const t = sel.toString() || '\u200b'
      doc.execCommand('insertHTML', false, `<span style="font-size:${n}px">${t}</span>`)
      notifyEl = sel.anchorNode
    }
  }
  if (notifyEl) notifyGrapesInputFromDomNode(editor, notifyEl)
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
      // 다음 툴바 액션에서 이전 범위를 재복원하지 않도록, 적용 후 현재 selection을 다시 저장
      saveIframeSelection(editor, savedRangeRef, { allowCollapsed: true })
      syncRteExtrasInputsFromCanvas(editor)
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
      runInCanvas((doc, win) => applyFontSizePxToSelection(editor, doc, win, next))
    }
    if (t?.getAttribute?.('data-rte-act') === 'fs-plus') {
      e.preventDefault()
      const inp = root.querySelector('[data-rte-fs-input]')
      const cur = Math.max(8, Math.min(200, Number(inp?.value) || 16))
      const next = cur + 1
      if (inp) inp.value = String(next)
      runInCanvas((doc, win) => applyFontSizePxToSelection(editor, doc, win, next))
    }
  })

  const fsInput = root.querySelector('[data-rte-fs-input]')
  fsInput?.addEventListener('change', () => {
    const next = Math.max(8, Math.min(200, Number(fsInput.value) || 16))
    fsInput.value = String(next)
    runInCanvas((doc, win) => applyFontSizePxToSelection(editor, doc, win, next))
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

const RUNTIME_SELECTOR_PATTERNS = [
  /\.gjs-[\w-]+/i,
  /\[data-gjs-[\w-]+(?:=[^\]]+)?\]/i,
  /\[data-gjs-type\s*=\s*["']wrapper["']\]/i,
  /#gjs-css-rules/i,
  /\.gjs-css-rules/i,
  /\.gjs-js-cont/i,
  /^\*\s*::?-webkit-scrollbar(?:-track|-thumb)?$/i,
]

function normalizeCss(css) {
  return String(css || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function sanitizeLinks(links) {
  const seen = new Set()
  return (Array.isArray(links) ? links : [])
    .map((tag) => String(tag || '').trim())
    .filter(Boolean)
    .filter((tag) => isStylesheetLinkTag(tag))
    .filter((tag) => {
      const key = tag.replace(/\s+/g, ' ').trim()
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
}

function isRuntimeCssSelector(selector) {
  const src = String(selector || '').replace(/\s+/g, ' ').trim()
  if (!src) return false
  return RUNTIME_SELECTOR_PATTERNS.some((re) => re.test(src))
}

/** PostCSS Rule에서 개별 selector 목록(쉼표로 분리) */
function getRuleSelectorStrings(rule) {
  const direct = Array.isArray(rule?.selectors) ? rule.selectors : []
  if (direct.length) return direct.map((s) => String(s).trim())
  return String(rule?.selector || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

function isRuntimeBodyRule(rule) {
  const selectors = getRuleSelectorStrings(rule)
  if (selectors.length !== 1 || String(selectors[0] || '').trim().toLowerCase() !== 'body') return false
  const decls = []
  rule.walkDecls((d) => decls.push([String(d.prop || '').trim().toLowerCase(), String(d.value || '').trim().toLowerCase()]))
  if (!decls.length) return false
  return decls.every(([prop, value]) => {
    if (prop === 'background-color' && (value === '#fff' || value === '#ffffff' || value === 'white')) return true
    if (prop === 'margin' && value === '0') return true
    return false
  })
}

function isRuntimeUniversalBoxSizingRule(rule) {
  const selectors = getRuleSelectorStrings(rule)
  if (selectors.length !== 1 || String(selectors[0] || '').replace(/\s+/g, '').toLowerCase() !== '*') return false
  const decls = []
  rule.walkDecls((d) => decls.push([String(d.prop || '').trim().toLowerCase(), String(d.value || '').trim().toLowerCase()]))
  if (!decls.length) return false
  return decls.every(([prop, value]) => {
    const isBoxSizingProp = prop === 'box-sizing' || prop === '-webkit-box-sizing' || prop === '-moz-box-sizing'
    if (!isBoxSizingProp) return false
    return value === 'border-box'
  })
}

function filterCssByPostcss(css) {
  const src = normalizeCss(css)
  if (!src) return ''
  try {
    const root = postcss.parse(src)
    root.walkRules((rule) => {
      const selectors = getRuleSelectorStrings(rule)
      if (
        selectors.some((sel) => isRuntimeCssSelector(sel)) ||
        isRuntimeBodyRule(rule) ||
        isRuntimeUniversalBoxSizingRule(rule)
      ) {
        rule.remove()
      }
    })
    root.walkAtRules((atRule) => {
      if (!atRule.nodes || atRule.nodes.length === 0) atRule.remove()
    })
    return normalizeCss(root.toString())
  } catch {
    return src
  }
}

function dedupeCssBlocks(css) {
  const src = normalizeCss(css)
  if (!src) return ''
  try {
    const root = postcss.parse(src)
    const seen = new Set()
    root.each((node) => {
      const key = normalizeCss(node.toString())
      if (!key) {
        node.remove()
        return
      }
      if (seen.has(key)) {
        node.remove()
        return
      }
      seen.add(key)
    })
    return normalizeCss(root.toString())
  } catch {
    return src
  }
}

function sanitizeCss(css) {
  return dedupeCssBlocks(filterCssByPostcss(css))
}

function sanitizeHeadAssets({ links = [], css = '' } = {}) {
  return {
    links: sanitizeLinks(links),
    css: sanitizeCss(css),
  }
}

function stripRuntimeStyleTagsFromHtml(html) {
  const src = String(html || '')
  if (!src.trim()) return ''
  if (typeof DOMParser === 'undefined') return src
  try {
    const parser = new DOMParser()
    const doc = parser.parseFromString(`<body>${src}</body>`, 'text/html')
    doc.body.querySelectorAll('style').forEach((styleEl) => {
      const cleaned = sanitizeCss(styleEl.textContent || '')
      if (!cleaned) {
        styleEl.remove()
        return
      }
      styleEl.textContent = cleaned
    })
    return doc.body.innerHTML
  } catch {
    return src
  }
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

  const safeAssets = sanitizeHeadAssets({
    links: linkTags,
    css: styles.filter(Boolean).join('\n\n'),
  })

  return {
    links: safeAssets.links,
    css: safeAssets.css,
    html: stripRuntimeStyleTagsFromHtml(html).trim(),
  }
}

function composeHeadAssetsMarkup({ links = [], css = '' }) {
  const safe = sanitizeHeadAssets({ links, css })
  const linkPart = safe.links.filter(Boolean).join('\n')
  const stylePart = safe.css.trim() ? `<style>\n${safe.css.trim()}\n</style>` : ''
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
      // "순수 이미지 링크"만 변환:
      // <a><img ... /></a> 형태(공백 텍스트만 허용), 카드/복합 콘텐츠 링크는 유지
      const elementChildren = Array.from(a.children || [])
      if (elementChildren.length !== 1) return
      const onlyChild = elementChildren[0]
      if (!onlyChild || String(onlyChild.tagName || '').toLowerCase() !== 'img') return
      const textNodes = Array.from(a.childNodes || []).filter((n) => n.nodeType === Node.TEXT_NODE)
      const hasMeaningfulText = textNodes.some((n) => String(n.textContent || '').replace(/\u00a0/g, ' ').trim().length > 0)
      if (hasMeaningfulText) return
      const img = onlyChild
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

/**
 * GrapesJS 직렬화 과정에서 빈 class 속성이 남는 케이스 정리.
 * 예: <p class=""></p> -> <p></p>
 */
function stripEmptyClassAttributes(html) {
  const src = String(html || '')
  if (!src.trim()) return ''
  if (typeof DOMParser === 'undefined') {
    return src.replace(/\sclass=(['"])\s*\1/gi, '')
  }
  try {
    const parser = new DOMParser()
    const doc = parser.parseFromString(`<body>${src}</body>`, 'text/html')
    doc.body.querySelectorAll('[class]').forEach((el) => {
      const v = el.getAttribute('class')
      if (v == null || !String(v).trim()) el.removeAttribute('class')
    })
    return doc.body.innerHTML
  } catch {
    return src.replace(/\sclass=(['"])\s*\1/gi, '')
  }
}

function normalizeInlineStyleText(styleText) {
  const map = parseInlineStyleToMap(styleText || '')
  const out = {}
  Object.entries(map).forEach(([k, v]) => {
    const key = String(k || '').toLowerCase().trim()
    const val = String(v || '').trim()
    if (!key || !val) return
    // 기본값은 제거해서 코드 노이즈를 줄인다.
    if (key === 'font-weight' && (val === 'normal' || val === '400')) return
    if (key === 'font-style' && val === 'normal') return
    if ((key === 'text-decoration' || key === 'text-decoration-line') && val === 'none') return
    out[key] = val
  })
  const ordered = Object.keys(out)
    .sort()
    .reduce((acc, k) => {
      acc[k] = out[k]
      return acc
    }, {})
  return styleMapToString(ordered)
}

function hasRenderableNodeContent(el) {
  if (!el) return false
  const childElements = Array.from(el.children || [])
  if (childElements.length > 0) return true
  return hasMeaningfulText(el.textContent || '')
}

function hasOnlyStyleAttr(el) {
  if (!el?.attributes) return true
  const attrs = Array.from(el.attributes)
  return attrs.every((a) => String(a.name || '').toLowerCase() === 'style')
}

function normalizeInlineSpansHtml(html) {
  const src = String(html || '')
  if (!src.trim() || typeof DOMParser === 'undefined') return src
  try {
    const parser = new DOMParser()
    const doc = parser.parseFromString(`<body>${src}</body>`, 'text/html')
    const body = doc.body

    // 1) style 정규화 + 기본값 제거
    body.querySelectorAll('span[style]').forEach((span) => {
      const next = normalizeInlineStyleText(span.getAttribute('style') || '')
      if (next) span.setAttribute('style', next)
      else span.removeAttribute('style')
    })

    // 2) 빈 span 제거
    body.querySelectorAll('span').forEach((span) => {
      if (!hasRenderableNodeContent(span)) span.remove()
    })

    // 3) 부모/자식 span 동일 style 겹침 해제
    body.querySelectorAll('span').forEach((span) => {
      const parent = span.parentElement
      if (!parent || parent.tagName !== 'SPAN') return
      const ps = parent.getAttribute('style') || ''
      const cs = span.getAttribute('style') || ''
      if (!ps || ps !== cs) return
      if (!hasOnlyStyleAttr(parent) || !hasOnlyStyleAttr(span)) return
      while (span.firstChild) parent.insertBefore(span.firstChild, span)
      span.remove()
    })

    // 4) 인접 동일 style span 병합
    body.querySelectorAll('span').forEach((span) => {
      let next = span.nextSibling
      while (next && next.nodeType === Node.TEXT_NODE && !hasMeaningfulText(next.textContent || '')) {
        next = next.nextSibling
      }
      if (!next || next.nodeType !== 1 || String(next.tagName || '').toLowerCase() !== 'span') return
      const a = span.getAttribute('style') || ''
      const b = next.getAttribute('style') || ''
      if (a !== b) return
      if (!hasOnlyStyleAttr(span) || !hasOnlyStyleAttr(next)) return
      while (next.firstChild) span.appendChild(next.firstChild)
      next.remove()
    })

    // 5) style가 완전히 비었으면 span 언랩
    body.querySelectorAll('span').forEach((span) => {
      const style = (span.getAttribute('style') || '').trim()
      if (style) return
      if (!hasOnlyStyleAttr(span)) return
      const parent = span.parentNode
      if (!parent) return
      while (span.firstChild) parent.insertBefore(span.firstChild, span)
      span.remove()
    })

    return body.innerHTML
  } catch {
    return src
  }
}

function collectIdsFromHtml(html) {
  const out = new Set()
  const src = String(html || '')
  if (!src.trim()) return out
  if (typeof DOMParser === 'undefined') return out
  try {
    const parser = new DOMParser()
    const doc = parser.parseFromString(`<body>${src}</body>`, 'text/html')
    doc.body.querySelectorAll('[id]').forEach((el) => {
      const id = String(el.getAttribute('id') || '').trim()
      if (id) out.add(id)
    })
  } catch {
    /* ignore */
  }
  return out
}

function mergeIdSet(targetSet, sourceSet) {
  if (!targetSet || !sourceSet) return
  sourceSet.forEach((id) => targetSet.add(id))
}

/**
 * 코드 모달/내보내기 문자열에서만 GrapesJS 임시 id 제거.
 * - 편집 런타임 DOM에는 손대지 않음
 * - 사용자 정의 id(초기/적용 코드에서 수집)는 유지
 */
function stripTemporaryIdsForExport(html, preservedIds) {
  const src = String(html || '')
  if (!src.trim()) return ''
  if (typeof DOMParser === 'undefined') return src
  const preserve = preservedIds instanceof Set ? preservedIds : new Set()
  try {
    const parser = new DOMParser()
    const doc = parser.parseFromString(`<body>${src}</body>`, 'text/html')
    doc.body.querySelectorAll('[id]').forEach((el) => {
      const id = String(el.getAttribute('id') || '').trim()
      if (!id) return
      if (preserve.has(id)) return
      if (isLikelyGrapesAutoId(id)) el.removeAttribute('id')
    })
    return doc.body.innerHTML
  } catch {
    return src
  }
}

/**
 * GrapesJS 캔버스(iframe) 런타임 DOM에서 빈 class 속성 제거.
 * 편집 중 내부 동기화로 class=""가 재생성될 수 있어 이벤트마다 정리한다.
 */
function removeEmptyClassAttrsInCanvas(editor) {
  try {
    const doc = editor?.Canvas?.getDocument?.()
    const body = doc?.body
    if (!body) return
    body.querySelectorAll('[class]').forEach((el) => {
      const classValue = el.getAttribute('class')
      if (classValue == null || !String(classValue).trim()) el.removeAttribute('class')
    })
  } catch {
    /* ignore */
  }
}

/**
 * GrapesJS 컴포넌트 모델 attributes에서 빈 class 제거.
 * 모델에 class: ''가 남아 있으면 렌더링 시 DOM에 class=""가 재주입될 수 있다.
 */
function removeEmptyClassAttrsInComponentTree(component) {
  if (!component || typeof component.getAttributes !== 'function') return
  try {
    const attrs = component.getAttributes() || {}
    if (Object.prototype.hasOwnProperty.call(attrs, 'class') && !String(attrs.class || '').trim()) {
      const { class: _omitClass, ...rest } = attrs
      component.setAttributes?.(rest)
    }
  } catch {
    /* ignore */
  }
  const children = component.components?.()
  if (children && typeof children.forEach === 'function') {
    children.forEach((child) => removeEmptyClassAttrsInComponentTree(child))
  }
}

function getCanvasDomHtmlSnapshot(editor) {
  try {
    const doc = editor?.Canvas?.getDocument?.()
    const body = doc?.body
    if (!body) return null
    const clone = body.cloneNode(true)

    // Grapes 캔버스 내부 CSS 룰(#id { ... })을 해당 요소 인라인 style로 흡수
    // 코드 모달에서 .gjs-css-rules 컨테이너가 그대로 보이지 않도록 정리한다.
    const cssRuleHost = clone.querySelector('#gjs-css-rules') || clone.querySelector('.gjs-css-rules')
    const cssText = Array.from(cssRuleHost?.querySelectorAll?.('style') || [])
      .map((el) => el.textContent || '')
      .join('\n')
    const idRuleRe = /#([A-Za-z_][\w-]*)\s*\{([^}]*)\}/g
    let m
    while ((m = idRuleRe.exec(cssText)) !== null) {
      const id = m[1]
      const decl = String(m[2] || '').trim()
      if (!id || !decl) continue
      const target = clone.querySelector(`#${id}`)
      if (!target) continue
      const prev = (target.getAttribute('style') || '').trim()
      const next = prev ? `${prev.replace(/;?\s*$/, ';')} ${decl}` : decl
      target.setAttribute('style', next.trim())
    }

    // Grapes 런타임 보조 컨테이너 제거
    clone.querySelectorAll('.gjs-css-rules, #gjs-css-rules, .gjs-js-cont').forEach((el) => el.remove())

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
    const fromComps = getTopLevelComponentExportMarkupFromClone(editor, body, clone)
    if (fromComps != null) return stripSingleAutoEmptyPlaceholderHtml(fromComps)
    return stripSingleAutoEmptyPlaceholderHtml(clone.innerHTML || '')
  } catch {
    return null
  }
}

function getExportHtml(editor, headAssets, preservedIds) {
  if (!editor) return ''
  const domHtml = getCanvasDomHtmlSnapshot(editor)
  const raw = domHtml ?? getTopLevelComponentHtmlFromGetHtml(editor) ?? ''
  const sourceHtml = stripRuntimeStyleTagsFromHtml(raw)
  const normalizedInlineHtml = normalizeInlineSpansHtml(sourceHtml)
  const html = stripTemporaryIdsForExport(
    stripEmptyClassAttributes(convertImageLinkMetaToAnchors(normalizedInlineHtml)),
    preservedIds,
  )
  const htmlWithBody = /<body\b/i.test(html) ? html : `<body>\n${html}\n</body>`
  const head = composeHeadAssetsMarkup(sanitizeHeadAssets(headAssets || {}))
  return (head ? `${head}\n\n` : '') + htmlWithBody
}

function injectCanvasHeadAssets(editor, { links = [], css = '' }) {
  const safe = sanitizeHeadAssets({ links, css })
  const doc = editor.Canvas.getDocument()
  const head = doc?.head
  if (!head) return

  head.querySelectorAll('[data-be-head-asset="1"]').forEach((el) => el.remove())

  safe.links.forEach((tag) => {
    const tpl = doc.createElement('template')
    tpl.innerHTML = String(tag || '').trim()
    const el = tpl.content.firstElementChild
    if (el?.tagName === 'LINK') {
      el.setAttribute('data-be-head-asset', '1')
      head.appendChild(el)
    }
  })

  if (safe.css.trim()) {
    const styleEl = doc.createElement('style')
    styleEl.setAttribute('data-be-head-asset', '1')
    styleEl.textContent = safe.css
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

/**
 * 코드 모달 적용 시, 전체 문서(<html>/<body>)가 들어오면 body 내부만 컴포넌트로 사용한다.
 * GrapesJS setComponents()는 body 래퍼보다 body 내부 마크업이 안정적이다.
 */
function extractBodyHtmlIfDocument(html) {
  const src = String(html || '').trim()
  if (!src) return ''
  if (typeof DOMParser === 'undefined') return src
  const hasBodyOrHtmlTag = /<body\b|<html\b/i.test(src)
  if (!hasBodyOrHtmlTag) return src
  try {
    const doc = new DOMParser().parseFromString(src, 'text/html')
    const bodyInner = String(doc.body?.innerHTML || '').trim()
    return bodyInner || src
  } catch {
    return src
  }
}

function parseCodeModalSections(fullText) {
  const { css, links, html } = splitHeadAssetsAndHtml(fullText)
  const { htmlOnly, scriptsJoined } = splitHtmlAndScripts(html)
  return { css: css.trim(), links, htmlOnly, scriptsJoined }
}

function normalizeHtmlTabValue(htmlText) {
  const src = String(htmlText || '').trim()
  if (!src) return ''
  // 완전히 빈 body 래퍼는 HTML 탭에서 빈 문자열로 표시
  if (/^<body\b[^>]*>\s*<\/body>$/i.test(src)) return ''
  return htmlText
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
  const commonOptions = {
    printWidth: 80,
    tabWidth: 2,
    useTabs: false,
    semi: true,
    singleQuote: true,
    trailingComma: 'es5',
    bracketSpacing: true,
    arrowParens: 'always',
    endOfLine: 'lf',
    bracketSameLine: false,
    htmlWhitespaceSensitivity: 'css',
  }
  return prettier.format(String(text || ''), {
    parser: 'html',
    plugins: [htmlPl, postcssPl],
    ...commonOptions,
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
 * 캔버스 iframe 기준: 이 높이일 때 100vh == 1080px (vh 단위는 iframe 뷰포트 기준이라 고정 뷰포트로 맞춤)
 * 메인 window 높이는 사용하지 않는다.
 */
const EDITOR_CANVAS_100VH_PX = 1080

function convertVhUnitsToPxInText(text, basePx = EDITOR_CANVAS_100VH_PX) {
  return String(text || '').replace(/(-?\d*\.?\d+)vh\b/gi, (_, n) => {
    const num = Number(n)
    if (!Number.isFinite(num)) return _
    const px = (num * basePx) / 100
    const rounded = Math.round(px * 1000) / 1000
    return `${rounded}px`
  })
}

/**
 * 캔버스 반영 전, 인라인 style 속성의 vh 단위를 px(100vh=1080px)로 고정 변환
 */
function convertInlineStyleVhToPx(html, basePx = EDITOR_CANVAS_100VH_PX) {
  const src = String(html || '')
  if (!src.trim()) return ''
  if (typeof DOMParser === 'undefined') return src
  try {
    const parser = new DOMParser()
    const doc = parser.parseFromString(`<body>${src}</body>`, 'text/html')
    doc.body.querySelectorAll('[style]').forEach((el) => {
      const st = el.getAttribute('style')
      if (!st) return
      el.setAttribute('style', convertVhUnitsToPxInText(st, basePx))
    })
    return doc.body.innerHTML
  } catch {
    return src
  }
}

/**
 * 코드 모달 적용 시 인라인 이벤트 핸들러(onclick 등)를 제거해
 * 캔버스 편집 중 의도치 않은 페이지 이동/스크립트 실행을 막는다.
 */
function stripInlineEventHandlerAttrs(html) {
  const src = String(html || '')
  if (!src.trim()) return ''
  if (typeof DOMParser === 'undefined') return src
  try {
    const parser = new DOMParser()
    const doc = parser.parseFromString(`<body>${src}</body>`, 'text/html')
    doc.body.querySelectorAll('*').forEach((el) => {
      Array.from(el.attributes || []).forEach((attr) => {
        if (/^on/i.test(String(attr.name || ''))) el.removeAttribute(attr.name)
      })
    })
    return doc.body.innerHTML
  } catch {
    return src
  }
}

function releaseCanvasFramePx(editor) {
  try {
    const iframe = editor.Canvas.getFrameEl()
    if (!iframe) return
    iframe.style.height = 'auto'
    iframe.style.minHeight = '0px'
    const wrap = iframe.closest('.gjs-frame-wrapper')
    if (wrap) {
      wrap.style.height = 'auto'
      wrap.style.minHeight = '0px'
    }
  } catch {
    /* ignore */
  }
}

function measureCanvasContentHeightPx(editor, { min = 320 } = {}) {
  try {
    const wrapperEl = editor.getWrapper?.()?.getEl?.()
    let wrapperChildrenExtent = 0
    if (wrapperEl?.getBoundingClientRect) {
      const frameWin = editor.Canvas?.getWindow?.()
      const wrapRect = wrapperEl.getBoundingClientRect()
      const kids = Array.from(wrapperEl.children || [])
      if (kids.length) {
        kids.forEach((child) => {
          const r = child?.getBoundingClientRect?.()
          if (!r) return
          const cs = frameWin?.getComputedStyle?.(child)
          const marginBottom = Number.parseFloat(cs?.marginBottom || '0') || 0
          const childExtent = Math.round(r.bottom - wrapRect.top + marginBottom)
          wrapperChildrenExtent = Math.max(wrapperChildrenExtent, childExtent)
        })
      }
    }
    // 핵심: body/root 높이는 iframe viewport(이전 잠금값)에 끌려 커질 수 있어
    // "현재 블록 실제 콘텐츠" 기준인 wrapper 자식 extent를 우선한다.
    const byChildren = Math.round(Number(wrapperChildrenExtent) || 0)
    if (byChildren > 0) return Math.max(byChildren, min)

    // 자식 extent를 못 구하는 초기 타이밍에서만 wrapper 높이로 보완
    const byWrapper = Math.max(
      Math.round(Number(wrapperEl?.scrollHeight || 0)),
      Math.round(Number(wrapperEl?.offsetHeight || 0)),
    )
    return Math.max(byWrapper, min)
  } catch {
    return min
  }
}

/**
 * iframe/래퍼 높이를 잠긴 픽셀(px)로 맞춤.
 * lockRef.current 에 숫자가 있으면 편집 중에는 재측정 없이 유지하고,
 * 코드 보기에서 소스 적용 시에만 reset 으로 다시 잠급니다.
 */
function syncCanvasFrameHeight(editor, lockRef, { reset = false, vhBoost = false } = {}) {
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
    if (reset) releaseCanvasFramePx(editor)
    // vh 기반: 메인 window 대신 "100vh=1080px" 고정 뷰포트로 프로브
    // 그 외: iframe이 너무 작을 때 측정이 무너지지 않게 기존 범위로 프로브
    const probePx = vhBoost
      ? Math.max(320, Math.min(2000, EDITOR_CANVAS_100VH_PX))
      : Math.max(320, Math.min(1600, Math.round((window?.innerHeight || 900) * 0.95)))
    if (reset) applyCanvasFramePx(editor, probePx, { skipRefresh: true })
    const handles = { timeouts: [], rafs: [] }
    pendingFrameMeasureHandles.set(editor, handles)

    const measure = () => {
      try {
        if (!editor.Canvas?.getFrameEl()) return
        let h = measureCanvasContentHeightPx(editor, { min: 320 })
        if (vhBoost) h = Math.max(h, EDITOR_CANVAS_100VH_PX)
        lockRef.current = h
        applyCanvasFramePx(editor, h)
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
      toolbar: withImageReplaceToolbar(withComponentLinkToolbar(imageComponent.get?.('toolbar'))),
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

function resolveImageUploadEndpoint() {
  const env = import.meta?.env || {}
  const direct = String(env.VITE_IMAGE_UPLOAD_ENDPOINT || '').trim()
  if (direct) return direct
  const base = String(env.VITE_BACKEND_BASE_URL || '').trim().replace(/\/+$/, '')
  if (base) return `${base}/api/images/upload`
  return DEFAULT_IMAGE_UPLOAD_ENDPOINT
}

function isDataImageSrc(srcRaw) {
  return /^data:image\//i.test(String(srcRaw || '').trim())
}

function parseDataImageMeta(srcRaw) {
  const src = String(srcRaw || '').trim()
  const m = src.match(/^data:([^;,]+)?(?:;charset=[^;,]+)?(;base64)?,(.*)$/i)
  if (!m) return null
  return {
    mimeType: (m[1] || '').toLowerCase(),
    isBase64: !!m[2],
    payload: m[3] || '',
  }
}

function decodeDataImagePayload(srcRaw) {
  const meta = parseDataImageMeta(srcRaw)
  if (!meta) return null
  try {
    if (meta.isBase64) return atob(meta.payload)
    return decodeURIComponent(meta.payload)
  } catch {
    return null
  }
}

function isLikelyGrapesPlaceholderImageData(srcRaw) {
  const meta = parseDataImageMeta(srcRaw)
  if (!meta || meta.mimeType !== 'image/svg+xml') return false
  const decoded = decodeDataImagePayload(srcRaw)
  if (!decoded) return false
  const text = String(decoded).toLowerCase()
  // 드래그앤드롭 직후 GrapesJS가 넣는 임시 이미지(작은 svg 아이콘) 필터
  return decoded.length <= 2000 && text.includes('<svg') && (text.includes('<rect') || text.includes('<path'))
}

function dataUrlToFile(dataUrl, fallbackName = 'image-upload') {
  const m = String(dataUrl || '').match(/^data:([^;,]+)?(?:;charset=[^;,]+)?(;base64)?,(.*)$/i)
  if (!m) return null
  const mimeType = (m[1] || 'application/octet-stream').trim()
  const payload = m[3] || ''
  let bytes = null
  const isBase64 = !!m[2]
  try {
    if (isBase64) {
      const binary = atob(payload)
      bytes = new Uint8Array(binary.length)
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
    } else {
      const decoded = decodeURIComponent(payload)
      bytes = new TextEncoder().encode(decoded)
    }
  } catch {
    return null
  }
  const ext = mimeType.split('/')[1]?.replace(/[^a-z0-9]/gi, '') || 'bin'
  return new File([bytes], `${fallbackName}.${ext}`, { type: mimeType })
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    try {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result || ''))
      reader.onerror = () => reject(reader.error || new Error('파일을 data URL로 읽지 못했습니다.'))
      reader.readAsDataURL(file)
    } catch (err) {
      reject(err)
    }
  })
}

function fitImageWidthToParent(editor, component) {
  if (!editor || !isImgComponent(component)) return
  const attrs = component.getAttributes?.() || {}
  // 템플릿 이미지(클래스 지정)는 기존 CSS 레이아웃을 존중한다.
  if (String(attrs.class || '').trim()) return
  const currentStyle = component.getStyle?.() || {}
  // 이미 폭 정책이 있는 이미지는 보정하지 않음(템플릿/수동 삽입 보존)
  if (currentStyle.width || currentStyle['max-width']) return

  const apply = () => {
    const imageEl = component.getEl?.()
    const parentEl = component.parent?.()?.getEl?.()
    if (!imageEl || !parentEl?.getBoundingClientRect) return false
    const width = Math.round(parentEl.getBoundingClientRect().width || 0)
    if (!width) return false

    component.setStyle?.({
      ...currentStyle,
      width: `${width}px`,
      'max-width': '100%',
      height: 'auto',
    })

    const nextAttrs = component.getAttributes?.() || {}
    const { width: _w, height: _h, ...rest } = nextAttrs
    component.addAttributes?.(rest)
    notifyGrapesInputFromDomNode(editor, imageEl)
    return true
  }

  if (apply()) return
  ;[30, 120, 260].forEach((ms) => {
    setTimeout(() => {
      apply()
    }, ms)
  })
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
 * @param {{ initialHtml: string; blockLabel: string }} props
 */
export default function BlockEditor({ initialHtml, blockLabel }) {
  const containerRef = useRef(null)
  const shellRef = useRef(null)
  const editorRef = useRef(null)
  const savedRangeRef = useRef(null)
  const iframeKeydownRef = useRef(null)
  const headAssetsRef = useRef({ links: [], css: '' })
  const preservedExportIdsRef = useRef(new Set())
  /** 캔버스 iframe 고정 높이(px). 코드 보기 적용 시에만 재측정 */
  const canvasFrameLockRef = useRef(null)
  /** 코드 모달 setComponents 중 템플릿 이미지 자동 폭 보정을 잠시 비활성화 */
  const suppressImageAutoFitRef = useRef(false)
  /** 소스에 `vh` 포함 시: 캔버스에서 100vh == 1080px 기준(EDITOR_CANVAS_100VH_PX)으로 최소 높이 보강 */
  const canvasVhBoostRef = useRef(false)
  const codeOpenTextRef = useRef('')
  /** RTE 링크 버튼 → 상단과 동일한 링크 모달 (selection 은 savedRangeRef 에 저장) */
  const openRteLinkModalRef = useRef(() => {})
  /** 이미지 교체 모달 적용 대상 (선택이 바뀌어도 유지) */
  const imageReplaceTargetRef = useRef(null)
  /** 요소 툴바 링크 버튼 적용 대상 */
  const componentLinkTargetRef = useRef(null)
  /** data:image → 업로드 변환 중인 이미지 컴포넌트 중복 처리 방지 */
  const imageUploadInFlightRef = useRef(new WeakSet())
  const rteActiveRef = useRef(false)

  const [modalLink, setModalLink] = useState({ open: false, url: '', mode: 'rte' })
  const [modalImage, setModalImage] = useState({ open: false, url: '', mode: 'insert' })
  const [imageUploadBusy, setImageUploadBusy] = useState(false)
  const [modalVideo, setModalVideo] = useState({ open: false, url: '' })
  const [modalCode, setModalCode] = useState({ open: false, text: '' })
  const [codeModalDraft, setCodeModalDraft] = useState({
    css: '',
    links: [],
    htmlOnly: '',
    scriptsJoined: '',
  })
  /** 코드 모달: 전체 | HTML(스크립트 제외) | CSS | 스크립트 */
  const [codeModalTab, setCodeModalTab] = useState('all')
  const [codeModalLoading, setCodeModalLoading] = useState(false)
  const [codeEditorResetSeq, setCodeEditorResetSeq] = useState(0)
  const [codeApplyState, setCodeApplyState] = useState({
    status: 'idle', // idle | applying | failure
    message: '',
    details: '',
  })

  const anyModalOpen =
    modalLink.open || modalImage.open || modalVideo.open || modalCode.open
  const anyModalOpenRef = useRef(false)
  anyModalOpenRef.current = anyModalOpen

  const [, setImgToolbar] = useState(initialImgToolbarState)

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

  const uploadImageFileToServer = useCallback(async (file) => {
    if (!file) throw new Error('업로드할 파일이 없습니다.')
    const endpoint = resolveImageUploadEndpoint()
    const formData = new FormData()
    formData.append('file', file)

    const res = await fetch(endpoint, {
      method: 'POST',
      body: formData,
    })
    if (!res.ok) {
      let message = `이미지 업로드 실패 (${res.status})`
      try {
        const payload = await res.json()
        const detail = payload?.message
        if (Array.isArray(detail)) message = detail.join(', ')
        else if (typeof detail === 'string') message = detail
      } catch {
        /* ignore */
      }
      throw new Error(message)
    }

    const data = await res.json()
    const url = String(data?.url || '').trim()
    if (!url) throw new Error('업로드 응답에 url이 없습니다.')
    return url
  }, [])

  const uploadImageFilePreferServerWithFallback = useCallback(
    async (file) => {
      if (!file) throw new Error('업로드할 파일이 없습니다.')
      try {
        const uploaded = await uploadImageFileToServer(file)
        return { src: uploaded, via: 'server' }
      } catch (err) {
        console.warn('백엔드 업로드 실패 → data URL 폴백 사용:', err)
        const dataUrl = await fileToDataUrl(file)
        return { src: dataUrl, via: 'data-url' }
      }
    },
    [uploadImageFileToServer],
  )

  const normalizeImageSrcForCanvas = useCallback(
    async (srcRaw, fallbackName = 'block-editor-image') => {
      const src = String(srcRaw || '').trim()
      if (!isDataImageSrc(src)) return src
      const file = dataUrlToFile(src, fallbackName)
      if (!file) throw new Error('data URL을 파일로 변환하지 못했습니다.')
      try {
        return await uploadImageFileToServer(file)
      } catch (err) {
        // 서버가 꺼져 있거나 업로드 실패 시 기존 data URL을 유지해 편집 기능을 계속 사용한다.
        console.warn('data URL 서버 업로드 실패 → 원본 data URL 유지:', err)
        return src
      }
    },
    [uploadImageFileToServer],
  )

  const tryUploadImageComponentSrc = useCallback(
    (ed, cmp, reason = 'component') => {
      if (!ed || !cmp || !isImgComponent(cmp)) return
      const attrs = cmp.getAttributes?.() || {}
      const src = String(attrs.src || '').trim()
      if (!isDataImageSrc(src)) return
      if (isLikelyGrapesPlaceholderImageData(src)) return
      if (imageUploadInFlightRef.current.has(cmp)) return

      imageUploadInFlightRef.current.add(cmp)
      void (async () => {
        try {
          const uploadedUrl = await normalizeImageSrcForCanvas(src, 'drag-drop-image')
          applyImageSrcToComponent(ed, cmp, uploadedUrl)
        } catch (err) {
          console.error(`이미지 업로드 실패(${reason}):`, err)
        } finally {
          imageUploadInFlightRef.current.delete(cmp)
        }
      })()
    },
    [normalizeImageSrcForCanvas],
  )

  useEffect(() => {
    if (!containerRef.current) return undefined

    let editorLoaded = false
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
          {
            name: 'bold',
            icon: '<b>B</b>',
            attributes: { title: 'Bold' },
            event: 'mousedown',
            result() {
              execOnIframeSelection(editor, savedRangeRef, () => {
                toggleInlineTextStyle(editor, editor.Canvas.getDocument(), editor.Canvas.getWindow(), 'bold')
              })
            },
          },
          {
            name: 'italic',
            icon: '<i>I</i>',
            attributes: { title: 'Italic' },
            event: 'mousedown',
            result() {
              execOnIframeSelection(editor, savedRangeRef, () => {
                toggleInlineTextStyle(editor, editor.Canvas.getDocument(), editor.Canvas.getWindow(), 'italic')
              })
            },
          },
          {
            name: 'underline',
            icon: '<u>U</u>',
            attributes: { title: 'Underline' },
            event: 'mousedown',
            result() {
              execOnIframeSelection(editor, savedRangeRef, () => {
                toggleInlineTextStyle(editor, editor.Canvas.getDocument(), editor.Canvas.getWindow(), 'underline')
              })
            },
          },
          {
            name: 'strikethrough',
            icon: '<s>S</s>',
            attributes: { title: 'Strike-through' },
            event: 'mousedown',
            result() {
              execOnIframeSelection(editor, savedRangeRef, () => {
                toggleInlineTextStyle(editor, editor.Canvas.getDocument(), editor.Canvas.getWindow(), 'strike')
              })
            },
          },
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
        setModalLink({
          open: true,
          url: String(attrs.href || imgLink.href || ''),
          mode: 'component',
        })
      },
    })

    editor.Commands.add('custom:image-replace', {
      run(ed) {
        const sel = ed.getSelected()
        const target = getFirstImageChild(sel) || sel
        if (!isImgComponent(target)) return
        imageReplaceTargetRef.current = target
        const attrs = target.getAttributes?.() || {}
        const cur = attrs.src || ''
        setImageUploadBusy(false)
        setModalImage({ open: true, url: cur, mode: 'replace' })
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
      syncCanvasFrameHeight(editor, canvasFrameLockRef, { reset: false, vhBoost: canvasVhBoostRef.current })
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
    editor.on('canvas:update', () => removeEmptyClassAttrsInCanvas(editor))

    const parsedInitial = splitHeadAssetsAndHtml(initialHtml)
    const initialHtmlPx = convertInlineStyleVhToPx(parsedInitial.html, EDITOR_CANVAS_100VH_PX)
    const initialCssPx = convertVhUnitsToPxInText(parsedInitial.css, EDITOR_CANVAS_100VH_PX)
    headAssetsRef.current = sanitizeHeadAssets({ links: parsedInitial.links, css: initialCssPx })
    preservedExportIdsRef.current = collectIdsFromHtml(initialHtmlPx)
    canvasVhBoostRef.current = false
    editor.setComponents(initialHtmlPx)

    let removeRteToolbarCapture = null
    let removeImgScrollListener = null
    let disconnectEmptyClassObserver = null

    editor.on('load', () => {
      editorLoaded = true
      injectCanvasHeadAssets(editor, headAssetsRef.current)
      configureWrapper(editor)
      markEditableTree(editor.getWrapper())
      removeEmptyClassAttrsInComponentTree(editor.getWrapper())
      removeEmptyClassAttrsInCanvas(editor)
      try {
        const doc = editor.Canvas.getDocument()
        const body = doc?.body
        if (body && typeof MutationObserver !== 'undefined') {
          const observer = new MutationObserver((mutations) => {
            mutations.forEach((m) => {
              if (m.type === 'attributes') {
                const el = m.target
                if (el?.nodeType === 1 && m.attributeName === 'class') {
                  const classValue = el.getAttribute('class')
                  if (classValue == null || !String(classValue).trim()) el.removeAttribute('class')
                }
                return
              }
              m.addedNodes?.forEach?.((node) => {
                if (!node || node.nodeType !== 1) return
                const el = node
                if (el.hasAttribute?.('class')) {
                  const classValue = el.getAttribute('class')
                  if (classValue == null || !String(classValue).trim()) el.removeAttribute('class')
                }
                el.querySelectorAll?.('[class]')?.forEach?.((child) => {
                  const classValue = child.getAttribute('class')
                  if (classValue == null || !String(classValue).trim()) child.removeAttribute('class')
                })
              })
            })
          })
          observer.observe(body, {
            subtree: true,
            childList: true,
            attributes: true,
            attributeFilter: ['class'],
          })
          disconnectEmptyClassObserver = () => observer.disconnect()
        }
      } catch {
        disconnectEmptyClassObserver = null
      }
      syncCanvasFrameHeight(editor, canvasFrameLockRef, { reset: true, vhBoost: canvasVhBoostRef.current })
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
          const nextToolbar = isImgComponent(cmp)
            ? withImageReplaceToolbar(withComponentLinkToolbar(cmp.get?.('toolbar')))
            : withComponentLinkToolbar(cmp.get?.('toolbar'))
          cmp.set({
            toolbar: nextToolbar,
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
      removeEmptyClassAttrsInComponentTree(cmp || editor.getWrapper())
      removeEmptyClassAttrsInCanvas(editor)
      const ed = editorRef.current
      if (ed) tryUploadImageComponentSrc(ed, cmp, 'component:update')
      if (ed && cmp === ed.getSelected?.()) scheduleImgToolbar(cmp)
    })
    editor.on('component:add', (cmp) => {
      removeEmptyClassAttrsInComponentTree(cmp || editor.getWrapper())
      removeEmptyClassAttrsInCanvas(editor)
      if (suppressImageAutoFitRef.current) return
      if (!editorLoaded || !isImgComponent(cmp)) return
      tryUploadImageComponentSrc(editor, cmp, 'component:add')
      fitImageWidthToParent(editor, cmp)
    })
    editor.on('component:drag:end', (payload) => {
      removeEmptyClassAttrsInCanvas(editor)
      const ed = editorRef.current
      if (!ed) return
      const dragged = payload?.target || payload
      if (!isImgComponent(dragged)) return
      tryUploadImageComponentSrc(ed, dragged, 'component:drag:end')
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
            toggleInlineTextStyle(ed, ed.Canvas.getDocument(), ed.Canvas.getWindow(), 'bold')
          })
          return
        }
        if (k === 'i') {
          e.preventDefault()
          execOnIframeSelection(ed, savedRangeRef, () => {
            toggleInlineTextStyle(ed, ed.Canvas.getDocument(), ed.Canvas.getWindow(), 'italic')
          })
          return
        }
        if (k === 'u') {
          e.preventDefault()
          execOnIframeSelection(ed, savedRangeRef, () => {
            toggleInlineTextStyle(ed, ed.Canvas.getDocument(), ed.Canvas.getWindow(), 'underline')
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
      disconnectEmptyClassObserver?.()
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
  }, [refreshToolStyleFromSelection, initialHtml, tryUploadImageComponentSrc])

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
    const raw = getExportHtml(ed, headAssetsRef.current, preservedExportIdsRef.current)
    setCodeApplyState({ status: 'idle', message: '', details: '' })
    codeOpenTextRef.current = ''
    setCodeModalTab('all')
    setCodeModalLoading(true)
    setModalCode({ open: true, text: raw })
    setCodeModalDraft(parseCodeModalSections(raw))
    void (async () => {
      let next = raw
      try {
        next = await formatDocumentWithPrettier(raw)
      } catch (err) {
        console.error('코드 모달 자동 Prettier 실패:', err)
      }
      setModalCode((m) => (m.open ? { ...m, text: next } : m))
      setCodeModalDraft(parseCodeModalSections(next))
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
    setCodeModalDraft({ css: '', links: [], htmlOnly: '', scriptsJoined: '' })
    setCodeEditorResetSeq(0)
  }

  const formatCodeWithPrettier = async () => {
    try {
      const source = codeModalTab === 'all' ? modalCode.text : composeCodeModalSections(codeModalDraft)
      const formatted = await formatDocumentWithPrettier(source)
      setModalCode((m) => ({ ...m, text: formatted }))
      setCodeModalDraft(parseCodeModalSections(formatted))
      setCodeEditorResetSeq((n) => n + 1)
      // codeOpenTextRef 는 모달 최초 오픈 시점(자동 Prettier 완료) 문자열만 유지.
      // 여기서 갱신하면 적용 시 "변경 없음"으로 오판해 setComponents 가 스킵되는 버그가 난다.
    } catch (err) {
      console.error('Prettier 실패:', err)
    }
  }

  const codeEditorPane = useMemo(() => {
    switch (codeModalTab) {
      case 'html':
        return { value: normalizeHtmlTabValue(codeModalDraft.htmlOnly), language: 'html' }
      case 'style':
        return { value: codeModalDraft.css, language: 'css' }
      case 'script':
        return { value: codeModalDraft.scriptsJoined, language: 'html' }
      default:
        return { value: modalCode.text, language: 'html' }
    }
  }, [codeModalTab, codeModalDraft, modalCode.text])

  const onCodeEditorChange = useCallback(
    (v) => {
      const val = v ?? ''
      if (codeModalTab === 'all') {
        setModalCode((m) => ({ ...m, text: val }))
        return
      }
      if (codeModalTab === 'html') {
        setCodeModalDraft((prev) => ({ ...prev, htmlOnly: val }))
      } else if (codeModalTab === 'style') {
        setCodeModalDraft((prev) => ({ ...prev, css: val }))
      } else if (codeModalTab === 'script') {
        setCodeModalDraft((prev) => ({ ...prev, scriptsJoined: val }))
      }
    },
    [codeModalTab],
  )

  const switchCodeModalTab = useCallback(
    (nextTab) => {
      if (nextTab === codeModalTab) return
      if (nextTab === 'all') {
        const merged = composeCodeModalSections(codeModalDraft)
        setModalCode((m) => (m.text === merged ? m : { ...m, text: merged }))
      } else if (codeModalTab === 'all') {
        // 전체 탭 편집본을 분리 탭 draft로 1회 동기화
        setCodeModalDraft(parseCodeModalSections(modalCode.text))
      }
      setCodeModalTab(nextTab)
    },
    [codeModalDraft, codeModalTab, modalCode.text],
  )

  const applyCodeModal = () => {
    const ed = editorRef.current
    if (!ed) return
    if (codeModalLoading) return
    const workingText = codeModalTab === 'all' ? modalCode.text : composeCodeModalSections(codeModalDraft)
    setCodeApplyState({ status: 'applying', message: '코드를 적용하는 중입니다...', details: '' })
    if (workingText.trim() === codeOpenTextRef.current.trim()) {
      closeCodeModal()
      return
    }
    const { links, css, html } = splitHeadAssetsAndHtml(workingText)
    const bodyHtml = stripInlineEventHandlerAttrs(
      convertInlineStyleVhToPx(extractBodyHtmlIfDocument(html), EDITOR_CANVAS_100VH_PX),
    )
    const cssPx = convertVhUnitsToPxInText(css, EDITOR_CANVAS_100VH_PX)
    const nextHtml = convertAnchoredImagesToLinkMeta(bodyHtml).trim()
    mergeIdSet(preservedExportIdsRef.current, collectIdsFromHtml(bodyHtml))
    canvasVhBoostRef.current = false

    try {
      // HTML을 완전히 비운 경우도 정상 시나리오로 허용하여 캔버스를 빈 상태로 만든다.
      suppressImageAutoFitRef.current = true
      ed.setComponents(nextHtml)
    } catch (err) {
      suppressImageAutoFitRef.current = false
      console.error('코드 적용 실패(setComponents):', err)
      setCodeApplyState({
        status: 'failure',
        message: 'HTML 적용에 실패했습니다. 태그 구조를 확인해 주세요.',
        details: String(err?.message || err || ''),
      })
      return
    }

    headAssetsRef.current = sanitizeHeadAssets({ links, css: cssPx })
    injectCanvasHeadAssets(ed, headAssetsRef.current)
    removeEmptyClassAttrsInCanvas(ed)

    try {
      configureWrapper(ed)
      markEditableTree(ed.getWrapper())
      removeEmptyClassAttrsInComponentTree(ed.getWrapper())
      removeEmptyClassAttrsInCanvas(ed)
      ed.getModel().getCurrentFrameModel()?.set({ height: 'auto', minHeight: '200px' })
      syncCanvasFrameHeight(ed, canvasFrameLockRef, { reset: true, vhBoost: canvasVhBoostRef.current })
      ed.refresh?.()
      suppressImageAutoFitRef.current = false
    } catch (err) {
      suppressImageAutoFitRef.current = false
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
    const exported = getExportHtml(ed, headAssetsRef.current, preservedExportIdsRef.current)
    console.log(exported)
    console.log('저장이 완료되었습니다!')
  }

  return (
    <div className="be-root" ref={shellRef}>
      <div className="be-meta">
        {blockLabel} — 편집 영역
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
              setImageUploadBusy(false)
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
                onChange={async (e) => {
                  const f = e.target.files?.[0]
                  if (!f) return
                  setImageUploadBusy(true)
                  try {
                    const { src } = await uploadImageFilePreferServerWithFallback(f)
                    setModalImage((m) => ({ ...m, url: src }))
                  } catch (err) {
                    console.error('이미지 입력 처리 실패:', err)
                  } finally {
                    setImageUploadBusy(false)
                    e.target.value = ''
                  }
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
                  setImageUploadBusy(false)
                  setModalImage({ open: false, url: '', mode: 'insert' })
                }}
              >
                취소
              </button>
              <button
                type="button"
                className="be-btn be-btn-primary"
                disabled={imageUploadBusy}
                onClick={async () => {
                  const ed = editorRef.current
                  let src = modalImage.url.trim()
                  if (!ed || !src) return
                  setImageUploadBusy(true)
                  try {
                    src = await normalizeImageSrcForCanvas(src, 'modal-image')
                  } catch (err) {
                    console.error('이미지 업로드 실패:', err)
                    setImageUploadBusy(false)
                    return
                  }
                  const mode = modalImage.mode || 'insert'
                  if (mode === 'replace') {
                    applyImageSrcToComponent(ed, imageReplaceTargetRef.current, src)
                    imageReplaceTargetRef.current = null
                  } else {
                    insertHtmlIntoBlock(
                      ed,
                      `<img src="${src.replace(/"/g, '&quot;')}" alt="" style="max-width:100%;height:auto;"/>`,
                    )
                  }
                  setImageUploadBusy(false)
                  setModalImage({ open: false, url: '', mode: 'insert' })
                }}
              >
                {imageUploadBusy
                  ? '업로드 중...'
                  : modalImage.mode === 'replace'
                    ? '교체 적용'
                    : '이미지 삽입'}
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
            <p className="be-code-modal__desc">블록 내보내기 HTML을 편집합니다. 적용하면 편집 상태가 적용됩니다.</p>
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
                  onClick={() => switchCodeModalTab(t.id)}
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
                  key={`${codeModalTab}:${codeEditorResetSeq}`}
                  height="480px"
                  language={codeEditorPane.language}
                  theme="vs-dark"
                  defaultValue={codeEditorPane.value}
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
