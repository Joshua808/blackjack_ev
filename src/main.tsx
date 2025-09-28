import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'

console.log('boot ok')
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
