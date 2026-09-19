import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { PublicServices } from './auth';
import './styles.css';
import './pog-interface.css';
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <PublicServices>
        <App />
      </PublicServices>
    </BrowserRouter>
  </React.StrictMode>,
);
