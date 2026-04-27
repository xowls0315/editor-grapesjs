import './App.css'
import BlockEditor from './components/BlockEditor.jsx'

function App() {
  return (
    <div className="app-block-stack">
      <BlockEditor
        initialHtml=""
        blockLabel="블록 1"
      />
      <BlockEditor
        initialHtml=""
        blockLabel="블록 2"
      />
    </div>
  )
}

export default App
