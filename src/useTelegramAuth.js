/**
 * useTelegramAuth — authentication hook.
 *
 * Supports two auth flows:
 * 1. Telegram Mini App: validates initData with server, gets signed authToken
 * 2. Web login: reads saved authToken from localStorage (set by magic link or Mini App flow)
 *
 * Returns { authorized, loading, user, error, authToken }.
 * authToken is an HMAC-signed token that must be sent with all API requests.
 */
import { useState, useEffect, useRef } from 'react';

const SERVER_URL = 'https://whiteboard-production-ec19.up.railway.app';

export default function useTelegramAuth() {
  const [state, setState] = useState({ authorized: false, loading: true, user: null, error: null, authToken: null });
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;

    // Check 1: localStorage (web login via Telegram bot magic link or previous Mini App session)
    try {
      const saved = localStorage.getItem('catego-user');
      const savedToken = localStorage.getItem('catego-auth-token');
      if (saved && savedToken) {
        const user = JSON.parse(saved);
        if (user && user.username) {
          setState({ authorized: true, loading: false, user, error: null, authToken: savedToken });
          return;
        }
      }
    } catch {
      // Corrupted localStorage, continue to other auth methods
    }

    // Check 2: Telegram Mini App (only if actually opened inside Telegram)
    const tg = window.Telegram?.WebApp;
    const initData = tg?.initData;
    if (!tg || !initData) {
      // Not in Telegram and not logged in via web → show login page
      setState({ authorized: false, loading: false, user: null, error: 'not_authenticated', authToken: null });
      return;
    }

    tg.ready();
    tg.expand();

    fetch(`${SERVER_URL}/api/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ initData }),
    })
      .then((res) => res.json())
      .then((data) => {
        if (data.ok) {
          localStorage.setItem('catego-user', JSON.stringify(data.user));
          if (data.authToken) {
            localStorage.setItem('catego-auth-token', data.authToken);
          }
          setState({ authorized: true, loading: false, user: data.user, error: null, authToken: data.authToken || null });
        } else {
          setState({ authorized: false, loading: false, user: null, error: data.error || 'Auth failed', authToken: null });
        }
      })
      .catch((err) => {
        setState({ authorized: false, loading: false, user: null, error: err.message || 'Network error', authToken: null });
      });
  }, []);

  return state;
}
