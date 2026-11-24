import React from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import { AppView } from './App.js';

const rootEl = document.getElementById('root');
if (rootEl) {
  createRoot(rootEl).render(
    <React.StrictMode>
      <AppView />
    </React.StrictMode>,
  );
}
