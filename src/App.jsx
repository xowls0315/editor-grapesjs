import './App.css'
import BlockEditor from './components/BlockEditor.jsx'
import salonBlockHtml from './block/salon.html?raw'
import studioBlockHtml from './block/studio.html?raw'

function App() {
  return (
    <div className="app-block-stack">
      <BlockEditor
        initialHtml={salonBlockHtml}
        blockLabel="블록 1 — Salon story"
        sourcePath="src/block/salon.html"
      />
      <BlockEditor
        initialHtml={studioBlockHtml}
        blockLabel="블록 2 — Studio"
        sourcePath="src/block/studio.html"
      />
    </div>
  )
}

export default App
