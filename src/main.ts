/**
 * Absurd Money Application Entry Point
 *
 * A double-entry personal finance app built on the end-to-end encrypted
 * reeeductio Spaces API. Balances and reports are computed on the device.
 */

// Import global styles
import './styles/global.css';

// Import components
import './components/money-app.js';

// Register service worker for offline support
import { registerSW } from 'virtual:pwa-register';
registerSW({ immediate: true });
