# editor-grapesjs

React + GrapesJS 기반 블록 에디터 프로젝트입니다.  
사용자는 템플릿 블록을 시각적으로 편집하고, 코드 모달에서 HTML/CSS를 직접 수정한 뒤, 최종 내보내기 코드를 얻을 수 있습니다.

## GrapesJS란?

GrapesJS는 웹 페이지/블록을 드래그앤드롭 방식으로 편집할 수 있는 오픈소스 WYSIWYG 에디터 프레임워크입니다.

- 컴포넌트 트리(요소 구조)와 캔버스(iframe) 기반 편집 모델 제공
- 선택, 이동, 리사이즈, 툴바/커맨드 등 편집기 기본 UX 제공
- HTML/CSS 직렬화 API 제공(`getHtml`, `setComponents`, 모델 이벤트 등)

이 프로젝트는 GrapesJS를 "기본 편집 엔진"으로 사용하고, 실제 서비스 요구사항에 맞춰 대규모 커스텀 레이어를 얹은 구조입니다.

## 실행 방법

```bash
npm install
npm run dev
```

빌드:

```bash
npm run build
```

## 프로젝트 기술 스택

- **Frontend Framework**: `React 19`
- **Build Tool**: `Vite`
- **Visual Editor Core**: `GrapesJS`
- **Code Editor (Modal)**: `Monaco Editor` (`@monaco-editor/react`)
- **CSS/HTML 후처리**: `PostCSS`
- **코드 포맷팅**: `Prettier` (standalone + html/postcss plugin)
- **언어/문법**: `JavaScript (ESM)`, `JSX`
- **패키지 매니저**: `npm`

연동 백엔드(별도 프로젝트):

- `NestJS (TypeScript)` + `Supabase (Storage + Postgres)`

## GrapesJS 라이브러리에서 주로 활용한 부분

아래는 라이브러리 기본 능력을 그대로/주로 활용한 영역입니다.

- `grapesjs.init(...)` 기반 에디터/캔버스 생성
- 컴포넌트 선택/이동/삭제/복사/붙여넣기 (`core:*` 커맨드 포함)
- RichTextEditor 툴바 확장 포인트 사용
- `DomComponents` 타입 확장(이미지 동작 커스터마이즈 기반)
- `setComponents`, `getWrapper`, `getModel`, `Canvas` API로 렌더/동기화
- 이벤트 훅(`load`, `component:add`, `component:update`, `component:drag:end`, `canvas:update`) 기반 후처리

## 커스텀 개발한 핵심 기능

아래는 서비스 요구사항에 맞춰 직접 구현한 영역입니다.

- **코드 모달 파이프라인**
  - 전체/HTML/CSS/스크립트 탭 분리 편집
  - Prettier 포맷팅 적용
  - full HTML 입력 시 `body`만 추출하여 적용
  - GrapesJS 런타임 산출물(`.gjs-*`, 임시 wrapper/ID, 빈 class 등) 필터링
  - 내보내기 시 `<body>` 포함 정규화

- **이미지 편집 UX**
  - 이미지 전용 툴바(이미지 교체/링크 설정) 구현
  - GrapesJS 기본 더블클릭 Select Image 모달 비활성화
  - 이미지 링크를 편집 중에는 메타 속성으로 유지하고, 내보내기 시 `<a><img/></a>`로 안전 변환
  - 드래그앤드롭/삽입/교체 경로에서 서버 업로드 연동 및 실패 시 data URL 폴백

- **텍스트 서식 엔진 커스터마이즈**
  - Bold/Italic/Underline/Strike/font-size를 단일 span 스타일 중심으로 제어
  - 부분 선택 시 조상 span 분할 로직으로 서식 오염/연쇄 적용 방지
  - 짧은 선택 반복 편집에서 중첩 span 정리(normalize)

- **HTML 정리/정규화**
  - 빈 span 제거, 인접 동일 스타일 span 병합
  - 기본값 스타일(`font-style: normal` 등) 제거
  - 코드 모달/내보내기 단계에서 가독성 높은 결과 유지

- **캔버스 높이/레이아웃 안정화**
  - 콘텐츠 실측 기반 iframe 높이 동기화
  - `vh` 단위를 캔버스 기준 픽셀로 변환(100vh = 1080px 기준)
  - 마지막 요소 `margin-bottom`까지 높이 계산에 반영해 하단 잘림 방지

- **보안/안정성 보강**
  - 코드 적용 시 `onclick` 등 inline 이벤트 속성 제거
  - 런타임 DOM/모델의 빈 `class=""` 지속 정리
  - 임시 ID와 사용자 정의 ID를 분리 관리해 내보내기 품질 보장

## 백엔드 연동

이미지 업로드는 `editor-grapesjs-backend`(NestJS + Supabase)와 연동됩니다.

- 서버 정상 시: Supabase public URL로 `img src` 저장
- 서버 미가동/실패 시: 기존 `data:image/...` 방식으로 자동 폴백

## 프로젝트 성격 요약

이 프로젝트는 "GrapesJS 기본 에디터"를 넘어,  
코드 품질/내보내기 일관성/실서비스 UX 요구사항을 반영한 커스텀 블록 에디터 구현체입니다.
