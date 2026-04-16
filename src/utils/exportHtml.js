/**
 * GrapesJS에서보낼 때 HTML + CSS를 하나의 문자열로 합칩니다.
 * 원본에 있던 <link> 등은 코드 보기에서 유지·편집하는 것을 권장합니다.
 */
export function getExportHtml(editor) {
  if (!editor) return ''
  const css = editor.getCss({ avoidProtected: true })
  const html = editor.getHtml()
  const styleBlock = css?.trim() ? `<style>\n${css}\n</style>\n` : ''
  return `${styleBlock}${html}`
}
