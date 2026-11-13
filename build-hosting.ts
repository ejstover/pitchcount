import type { Plugin } from 'vite'

/** Portable headers for a CDN host that supports the _headers convention. */
export function hostingHeaders(): Plugin {
  let connection = "'self'"
  return {
    name: 'pitchwork-hosting-headers',
    configResolved(config) {
      const value = config.env.VITE_SUPABASE_URL
      if (typeof value === 'string') {
        try {
          const url = new URL(value)
          if (url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) {
            connection += ` ${url.origin} ${url.protocol === 'https:' ? 'wss:' : 'ws:'}//${url.host}`
          }
        } catch { /* An unconfigured build has no external connection grant. */ }
      }
    },
    generateBundle() {
      const policy = `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data: blob:; connect-src ${connection}; worker-src 'self' blob:; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'`
      this.emitFile({type:'asset',fileName:'_headers',source:[
        '/*',
        `  Content-Security-Policy: ${policy}`,
        '  X-Content-Type-Options: nosniff',
        '  Referrer-Policy: no-referrer',
        '  Permissions-Policy: camera=(), microphone=(), geolocation=()',
        '  Cross-Origin-Opener-Policy: same-origin',
        '  Strict-Transport-Security: max-age=31536000',
        '/',
        '  Cache-Control: no-cache',
        '/index.html',
        '  Cache-Control: no-cache',
        '/assets/*',
        '  Cache-Control: public, max-age=31536000, immutable',
        '/sw.js',
        '  Cache-Control: no-cache',
        '/manifest.webmanifest',
        '  Cache-Control: no-cache',
        '',
      ].join('\n')})
      // Static requests bypass Functions; only this public account endpoint
      // needs verified ingress. Pages reads this file from the build output.
      this.emitFile({type:'asset',fileName:'_routes.json',source:JSON.stringify({version:1,include:['/api/accounts'],exclude:[]})})
    },
  }
}
