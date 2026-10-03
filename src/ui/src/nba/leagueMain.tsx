import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { League } from './League'
import '../styles.css'
import '../cockpit.css'
import './league.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <League />
  </StrictMode>,
)
