import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Draft } from './Draft'
import '../styles.css'
import './nba.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Draft />
  </StrictMode>,
)
