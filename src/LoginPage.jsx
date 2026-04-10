/**
 * LoginPage — shown when user is not authenticated (outside Telegram).
 *
 * "Log in with Telegram" button → creates auth token → opens bot deep link.
 * Then polls for confirmation. Once bot confirms, redirects to main app.
 */
import { useState, useRef, useEffect } from 'react';

const SERVER_URL = 'https://whiteboard-production-ec19.up.railway.app';

export default function LoginPage() {
  const [state, setState] = useState('idle'); // idle | waiting | error
  const [botLink, setBotLink] = useState(null);
  const [error, setError] = useState(null);
  const pollRef = useRef(null);

  // Cleanup polling on unmount
  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  async function handleLogin() {
    setState('waiting');
    setError(null);

    try {
      const res = await fetch(`${SERVER_URL}/api/auth/init`, { method: 'POST' });
      const data = await res.json();
      if (!data.token || !data.botLink) {
        setState('error');
        setError('Server error, try again');
        return;
      }

      setBotLink(data.botLink);

      // Open bot in new tab
      window.open(data.botLink, '_blank');

      // Poll for confirmation
      let attempts = 0;
      const maxAttempts = 150; // 5 minutes at 2s interval
      pollRef.current = setInterval(async () => {
        attempts++;
        if (attempts > maxAttempts) {
          clearInterval(pollRef.current);
          setState('error');
          setError('Login timed out. Try again.');
          return;
        }
        try {
          const statusRes = await fetch(`${SERVER_URL}/api/auth/status/${data.token}`);
          const statusData = await statusRes.json();
          if (statusData.status === 'confirmed' || statusData.status === 'used') {
            clearInterval(pollRef.current);
            // Redirect to magic link to complete auth (gets signed authToken)
            window.location.href = `/auth/${data.token}`;
          } else if (statusData.status === 'expired') {
            clearInterval(pollRef.current);
            setState('error');
            setError('Login expired. Try again.');
          }
        } catch {
          // Network error during poll — just retry
        }
      }, 2000);
    } catch (err) {
      setState('error');
      setError(err.message || 'Network error');
    }
  }

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      height: '100vh',
      background: '#1a1a2e',
      color: '#e0e0e0',
      fontFamily: 'system-ui, sans-serif',
      gap: '1.5rem',
    }}>
      <div style={{ fontSize: '2.5rem', fontWeight: 700 }}>Catego</div>
      <div style={{ color: '#888', maxWidth: '300px', textAlign: 'center' }}>
        Collaborative boards for your group
      </div>

      {state === 'idle' && (
        <button
          onClick={handleLogin}
          style={{
            padding: '0.875rem 2rem',
            fontSize: '1.1rem',
            background: '#0088cc',
            color: 'white',
            border: 'none',
            borderRadius: '12px',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: '0.5rem',
            fontWeight: 600,
          }}
        >
          Log in with Telegram
        </button>
      )}

      {state === 'waiting' && (
        <>
          <div style={{ fontSize: '1.2rem' }}>Waiting for confirmation...</div>
          <div style={{ color: '#888', textAlign: 'center', maxWidth: '320px' }}>
            Confirm login in Telegram, then click the link the bot sends you.
          </div>
          {botLink && (
            <a
              href={botLink}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                color: '#4dabf7',
                textDecoration: 'underline',
              }}
            >
              Open bot again
            </a>
          )}
        </>
      )}

      {state === 'error' && (
        <>
          <div style={{ color: '#ff6b6b' }}>{error}</div>
          <button
            onClick={() => { setState('idle'); setError(null); }}
            style={{
              padding: '0.75rem 1.5rem',
              background: '#6c8cff',
              color: 'white',
              border: 'none',
              borderRadius: '8px',
              cursor: 'pointer',
            }}
          >
            Try again
          </button>
        </>
      )}
    </div>
  );
}
