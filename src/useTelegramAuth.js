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

    const tg = window.Telegram?.WebApp;
    if (!tg) {
      setState({ authorized: false, loading: false, user: null, error: 'Open this whiteboard from Telegram' });
      return;
    }

    tg.ready();
    tg.expand();

    const initData = tg.initData;
    if (!initData) {
      setState({ authorized: false, loading: false, user: null, error: 'No Telegram init data' });
      return;
    }

    fetch(`${SERVER_URL}/api/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ initData }),
    })
      .then((res) => res.json())
      .then((data) => {
        if (data.ok) {
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
