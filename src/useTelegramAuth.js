/**
 * useTelegramAuth — Telegram Mini App authentication hook.
 *
 * Checks if running inside Telegram WebApp, validates initData with the server,
 * and returns auth state.
 */
import { useState, useEffect, useRef } from 'react';

const SERVER_URL = 'https://whiteboard-production-ec19.up.railway.app';

export default function useTelegramAuth() {
  const [state, setState] = useState({ authorized: false, loading: true, user: null, error: null });
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;

    // Check 1: localStorage (web login via Telegram bot magic link)
    try {
      const saved = localStorage.getItem('whiteboard-user');
      if (saved) {
        const user = JSON.parse(saved);
        if (user && user.username) {
          setState({ authorized: true, loading: false, user, error: null });
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
      setState({ authorized: false, loading: false, user: null, error: 'not_authenticated' });
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
          // Also save to localStorage so web login works on refresh
          localStorage.setItem('whiteboard-user', JSON.stringify(data.user));
          setState({ authorized: true, loading: false, user: data.user, error: null });
        } else {
          setState({ authorized: false, loading: false, user: null, error: data.error || 'Auth failed' });
        }
      })
      .catch((err) => {
        setState({ authorized: false, loading: false, user: null, error: err.message || 'Network error' });
      });
  }, []);

  return { ...state, initData: window.Telegram?.WebApp?.initData || null };
}
