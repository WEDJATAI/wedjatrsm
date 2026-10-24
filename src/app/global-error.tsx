'use client'

// r70 audit hardening: root error boundary. An uncaught render/commit error
// (e.g. the timing-dependent removeChild DOM race observed when an overlay
// closes while a background refetch lands) used to blank the whole app with
// NO recovery path for the staff on shift. This boundary gives every crash
// a one-tap recovery instead of a white screen. It must render its own
// <html>/<body> (Next.js global-error contract) and stay dependency-free
// so it can never itself fail to load.
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  return (
    <html lang="en" dir="ltr">
      <body
        style={{
          margin: 0,
          minHeight: '100dvh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#f7f5f4',
          color: '#1f1b1e',
          fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
          padding: '24px',
        }}
      >
        <main
          role="alert"
          style={{
            maxWidth: '420px',
            width: '100%',
            textAlign: 'center',
            borderRadius: '16px',
            border: '1px solid #e4dedb',
            background: '#fff',
            padding: '32px 24px',
            boxShadow: '0 8px 24px rgba(31, 27, 30, 0.06)',
          }}
        >
          <div
            aria-hidden
            style={{
              width: '48px',
              height: '48px',
              margin: '0 auto 16px',
              borderRadius: '50%',
              background: '#fde8e8',
              color: '#b4232a',
              fontSize: '24px',
              lineHeight: '48px',
            }}
          >
            !
          </div>
          <h1 style={{ margin: '0 0 8px', fontSize: '20px', fontWeight: 700 }}>
            Something went wrong
          </h1>
          <p style={{ margin: '0 0 20px', fontSize: '14px', color: '#5f5661', lineHeight: 1.5 }}>
            The screen hit an unexpected error. Your data is safe — orders,
            payments and the sync engine run on the server. Reload to get
            back to work.
          </p>
          <button
            onClick={reset}
            autoFocus
            style={{
              height: '44px',
              padding: '0 24px',
              borderRadius: '12px',
              border: 'none',
              background: '#714B67',
              color: '#fff',
              fontSize: '15px',
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            Reload the app
          </button>
          {error.digest ? (
            <p style={{ margin: '16px 0 0', fontSize: '11px', color: '#a39ca8' }}>
              Reference: {error.digest}
            </p>
          ) : null}
        </main>
      </body>
    </html>
  )
}
