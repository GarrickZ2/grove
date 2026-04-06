import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import { RadioPage } from './components/Radio'
import { extractRadioTokenFromUrl, setRadioToken } from './api/client'

// Extract token from hash before rendering (e.g. /#token=xxx)
const token = extractRadioTokenFromUrl();
if (token) {
  setRadioToken(token);
  window.history.replaceState(null, "", window.location.pathname);
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RadioPage />
  </StrictMode>,
)
