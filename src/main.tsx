import React from 'react';
import ReactDOM from 'react-dom/client';
import { ClerkProvider } from '@clerk/react';
import App from './App';
import './styles.css';

const publishableKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;

if (!publishableKey) {
  throw new Error('Missing VITE_CLERK_PUBLISHABLE_KEY. Add it to .env.local before starting Zulu Casino.');
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ClerkProvider publishableKey={publishableKey} afterSignOutUrl="/">
      <App />
    </ClerkProvider>
  </React.StrictMode>,
);
