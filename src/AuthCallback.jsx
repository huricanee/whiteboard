/**
 * AuthCallback — handles /auth/:token magic link from Telegram bot.
 *
 * Flow: user clicks link in bot → lands here → we verify token with server →
 * save user to localStorage → redirect to main app.
 */
import { useState, useEffect, useRef } from 'react';

const SERVER_URL = 'https://whiteboard-production-ec19.up.railway.app';

export default function AuthCallback({ token }) {
  const [status, setStatus] = useState('verifying');
  const [error, setError] = useState(null);
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;

    fetch(`${SERVER_URL}/api/auth/verify/${token}`)
      .then((res) => res.json())
      .then((data) => {
        if (data.ok && data.user) {
          // Save user + signed auth token to localStorage
          localStorage.setItem('catego-user', JSON.stringify(data.user));
          if (data.authToken) {
            localStorage.setItem('catego-auth-token', data.authToken);
          }
          setStatus('success');
          // Redirect to main app after a brief moment
          setTimeout(() => {
            window.location.href = '/';
          }, 1500);
        } else {
          setStatus('error');
          setError(data.error || 'Token is invalid or expired');
        }
      })
      .catch((err) => {
        setStatus('error');
        setError(err.message || 'Network error');
      });
  }, [token]);

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
    }}>
      {status === 'verifying' && (
        <>
          <div style={{ fontSize: '2rem', marginBottom: '1rem' }}>Logging in...</div>
          <div style={{ color: '#888' }}>Verifying your Telegram account</div>
        </>
      )}
      {status === 'success' && (
        <>
          <div style={{ fontSize: '2rem', marginBottom: '1rem', color: '#69db7c' }}>Logged in!</div>
          <div style={{ color: '#888' }}>Redirecting to Catego...</div>
        </>
      )}
      {status === 'error' && (
        <>
          <div style={{ fontSize: '2rem', marginBottom: '1rem', color: '#ff6b6b' }}>Login failed</div>
          <div style={{ color: '#888', marginBottom: '1.5rem' }}>{error}</div>
          <a
            href="/"
            style={{
              padding: '0.75rem 1.5rem',
              background: '#6c8cff',
              color: 'white',
              borderRadius: '8px',
              textDecoration: 'none',
            }}
          >
            Back to Catego
          </a>
        </>
      )}
    </div>
  );
}
