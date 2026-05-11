// Cloudflare Worker — Google OAuth 토큰 교환 프록시
// client_secret 을 Worker Secret 에 보관 → 브라우저에서 즉시 토큰 교환
//
// 설정:
// 1. Cloudflare 대시보드 → Workers & Pages → Create Worker
// 2. 이 파일 내용을 그대로 붙여넣고 배포
// 3. Worker 의 Settings → Variables → "Secret" 에 추가:
//    - GOOGLE_CLIENT_ID    (예: 524858649664-...apps.googleusercontent.com)
//    - GOOGLE_CLIENT_SECRET
// 4. Worker URL 복사 (예: https://oauth-proxy.your-name.workers.dev)
// 5. firebase-init.js 의 GOOGLE_OAUTH.proxyUrl 에 URL 입력

const ALLOWED_ORIGIN = 'https://crawler-10edc.web.app';

export default {
  async fetch(request, env) {
    // CORS preflight
    if (request.method === 'OPTIONS') {
      return cors(new Response(null, { status: 204 }));
    }

    if (request.method !== 'POST') {
      return cors(json({ error: 'method_not_allowed' }, 405));
    }

    let payload;
    try {
      payload = await request.json();
    } catch {
      return cors(json({ error: 'invalid_json' }, 400));
    }

    const { code, redirect_uri } = payload || {};
    if (!code || !redirect_uri) {
      return cors(json({ error: 'missing_params' }, 400));
    }

    // 보안: redirect_uri 가 우리 도메인이어야 함
    if (!redirect_uri.startsWith(ALLOWED_ORIGIN)) {
      return cors(json({ error: 'invalid_redirect_uri' }, 400));
    }

    try {
      const body = new URLSearchParams({
        code,
        client_id: env.GOOGLE_CLIENT_ID,
        client_secret: env.GOOGLE_CLIENT_SECRET,
        redirect_uri,
        grant_type: 'authorization_code',
      });

      const res = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      });

      const text = await res.text();
      return cors(new Response(text, {
        status: res.status,
        headers: { 'Content-Type': 'application/json' },
      }));
    } catch (e) {
      return cors(json({ error: 'proxy_error', detail: e.message }, 500));
    }
  },
};

function cors(response) {
  response.headers.set('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  response.headers.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  response.headers.set('Access-Control-Allow-Headers', 'Content-Type');
  return response;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
