import { createRoot } from 'react-dom/client'
import '@fontsource/ibm-plex-sans/latin-400.css'
import '@fontsource/ibm-plex-sans/latin-500.css'
import '@fontsource/ibm-plex-sans/latin-600.css'
import App from './App'
import EmailRecovery from './components/EmailRecovery'
import './styles.css'

createRoot(document.getElementById('root')!).render(window.location.pathname === '/recover-pin' ? <EmailRecovery /> : <App />)
