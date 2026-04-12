import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import AuthCallback from './AuthCallback.jsx'
import ViewBoard from './ViewBoard.jsx'

// Simple path-based routing (no router library needed)
const path = window.location.pathname;
const authMatch = path.match(/^\/auth\/([a-zA-Z0-9_-]+)$/);
const viewMatch = path.match(/^\/view\/([a-zA-Z0-9_-]+)$/);

createRoot(document.getElementById('root')).render(
  <StrictMode>
    {viewMatch ? <ViewBoard token={viewMatch[1]} />
     : authMatch ? <AuthCallback token={authMatch[1]} />
     : <App />}
  </StrictMode>,
)
